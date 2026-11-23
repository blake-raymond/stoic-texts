import {
  CHAT_RATE_ANON_PER_HOUR,
  CHAT_RATE_IP_PER_HOUR,
  CHAT_RATE_WINDOW_MS,
  COLD_REPLY_RESERVE_MICRO_USD,
  FREE_CONVERSATION_REPLIES,
  MONTHLY_REPLY_CAP,
  dailySpendLimitMicro,
  rateLimit,
} from "./config.ts";
import { accessIdFrom, anonIdFrom, newId } from "./cookies.ts";
import { FREE_LIMIT_MESSAGE, INACTIVE_MESSAGE, MONTHLY_CAP_MESSAGE } from "./chat-copy.ts";
import { sweepFoundingReservations } from "./founding.ts";
import { portalConfigured } from "./stripe-env.ts";

export interface Grant {
  id: string;
  emailHash: string;
  kind: string;
  active: boolean;
}

export function grantIsActive(kind: string, status: string): boolean {
  if (kind === "founding") return status === "active";
  return status === "active" || status === "trialing";
}

export interface Actor {
  anonId: string;
  anonIsNew: boolean;
  grant: Grant | null;
  clearAccess: boolean;
}

export type TakeResult =
  | { ok: true; subject: string; period: string }
  | { ok: false; code: "free_limit" | "monthly_cap" | "inactive" };

export function signingSecret(env: Env): string | undefined {
  const value = env.ACCESS_SIGNING_SECRET;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 16) return undefined;
  return trimmed;
}

