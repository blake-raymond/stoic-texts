import { actorHeaders } from "./chat.ts";
import { grantCheckoutEvent, stripeApiBase } from "./checkout.ts";
import { OFFER } from "./config.ts";
import { insertEvent, purchaseEvent } from "./events.ts";
import {
  FOUNDING_OFFER,
  SUBSCRIPTION_OFFER,
  attachFoundingSession,
  foundingAvailability,
  releaseFounding,
  reserveFounding,
} from "./founding.ts";
import { json, readJson } from "./http.ts";
import { readActor, signingSecret, stripeKey, sweepChat } from "./access.ts";
import { RESTORE_WAIT } from "./chat-copy.ts";
import { readCheckoutCompleted, verifyStripeSignature } from "./stripe.ts";
import { portalConfiguration, portalConfigured, stripePrice, type Plan } from "./stripe-env.ts";

const CHECKOUT_BODY = 4096;
const CHECKOUT_PER_HOUR = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function isPlan(value: unknown): value is Plan {
  return value === "monthly" || value === "yearly" || value === "founding";
}

/** Encode a Stripe form body. The success URL keeps Stripe's session placeholder unencoded. */
export function stripeForm(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => {
    const encoded = encodeURIComponent(value).replace(/%7B/g, "{").replace(/%7D/g, "}");
    return `${encodeURIComponent(key)}=${encoded}`;
  }).join("&");
}

function offerOf(payload: string): string {
  try {
    const event = JSON.parse(payload) as { data?: { object?: { metadata?: { offer?: unknown } } } };
    const offer = event.data?.object?.metadata?.offer;
    if (offer === FOUNDING_OFFER || offer === SUBSCRIPTION_OFFER) return offer;
  } catch {
    // The purchase row still records the default offer.
  }
  return OFFER;
}

