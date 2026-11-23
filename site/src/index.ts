import { handleAccess, handleChat } from "./chat";
import { handleCheckout, handleOffer, handlePortal, handleStripeWebhook } from "./billing";
import { OFFER } from "./config";
import { insertEvent, sanitizePublicEvent } from "./events";
import { boundFetch, json } from "./http";
import { handleRefundConfirm, handleRefundRequest, refundsReady } from "./refund";
import { handleRestoreConfirm, handleRestoreRequest } from "./restore";
import { thanksDecision } from "./thanks";
import systemPrompt from "../../prompt/out/system.txt";

const MAX_BODY = 8192;

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

async function serveAsset(
  request: Request,
  env: Env,
  options?: { thanksState?: "granted" | "unconfirmed"; thanksKind?: string; cookies?: string[] },
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
    .replaceAll("__THANKS_STATE__", options?.thanksState ?? "unconfirmed")
    .replaceAll("__THANKS_KIND__", options?.thanksKind ?? "");
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
      return handleStripeWebhook(request, env, boundFetch);
    }
    if (path === "/api/offer") {
      if (request.method !== "GET") return json({ ok: false }, 405);
      return handleOffer(env, Date.now());
    }
    if (path === "/api/checkout") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handleCheckout(request, env, boundFetch, Date.now());
    }
    if (path === "/api/billing/portal") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return handlePortal(request, env, boundFetch, Date.now());
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
        ? { state: "unconfirmed" as const, kind: "", cookies: [] as string[] }
        : await thanksDecision(request, env, boundFetch, Date.now());
      return serveAsset(request, env, {
        thanksState: decision.state,
        thanksKind: decision.kind,
        cookies: decision.cookies,
      });
    }
    if (path === "/chat" || path === "/chat/") {
      const url = new URL(request.url);
      url.pathname = "/chat/index.html";
      return serveAsset(new Request(url.toString(), { method: request.method, headers: request.headers }), env);
    }
    return serveAsset(request, env);
  },
} satisfies ExportedHandler<Env>;