export function openRouterKey(env: Env): string | undefined {
  const value = env.OPENROUTER_API_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function stripeKey(env: Env): string | undefined {
  const value = env.STRIPE_REFUND_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashEmail(secret: string, email: string): Promise<string> {
  return sha256Hex(`oc-access-email\n${secret}\n${email}`);
}

export async function hashIp(secret: string, ip: string): Promise<string> {
  return sha256Hex(`oc-chat-ip\n${secret}\n${ip}`);
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function emailSendingReady(env: Env): boolean {
  const email = env.EMAIL as { send?: unknown } | undefined;
  return typeof email?.send === "function";
}

export async function readActor(db: D1Database, request: Request, secret: string, now: number): Promise<Actor> {
  const existing = await anonIdFrom(request, secret, now);
  const anonId = existing ?? newId();
  const accessId = await accessIdFrom(request, secret, now);
  if (!accessId) return { anonId, anonIsNew: !existing, grant: null, clearAccess: false };
  const grant = await db.prepare(
    "SELECT id, email_hash, kind, status FROM access_grants WHERE id = ?1",
  ).bind(accessId).first<{ id: string; email_hash: string; kind: string; status: string }>();
  if (!grant) return { anonId, anonIsNew: !existing, grant: null, clearAccess: true };
  return {
    anonId,
    anonIsNew: !existing,
    grant: {
      id: grant.id,
      emailHash: grant.email_hash,
      kind: grant.kind,
      active: grantIsActive(grant.kind, grant.status),
    },
    clearAccess: false,
  };
}

async function increment(
  db: D1Database,
  subject: string,
  period: string,
  limit: number,
): Promise<number | null> {
  const row = await db.prepare(
    `INSERT INTO usage_counters (subject, period, replies) VALUES (?1, ?2, 1)
     ON CONFLICT(subject, period) DO UPDATE SET replies = replies + 1
     WHERE replies < ?3
     RETURNING replies`,
  ).bind(subject, period, limit).first<{ replies: number }>();
  return row?.replies ?? null;
}

export async function takeReply(db: D1Database, actor: Actor, now: number): Promise<TakeResult> {
  if (actor.grant) {
    if (!actor.grant.active) return { ok: false, code: "inactive" };
    const period = `month:${utcMonth(now)}`;
    const subject = `paid:${actor.grant.emailHash}`;
    const replies = await increment(db, subject, period, MONTHLY_REPLY_CAP);
    if (replies === null) return { ok: false, code: "monthly_cap" };
    return { ok: true, subject, period };
  }
  const subject = `anon:${actor.anonId}`;
  const replies = await increment(db, subject, "free", FREE_CONVERSATION_REPLIES);
  if (replies === null) return { ok: false, code: "free_limit" };
  return { ok: true, subject, period: "free" };
}

export async function releaseReply(db: D1Database, subject: string, period: string): Promise<void> {
  await db.prepare(
    "UPDATE usage_counters SET replies = replies - 1 WHERE subject = ?1 AND period = ?2 AND replies > 0",
  ).bind(subject, period).run();
}

export async function reserveSpend(db: D1Database, now: number, limitMicro: number): Promise<boolean> {
  const reserve = COLD_REPLY_RESERVE_MICRO_USD;
  if (reserve > limitMicro) return false;
  const day = utcDay(now);
  const row = await db.prepare(
    `INSERT INTO spend_daily (day, micro_usd) VALUES (?1, ?2)
     ON CONFLICT(day) DO UPDATE SET micro_usd = micro_usd + ?2
     WHERE micro_usd + ?2 <= ?3
     RETURNING micro_usd`,
  ).bind(day, reserve, limitMicro).first<{ micro_usd: number }>();
  return Boolean(row);
}

export async function adjustSpend(db: D1Database, now: number, deltaMicro: number): Promise<void> {
  await db.prepare(
    "UPDATE spend_daily SET micro_usd = MAX(0, micro_usd + ?1) WHERE day = ?2",
  ).bind(deltaMicro, utcDay(now)).run();
}

export function spendLimit(env: Env): number {
  return dailySpendLimitMicro(env.DAILY_SPEND_LIMIT_USD);
}

async function hitLimit(db: D1Database, bucket: string, max: number, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / CHAT_RATE_WINDOW_MS) * CHAT_RATE_WINDOW_MS;
  const row = await db.prepare(
    `INSERT INTO chat_limits (bucket, window_start, hits) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  ).bind(bucket, windowStart).first<{ hits: number }>();
  return (row?.hits ?? 1) > max;
}

export async function chatRateLimited(
  db: D1Database,
  env: Env,
  anonId: string,
  ipHash: string,
  now: number,
): Promise<boolean> {
  const anonMax = rateLimit(env.CHAT_RATE_ANON_PER_HOUR, CHAT_RATE_ANON_PER_HOUR);
  const ipMax = rateLimit(env.CHAT_RATE_IP_PER_HOUR, CHAT_RATE_IP_PER_HOUR);
  const anonHit = await hitLimit(db, `anon:${anonId}`, anonMax, now);
  const ipHit = await hitLimit(db, `ip:${ipHash}`, ipMax, now);
  return anonHit || ipHit;
}

export async function sweepChat(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM chat_limits WHERE window_start < ?1")
    .bind(now - 2 * 24 * 60 * 60 * 1000)
    .run();
  await db.prepare("DELETE FROM access_codes WHERE expires_at < ?1").bind(now).run();
  await sweepFoundingReservations(db, now);
}

async function repliesUsed(db: D1Database, subject: string, period: string): Promise<number> {
  const row = await db.prepare(
    "SELECT replies FROM usage_counters WHERE subject = ?1 AND period = ?2",
  ).bind(subject, period).first<{ replies: number }>();
  return row?.replies ?? 0;
}

export async function accessView(db: D1Database, actor: Actor, env: Env, now: number): Promise<{
  ok: true;
  tier: "free" | "paid";
  replies_used: number;
  replies_limit: number;
  code: "free_limit" | "monthly_cap" | "inactive" | null;
  message: string | null;
  restore: "email" | "help";
  portal: boolean;
}> {
  const restore = emailSendingReady(env) && signingSecret(env) ? "email" : "help";
  const portal = portalConfigured(env);
  if (actor.grant && !actor.grant.active) {
    return {
      ok: true,
      tier: "paid",
      replies_used: 0,
      replies_limit: MONTHLY_REPLY_CAP,
      code: "inactive",
      message: INACTIVE_MESSAGE,
      restore,
      portal,
    };
  }
  const paid = Boolean(actor.grant);
  const subject = paid ? `paid:${actor.grant!.emailHash}` : `anon:${actor.anonId}`;
  const period = paid ? `month:${utcMonth(now)}` : "free";
  const limit = paid ? MONTHLY_REPLY_CAP : FREE_CONVERSATION_REPLIES;
  const used = await repliesUsed(db, subject, period);
  const blocked = used >= limit;
  const code = blocked ? (paid ? "monthly_cap" : "free_limit") : null;
  return {
    ok: true,
    tier: paid ? "paid" : "free",
    replies_used: used,
    replies_limit: limit,
    code,
    message: code === "free_limit" ? FREE_LIMIT_MESSAGE : code === "monthly_cap" ? MONTHLY_CAP_MESSAGE : null,
    restore,
    portal,
  };
}