async function checkoutLimited(db: D1Database, anonId: string, now: number): Promise<boolean> {
  const windowMs = 60 * 60 * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    `INSERT INTO chat_limits (bucket, window_start, hits) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  ).bind(`checkout:${anonId}`, windowStart).first<{ hits: number }>();
  return (row?.hits ?? 1) > CHECKOUT_PER_HOUR;
}

export async function handleOffer(env: Env, now: number): Promise<Response> {
  const portal = portalConfigured(env);
  const price = stripePrice(env, "founding");
  if (!price) return json({ ok: true, portal, founding: null });
  const availability = await foundingAvailability(env.DB, now);
  if (!availability?.open) return json({ ok: true, portal, founding: null });
  return json({ ok: true, portal, founding: { remaining: availability.remaining } });
}

export async function handleCheckout(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  now: number,
): Promise<Response> {
  const secret = signingSecret(env);
  const key = stripeKey(env);
  if (!secret || !key) return json({ ok: false, code: "unconfigured" }, 503);
  const body = await readJson(request, CHECKOUT_BODY);
  const record = asRecord(body);
  const plan = record?.plan;
  if (!isPlan(plan)) return json({ ok: false, code: "bad_plan" }, 400);
  const price = stripePrice(env, plan);
  if (!price) return json({ ok: false, code: "unconfigured" }, 503);

  await sweepChat(env.DB, now);
  const actor = await readActor(env.DB, request, secret, now);
  const headers = await actorHeaders(request, env, secret, now, actor);
  if (await checkoutLimited(env.DB, actor.anonId, now)) {
    return json({ ok: false, code: "rate_limit", message: RESTORE_WAIT }, 429, headers);
  }

  let reservation: string | null = null;
  if (plan === "founding") {
    reservation = await reserveFounding(env.DB, now);
    if (!reservation) return json({ ok: false, code: "founding_full" }, 409, headers);
  }

  const origin = new URL(request.url).origin;
  const offer = plan === "founding" ? FOUNDING_OFFER : SUBSCRIPTION_OFFER;
  const fields: Array<[string, string]> = [
    ["mode", plan === "founding" ? "payment" : "subscription"],
    ["line_items[0][price]", price],
    ["line_items[0][quantity]", "1"],
    ["success_url", `${origin}/thanks?session_id={CHECKOUT_SESSION_ID}`],
    ["cancel_url", `${origin}/chat`],
    ["client_reference_id", actor.anonId],
    ["metadata[anon_id]", actor.anonId],
    ["metadata[plan]", plan],
    ["metadata[offer]", offer],
  ];
  if (plan === "founding") {
    fields.push(["customer_creation", "always"]);
    fields.push(["payment_intent_data[metadata][offer]", FOUNDING_OFFER]);
    fields.push(["payment_intent_data[metadata][anon_id]", actor.anonId]);
  } else {
    fields.push(["subscription_data[metadata][anon_id]", actor.anonId]);
    fields.push(["subscription_data[metadata][plan]", plan]);
    fields.push(["subscription_data[metadata][offer]", SUBSCRIPTION_OFFER]);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${stripeApiBase(env)}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: stripeForm(fields),
    });
  } catch (error) {
    if (reservation) await releaseFounding(env.DB, reservation);
    console.error(JSON.stringify({
      message: "checkout create failed",
      error: error instanceof Error ? error.message : "fetch failed",
    }));
    return json({ ok: false, code: "upstream" }, 502, headers);
  }
  if (!response.ok) {
    if (reservation) await releaseFounding(env.DB, reservation);
    console.error(JSON.stringify({ message: "checkout rejected", status: response.status, plan }));
    return json({ ok: false, code: "upstream" }, 502, headers);
  }
  let created: unknown;
  try {
    created = await response.json();
  } catch {
    if (reservation) await releaseFounding(env.DB, reservation);
    return json({ ok: false, code: "upstream" }, 502, headers);
  }
  const session = asRecord(created);
  const sessionId = typeof session?.id === "string" ? session.id : "";
  const url = typeof session?.url === "string" ? session.url : "";
  if (!sessionId || !url) {
    if (reservation) await releaseFounding(env.DB, reservation);
    return json({ ok: false, code: "upstream" }, 502, headers);
  }
  if (reservation) await attachFoundingSession(env.DB, reservation, sessionId);
  console.log(JSON.stringify({ message: "checkout", plan }));
  return json({ ok: true, url }, 200, headers);
}

export async function handlePortal(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  now: number,
): Promise<Response> {
  if (!portalConfigured(env)) return json({ ok: false, code: "unconfigured" }, 404);
  const secret = signingSecret(env);
  const key = stripeKey(env);
  if (!secret || !key) return json({ ok: false, code: "unconfigured" }, 503);
  await sweepChat(env.DB, now);
  const actor = await readActor(env.DB, request, secret, now);
  if (!actor.grant) return json({ ok: false, code: "unconfigured" }, 404);
  const row = await env.DB.prepare(
    "SELECT stripe_customer_id FROM access_grants WHERE id = ?1",
  ).bind(actor.grant.id).first<{ stripe_customer_id: string | null }>();
  const customer = row?.stripe_customer_id;
  if (!customer || !/^cus_[A-Za-z0-9_]+$/.test(customer)) return json({ ok: false, code: "unconfigured" }, 404);
  const origin = new URL(request.url).origin;
  const fields: Array<[string, string]> = [
    ["customer", customer],
    ["return_url", `${origin}/chat`],
  ];
  const configuration = portalConfiguration(env);
  if (configuration) fields.push(["configuration", configuration]);
  let response: Response;
  try {
    response = await fetchImpl(`${stripeApiBase(env)}/v1/billing_portal/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: stripeForm(fields),
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "portal create failed",
      error: error instanceof Error ? error.message : "fetch failed",
    }));
    return json({ ok: false, code: "upstream" }, 502);
  }
  if (!response.ok) {
    console.error(JSON.stringify({ message: "portal rejected", status: response.status }));
    return json({ ok: false, code: "upstream" }, 502);
  }
  let created: unknown;
  try {
    created = await response.json();
  } catch {
    return json({ ok: false, code: "upstream" }, 502);
  }
  const url = asRecord(created)?.url;
  if (typeof url !== "string" || !url) return json({ ok: false, code: "upstream" }, 502);
  return json({ ok: true, url });
}

function subscriptionIdOf(object: Record<string, unknown>): string | null {
  const id = typeof object.id === "string" && object.object === "subscription"
    ? object.id
    : idOf(object.subscription);
  if (!id || !/^sub_[A-Za-z0-9_]+$/.test(id)) return null;
  return id;
}

