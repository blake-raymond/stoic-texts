import { emailSendingReady, hashEmail, hashIp, signingSecret, sweepChat, clientIp } from "./access.ts";
import { accessCookie, requestIsSecure } from "./cookies.ts";
import {
  RESTORE_BAD_CODE,
  RESTORE_DONE,
  RESTORE_HELP,
  RESTORE_NEUTRAL,
  RESTORE_SUBJECT,
  RESTORE_WAIT,
  restoreCodeText,
} from "./chat-copy.ts";
import { json, readJson } from "./http.ts";
import { FROM_EMAIL, FROM_NAME } from "./refund-copy.ts";
import { normalizeEmail } from "./refund-stripe.ts";

const CODE_TTL_MS = 15 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_EMAIL_MAX = 5;
const REQUEST_IP_MAX = 20;
const CONFIRM_EMAIL_MAX = 8;
const CONFIRM_IP_MAX = 30;

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function hitLimit(db: D1Database, bucket: string, windowMs: number, max: number, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    `INSERT INTO chat_limits (bucket, window_start, hits) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  ).bind(bucket, windowStart).first<{ hits: number }>();
  return (row?.hits ?? 1) > max;
}

export async function handleRestoreRequest(request: Request, env: Env, now: number): Promise<Response> {
  const secret = signingSecret(env);
  if (!secret || !emailSendingReady(env)) return json({ ok: true, method: "help", message: RESTORE_HELP });
  const body = await readJson(request, 2048);
  const raw = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { email?: unknown }).email
    : "";
  const email = normalizeEmail(typeof raw === "string" ? raw : "");
  if (!email) return json({ ok: false, message: "Enter the email from your purchase." }, 400);

  const hashedEmail = await hashEmail(secret, email);
  const hashedIp = await hashIp(secret, clientIp(request));
  await sweepChat(env.DB, now);
  const limited = await hitLimit(env.DB, `restore-email:${hashedEmail}`, REQUEST_WINDOW_MS, REQUEST_EMAIL_MAX, now)
    || await hitLimit(env.DB, `restore-ip:${hashedIp}`, REQUEST_WINDOW_MS, REQUEST_IP_MAX, now);
  if (limited) return json({ ok: false, message: RESTORE_WAIT }, 429);

  const grant = await env.DB.prepare(
    "SELECT id FROM access_grants WHERE email_hash = ?1 LIMIT 1",
  ).bind(hashedEmail).first<{ id: string }>();
  if (!grant) return json({ ok: true, method: "email", message: RESTORE_NEUTRAL });

  const code = generateCode();
  const codeHash = await sha256Hex(`oc-access-code\n${secret}\n${hashedEmail}\n${code}`);
  await env.DB.prepare(
    `INSERT INTO access_codes (email_hash, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_at = excluded.created_at`,
  ).bind(hashedEmail, codeHash, now + CODE_TTL_MS, now).run();
  try {
    await env.EMAIL.send({
      from: { email: FROM_EMAIL, name: FROM_NAME },
      to: email,
      subject: RESTORE_SUBJECT,
      text: restoreCodeText(code),
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM access_codes WHERE email_hash = ?1").bind(hashedEmail).run();
    console.error(JSON.stringify({
      message: "access code email failed",
      error: error instanceof Error ? error.message : "send failed",
    }));
  }
  return json({ ok: true, method: "email", message: RESTORE_NEUTRAL });
}

export async function handleRestoreConfirm(request: Request, env: Env, now: number): Promise<Response> {
  const secret = signingSecret(env);
  if (!secret || !emailSendingReady(env)) return json({ ok: false, method: "help", message: RESTORE_HELP });
  const body = await readJson(request, 2048);
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as { email?: unknown; code?: unknown } : {};
  const email = normalizeEmail(typeof record.email === "string" ? record.email : "");
  const code = typeof record.code === "string" ? record.code.replace(/\D/g, "") : "";
  if (!email || code.length !== 6) return json({ ok: false, message: RESTORE_BAD_CODE }, 400);

  const hashedEmail = await hashEmail(secret, email);
  const hashedIp = await hashIp(secret, clientIp(request));
  await sweepChat(env.DB, now);
  const limited = await hitLimit(env.DB, `restore-ok-email:${hashedEmail}`, CONFIRM_WINDOW_MS, CONFIRM_EMAIL_MAX, now)
    || await hitLimit(env.DB, `restore-ok-ip:${hashedIp}`, CONFIRM_WINDOW_MS, CONFIRM_IP_MAX, now);
  if (limited) return json({ ok: false, message: RESTORE_WAIT }, 429);

  const row = await env.DB.prepare(
    "SELECT code_hash FROM access_codes WHERE email_hash = ?1 AND expires_at > ?2",
  ).bind(hashedEmail, now).first<{ code_hash: string }>();
  const submitted = await sha256Hex(`oc-access-code\n${secret}\n${hashedEmail}\n${code}`);
  const stored = row?.code_hash ?? await sha256Hex(`oc-access-code\n${secret}\n${hashedEmail}\nno-code`);
  if (!row || !timingSafeEqual(submitted, stored)) return json({ ok: false, message: RESTORE_BAD_CODE });

  const grant = await env.DB.prepare(
    "SELECT id FROM access_grants WHERE email_hash = ?1 ORDER BY created_at DESC LIMIT 1",
  ).bind(hashedEmail).first<{ id: string }>();
  await env.DB.prepare("DELETE FROM access_codes WHERE email_hash = ?1").bind(hashedEmail).run();
  if (!grant) return json({ ok: false, method: "help", message: RESTORE_HELP });

  const headers = new Headers();
  headers.append("set-cookie", await accessCookie(grant.id, secret, now, requestIsSecure(request)));
  return json({ ok: true, done: true, message: RESTORE_DONE }, 200, headers);
}
