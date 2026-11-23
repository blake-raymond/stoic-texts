import { signingSecret } from "./access";
import { handleAccess, handleChat } from "./chat";
import { grantCheckoutEvent } from "./checkout";
import { OFFER } from "./config";
import { insertEvent, purchaseEvent, sanitizePublicEvent } from "./events";
import { boundFetch, json } from "./http";
import { handleRefundConfirm, handleRefundRequest, refundsReady } from "./refund";
import { handleRestoreConfirm, handleRestoreRequest } from "./restore";
import { readCheckoutCompleted, verifyStripeSignature } from "./stripe";
import { thanksDecision } from "./thanks";
import systemPrompt from "../../prompt/out/system.txt";

const MAX_BODY = 8192;

function stripeSecret(env: Env): string | undefined {
  const value = env.STRIPE_WEBHOOK_SECRET;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return json({ ok: false, error: "too large" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: "too large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const parsed = sanitizePublicEvent(raw, Date.now());
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  try {
    await insertEvent(env.DB, parsed.row);
  } catch (error) {
    console.error(JSON.stringify({
      message: "event insert failed",
      event: parsed.row.name,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ ok: false }, 500);
  }
  console.log(JSON.stringify({
    message: "event",
    event: parsed.row.name,
    variant: parsed.row.variant,
    cta: parsed.row.cta,
    offer: OFFER,
  }));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function handleCounts(env: Env): Promise<Response> {
  const byEvent = await env.DB.prepare(
    "SELECT name, COUNT(*) AS n FROM events GROUP BY name ORDER BY name",
  ).all<{ name: string; n: number }>();
  const byCta = await env.DB.prepare(
    `SELECT name, cta, variant, COUNT(*) AS n
     FROM events
     GROUP BY name, cta, variant
     ORDER BY name, cta, variant`,
  ).all<{ name: string; cta: string | null; variant: string | null; n: number }>();
  return json({
    by_event: (byEvent.results ?? []).map((row) => ({ name: row.name, count: row.n })),
    by_cta_variant: (byCta.results ?? []).map((row) => ({
      name: row.name,
      cta: row.cta,
      variant: row.variant,
      count: row.n,
    })),
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = stripeSecret(env);
  if (!secret) {
    console.log(JSON.stringify({ message: "stripe webhook noop", reason: "STRIPE_WEBHOOK_SECRET unset" }));
    return json({ ok: true, noop: true });
  }
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > 1_000_000) return json({ ok: false }, 413);
  const payload = await request.text();
  const valid = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature"),
    secret,
    Math.floor(Date.now() / 1000),
  );
  if (!valid) return json({ ok: false, error: "bad signature" }, 400);
  const read = readCheckoutCompleted(payload);
  if (!read.ok) {
    if (read.ignore) return json({ ok: true, ignored: true });
    return json({ ok: false, error: read.error ?? "bad event" }, 400);
  }
  const accessSecret = signingSecret(env);
  if (accessSecret) {
    const granted = await grantCheckoutEvent(env.DB, accessSecret, payload, Date.now());
    if (granted === "error") return json({ ok: false }, 500);
  }
  const row = purchaseEvent({
    now: Date.now(),
    sessionId: read.event.sessionId,
    clientReferenceId: read.event.clientReferenceId,
    stripeEventId: read.event.eventId,
  });
  try {
    await insertEvent(env.DB, row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE")) return json({ ok: true, duplicate: true });
    console.error(JSON.stringify({ message: "purchase insert failed", error: message }));
    return json({ ok: false }, 500);
  }
  console.log(JSON.stringify({
    message: "event",
    event: "purchase",
    cta: row.cta,
    variant: row.variant,
    offer: OFFER,
  }));
  return json({ ok: true });
}

async function serveAsset(
  request: Request,
  env: Env,
  options?: { thanksState?: "granted" | "unconfirmed"; cookies?: string[] },
): Promise<Response> {
  let asset: Response;
  try {
    asset = await env.ASSETS.fetch(request);
  } catch (error) {
    console.error(JSON.stringify({
      message: "asset fetch failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return new Response("Not found", { status: 404 });
  }
  const type = asset.headers.get("content-type") || "";
  if (!asset.ok || !type.includes("text/html")) return asset;
  const ready = refundsReady(env) ? "yes" : "no";
  const html = (await asset.text())
    .replaceAll("__REFUND_READY__", ready)
    .replaceAll("__THANKS_STATE__", options?.thanksState ?? "unconfirmed");
  const headers = new Headers(asset.headers);
  headers.delete("content-length");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  for (const cookie of options?.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(html, { status: asset.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/event") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleEvent(request, env);
    }
    if (path === "/api/counts") {
      if (request.method !== "GET") return json({ ok: false }, 405);
      return handleCounts(env);
    }
    if (path === "/api/stripe/webhook") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleWebhook(request, env);
    }
    if (path === "/api/refund/request") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleRefundRequest(request, env);
    }
    if (path === "/api/refund/confirm") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleRefundConfirm(request, env);
    }
    if (path === "/api/chat") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleChat(request, env, { fetchImpl: boundFetch, now: () => Date.now(), systemPrompt });
    }
    if (path === "/api/access") {
      if (request.method !== "GET") return json({ ok: false }, 405);
      return handleAccess(request, env, Date.now());
    }
    if (path === "/api/access/restore") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleRestoreRequest(request, env, Date.now());
    }
    if (path === "/api/access/confirm") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleRestoreConfirm(request, env, Date.now());
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false }, 405);
    if (path === "/thanks") {
      const decision = request.method === "HEAD"
        ? { state: "unconfirmed" as const, cookies: [] as string[] }
        : await thanksDecision(request, env, boundFetch, Date.now());
      return serveAsset(request, env, { thanksState: decision.state, cookies: decision.cookies });
    }
    if (path === "/chat" || path === "/chat/") {
      const url = new URL(request.url);
      url.pathname = "/chat/index.html";
      return serveAsset(new Request(url.toString(), { method: request.method, headers: request.headers }), env);
    }
    return serveAsset(request, env);
  },
} satisfies ExportedHandler<Env>;