async function setSubscriptionStatus(db: D1Database, subscriptionId: string, status: string): Promise<void> {
  await db.prepare(
    "UPDATE access_grants SET status = ?1 WHERE stripe_subscription_id = ?2",
  ).bind(status, subscriptionId).run();
}

async function applySubscription(db: D1Database, object: Record<string, unknown>, deleted: boolean): Promise<void> {
  const subscriptionId = subscriptionIdOf(object);
  if (!subscriptionId) return;
  const status = deleted ? "canceled" : (typeof object.status === "string" ? object.status : "");
  if (!status || status.length > 32) return;
  await setSubscriptionStatus(db, subscriptionId, status);
}

async function applyInvoice(db: D1Database, object: Record<string, unknown>, failed: boolean): Promise<void> {
  const subscriptionId = subscriptionIdOf(object);
  if (!subscriptionId) return;
  await setSubscriptionStatus(db, subscriptionId, failed ? "past_due" : "active");
}

function paymentIntentId(object: Record<string, unknown>): string | null {
  const id = idOf(object.payment_intent);
  if (!id || !/^pi_[A-Za-z0-9_]+$/.test(id)) return null;
  return id;
}

async function refundOverCap(env: Env, object: Record<string, unknown>, fetchImpl: typeof fetch): Promise<boolean> {
  const key = stripeKey(env);
  const paymentIntent = paymentIntentId(object);
  if (!key || !paymentIntent) return false;
  const response = await fetchImpl(`${stripeApiBase(env)}/v1/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `founding-cap-${paymentIntent}`,
    },
    body: stripeForm([
      ["payment_intent", paymentIntent],
      ["reason", "requested_by_customer"],
    ]),
  });
  if (!response.ok) {
    console.error(JSON.stringify({ message: "founding cap refund failed", status: response.status }));
    return false;
  }
  console.log(JSON.stringify({ message: "founding cap refunded" }));
  return true;
}

export async function applyBillingEvent(
  env: Env,
  payload: string,
  now: number,
  fetchImpl: typeof fetch,
): Promise<"ok" | "error"> {
  const secret = signingSecret(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "ok";
  }
  const event = asRecord(parsed);
  const data = asRecord(event?.data);
  const object = asRecord(data?.object);
  const type = typeof event?.type === "string" ? event.type : "";
  if (!object) return "ok";

  if (type === "checkout.session.completed") {
    if (!secret) return "ok";
    const granted = await grantCheckoutEvent(env.DB, secret, payload, now);
    if (granted === "error") return "error";
    if (granted === "full") {
      try {
        const refunded = await refundOverCap(env, object, fetchImpl);
        return refunded ? "ok" : "error";
      } catch (error) {
        console.error(JSON.stringify({
          message: "founding cap refund failed",
          error: error instanceof Error ? error.message : "refund failed",
        }));
        return "error";
      }
    }
    return "ok";
  }
  if (
    type === "customer.subscription.created"
    || type === "customer.subscription.updated"
    || type === "customer.subscription.deleted"
  ) {
    await applySubscription(env.DB, object, type === "customer.subscription.deleted");
    return "ok";
  }
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    await applyInvoice(env.DB, object, type === "invoice.payment_failed");
    return "ok";
  }
  return "ok";
}

function stripeWebhookSecret(env: Env): string | undefined {
  const value = env.STRIPE_WEBHOOK_SECRET;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export async function handleStripeWebhook(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const secret = stripeWebhookSecret(env);
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
  const applied = await applyBillingEvent(env, payload, Date.now(), fetchImpl);
  if (applied === "error") return json({ ok: false }, 500);
  const read = readCheckoutCompleted(payload);
  if (!read.ok) {
    if (read.ignore) return json({ ok: true, ignored: true });
    return json({ ok: false, error: read.error ?? "bad event" }, 400);
  }
  const row = purchaseEvent({
    now: Date.now(),
    sessionId: read.event.sessionId,
    clientReferenceId: read.event.clientReferenceId,
    stripeEventId: read.event.eventId,
    offer: offerOf(payload),
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
    offer: row.offer,
  }));
  return json({ ok: true });
}
