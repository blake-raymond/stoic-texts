import { insertEvent, serverEvent } from "./events";
import { boundFetch } from "./http";
import {
  ALREADY,
  BAD_CODE,
  CODE_SUBJECT,
  DONE,
  ENTER_EMAIL,
  FAILED,
  FALLBACK,
  FROM_EMAIL,
  FROM_NAME,
  NEUTRAL,
  NONE,
  WAIT,
  codeEmailText,
} from "./refund-copy";
import { findOldCounselCharges, normalizeEmail, refundCharges, stripeTransport } from "./refund-stripe";

function foundingPriceId(env: Env): string | undefined {
  const raw = env.STRIPE_PRICE_FOUNDING;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^price_[A-Za-z0-9]+$/.test(trimmed) ? trimmed : undefined;
}

const MAX_BODY = 2048;
const CODE_TTL_MS = 15 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_EMAIL_MAX = 5;
const REQUEST_IP_MAX = 20;
const CONFIRM_EMAIL_MAX = 8;
const CONFIRM_IP_MAX = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function refundKey(env: Env): string | undefined {
  const value = env.STRIPE_REFUND_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function refundsReady(env: Env): boolean {
  const email = env.EMAIL as { send?: unknown } | undefined;
  return Boolean(refundKey(env)) && typeof email?.send === "function";
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function emailHash(pepper: string, email: string): Promise<string> {
  return sha256Hex(`oc-refund-email\n${pepper}\n${email}`);
}

async function codeHash(pepper: string, hashedEmail: string, code: string): Promise<string> {
  return sha256Hex(`oc-refund-code\n${pepper}\n${hashedEmail}\n${code}`);
}

async function ipHash(pepper: string, ip: string): Promise<string> {
  return sha256Hex(`oc-refund-ip\n${pepper}\n${ip}`);
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function generateCode(): string {
  const bytes = new Uint32Array(1);
  const limit = 4_294_000_000;
  let value = limit;
  while (value >= limit) {
    crypto.getRandomValues(bytes);
    value = bytes[0] ?? limit;
  }
  return String(value % 1_000_000).padStart(6, "0");
}

async function hitLimit(
  db: D1Database,
  bucket: string,
  windowMs: number,
  max: number,
  now: number,
): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    `INSERT INTO refund_limits (bucket, window_start, hits) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  ).bind(bucket, windowStart).first<{ hits: number }>();
  return (row?.hits ?? 1) > max;
}

async function sweep(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM refund_codes WHERE expires_at < ?1").bind(now).run();
  await db.prepare("DELETE FROM refund_limits WHERE window_start < ?1")
    .bind(now - 2 * 24 * 60 * 60 * 1000)
    .run();
}

async function logRefund(env: Env, name: string, props: Record<string, unknown>): Promise<void> {
  try {
    await insertEvent(env.DB, serverEvent(name, props, Date.now()));
    console.log(JSON.stringify({ event: name, ...props }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "refund event failed",
      event: name,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handleRefundRequest(request: Request, env: Env): Promise<Response> {
  try {
    return await requestRefund(request, env);
  } catch (error) {
    console.error(JSON.stringify({
      message: "refund request failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ ok: true, message: NEUTRAL });
  }
}

async function requestRefund(request: Request, env: Env): Promise<Response> {
  const key = refundKey(env);
  if (!key || !refundsReady(env)) return json({ ok: false, message: FALLBACK }, 503);
  const body = await readBody(request);
  const rawEmail = body && typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  if (!email) return json({ ok: false, message: ENTER_EMAIL }, 400);

  const now = Date.now();
  const hashedEmail = await emailHash(key, email);
  const hashedIp = await ipHash(key, clientIp(request));
  await sweep(env.DB, now);
  const emailLimited = await hitLimit(env.DB, `req-email:${hashedEmail}`, REQUEST_WINDOW_MS, REQUEST_EMAIL_MAX, now);
  const ipLimited = await hitLimit(env.DB, `req-ip:${hashedIp}`, REQUEST_WINDOW_MS, REQUEST_IP_MAX, now);
  if (emailLimited || ipLimited) return json({ ok: false, message: WAIT }, 429);

  let result: "match" | "none" | "error" = "none";
  try {
    const findings = await findOldCounselCharges(rawEmail, stripeTransport(boundFetch, key), foundingPriceId(env));
    if (findings.length > 0) {
      result = "match";
      const code = generateCode();
      const hashedCode = await codeHash(key, hashedEmail, code);
      await env.DB.prepare("DELETE FROM refund_codes WHERE email_hash = ?1").bind(hashedEmail).run();
      await env.DB.prepare(
        "INSERT INTO refund_codes (email_hash, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(hashedEmail, hashedCode, now + CODE_TTL_MS, now).run();
      try {
        const sent = await env.EMAIL.send({
          from: { email: FROM_EMAIL, name: FROM_NAME },
          to: email,
          subject: CODE_SUBJECT,
          text: codeEmailText(code),
        });
        await logRefund(env, "refund_code_sent", { message_id: sent.messageId ?? "" });
      } catch (error) {
        await env.DB.prepare("DELETE FROM refund_codes WHERE email_hash = ?1").bind(hashedEmail).run();
        console.error(JSON.stringify({
          message: "refund code email failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        result = "error";
      }
    }
  } catch (error) {
    result = "error";
    console.error(JSON.stringify({
      message: "refund lookup failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  await logRefund(env, "refund_request", { result });
  return json({ ok: true, message: NEUTRAL });
}

export async function handleRefundConfirm(request: Request, env: Env): Promise<Response> {
  try {
    return await confirmRefund(request, env);
  } catch (error) {
    console.error(JSON.stringify({
      message: "refund confirm failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ ok: false, message: FAILED }, 502);
  }
}

async function confirmRefund(request: Request, env: Env): Promise<Response> {
  const key = refundKey(env);
  if (!key || !refundsReady(env)) return json({ ok: false, message: FALLBACK }, 503);
  const body = await readBody(request);
  const rawEmail = body && typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  const rawCode = body && typeof body.code === "string" ? body.code : "";
  const code = rawCode.replace(/\D/g, "");
  if (!email || code.length !== 6) return json({ ok: false, message: BAD_CODE }, 400);

  const now = Date.now();
  const hashedEmail = await emailHash(key, email);
  const hashedIp = await ipHash(key, clientIp(request));
  await sweep(env.DB, now);
  const emailLimited = await hitLimit(env.DB, `ok-email:${hashedEmail}`, CONFIRM_WINDOW_MS, CONFIRM_EMAIL_MAX, now);
  const ipLimited = await hitLimit(env.DB, `ok-ip:${hashedIp}`, CONFIRM_WINDOW_MS, CONFIRM_IP_MAX, now);
  if (emailLimited || ipLimited) return json({ ok: false, message: WAIT }, 429);

  const row = await env.DB.prepare(
    `SELECT code_hash FROM refund_codes
     WHERE email_hash = ?1 AND expires_at > ?2
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(hashedEmail, now).first<{ code_hash: string }>();
  const submitted = await codeHash(key, hashedEmail, code);
  const stored = row?.code_hash ?? await codeHash(key, hashedEmail, "no-code");
  const matches = timingSafeEqual(submitted, stored) && Boolean(row);
  if (!matches) return json({ ok: false, message: BAD_CODE });

  const findings = await findOldCounselCharges(rawEmail, stripeTransport(boundFetch, key), foundingPriceId(env));
  const toRefund = findings.filter((finding) => finding.state === "refund").map((finding) => finding.id);
  const already = findings.filter((finding) => finding.state === "already").map((finding) => finding.id);
  if (toRefund.length === 0 && already.length === 0) {
    await env.DB.prepare("DELETE FROM refund_codes WHERE email_hash = ?1").bind(hashedEmail).run();
    return json({ ok: false, done: true, message: NONE });
  }

  const settled = await refundCharges(toRefund, stripeTransport(boundFetch, key));
  const alreadyIds = [...already, ...settled.already];
  await env.DB.prepare("DELETE FROM refund_codes WHERE email_hash = ?1").bind(hashedEmail).run();
  await logRefund(env, "refund_done", {
    refunded: settled.refunded.length,
    already_refunded: alreadyIds.length,
    payment_intents: settled.refunded,
  });
  if (settled.refunded.length > 0) return json({ ok: true, done: true, message: DONE });
  return json({ ok: true, done: true, message: ALREADY });
}
