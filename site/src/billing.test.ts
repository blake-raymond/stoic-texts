import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyBillingEvent, handleCheckout, handleOffer, handlePortal, handleStripeWebhook, stripeForm } from "./billing.ts";
import { handleChat, type HandlerDeps } from "./chat.ts";
import { grantCheckoutEvent } from "./checkout.ts";
import { accessCookie } from "./cookies.ts";
import { openTestDb } from "./testing/d1.ts";

const SECRET = "test-access-secret-value";
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const PROMPT = "SYSTEM-PROMPT-BYTES\n";

function env(db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    ACCESS_SIGNING_SECRET: SECRET,
    STRIPE_REFUND_KEY: "rk_test_mock",
    STRIPE_API_BASE: "http://stripe.test",
    STRIPE_PRICE_MONTHLY: "price_monthlyEnv",
    STRIPE_PRICE_YEARLY: "price_yearlyEnv",
    STRIPE_PRICE_FOUNDING: "price_foundingEnv",
    OPENROUTER_API_KEY: "sk-or-test-key",
    OPENROUTER_API_BASE: "http://openrouter.test/v1/chat/completions",
    ...extra,
  } as Env;
}

function cookieJar(response: Response, current = ""): string {
  const next = new Map<string, string>();
  for (const part of current.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) next.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const row of response.headers.getSetCookie()) {
    const pair = row.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) next.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...next.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function sign(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

test("checkout sessions are created server-side from env price ids", async () => {
  const source = readFileSync(new URL("./billing.ts", import.meta.url), "utf8");
  assert.equal(source.includes("price_1"), false);
  assert.equal(source.includes("buy.stripe.com"), false);
  assert.equal(source.includes("4900"), false);
  const { db } = openTestDb();
  let body = "";
  let url = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    url = String(input);
    body = String(init?.body ?? "");
    assert.equal(url.includes("api.stripe.com"), false);
    assert.equal(body.includes("rk_test_mock"), false);
    return Response.json({ id: "cs_test_new", url: "http://stripe.test/c/cs_test_new" });
  };
  const response = await handleCheckout(new Request("http://127.0.0.1/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "yearly" }),
  }), env(db), fetchImpl, NOW);
  assert.equal(response.status, 200);
  const params = new URLSearchParams(body);
  assert.equal(params.get("mode"), "subscription");
  assert.equal(params.get("line_items[0][price]"), "price_yearlyEnv");
  assert.equal(params.get("metadata[offer]"), "subscription");
  assert.equal(params.get("metadata[plan]"), "yearly");
  assert.match(params.get("client_reference_id") ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(params.get("client_reference_id"), params.get("metadata[anon_id]"));
  assert.match(body, /session_id%3D\{CHECKOUT_SESSION_ID\}/);
  assert.equal(url, "http://stripe.test/v1/checkout/sessions");

  const monthly = await handleCheckout(new Request("http://127.0.0.1/api/checkout", {
    method: "POST",
    headers: { cookie: cookieJar(response), "content-type": "application/json" },
    body: JSON.stringify({ plan: "monthly" }),
  }), env(db), fetchImpl, NOW);
  assert.equal(monthly.status, 200);
  assert.equal(new URLSearchParams(body).get("line_items[0][price]"), "price_monthlyEnv");
  assert.equal(new URLSearchParams(body).get("mode"), "subscription");
});

test("founding checkout is a payment and stops at 100 buyers", async () => {
  const { db } = openTestDb();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ id: "cs_test_founding", url: "http://stripe.test/c/cs_test_founding" });
  };
  const first = await handleCheckout(new Request("http://127.0.0.1/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "founding" }),
  }), env(db), fetchImpl, NOW);
  assert.equal(first.status, 200);
  assert.equal(calls, 1);
  const held = await db.prepare("SELECT status FROM founding_sales").first<{ status: string }>();
  assert.equal(held?.status, "reserved");

  for (let index = 0; index < 100; index += 1) {
    await db.prepare(
      "INSERT INTO founding_sales (id, stripe_session_id, status, created_at) VALUES (?1, ?2, 'paid', ?3)",
    ).bind(`sale-${index}`, `cs_paid_${index}`, NOW).run();
  }
  const closed = await handleCheckout(new Request("http://127.0.0.1/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "founding" }),
  }), env(db), fetchImpl, NOW);
  assert.equal(closed.status, 409);
  assert.equal(calls, 1);
  const offer = await handleOffer(env(db), NOW);
  const body = await offer.json() as { founding: unknown };
  assert.equal(body.founding, null);
});

test("spots left come from paid founding rows", async () => {
  const { db } = openTestDb();
  const open = await handleOffer(env(db), NOW);
  const first = await open.json() as { founding: { remaining: number } | null; portal: boolean };
  assert.equal(first.portal, false);
  assert.equal(first.founding?.remaining, 100);
  await db.prepare(
    "INSERT INTO founding_sales (id, stripe_session_id, status, created_at) VALUES ('sale', 'cs_one', 'paid', ?1)",
  ).bind(NOW).run();
  const later = await handleOffer(env(db), NOW);
  const second = await later.json() as { founding: { remaining: number } | null };
  assert.equal(second.founding?.remaining, 99);
  const hidden = await handleOffer(env(db, { STRIPE_PRICE_FOUNDING: "" }), NOW);
  const third = await hidden.json() as { founding: unknown };
  assert.equal(third.founding, null);
});

test("subscription webhooks gate access and a bad signature is refused", async () => {
  const { db } = openTestDb();
  const payload = JSON.stringify({
    id: "evt_sub",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_sub",
        object: "checkout.session",
        mode: "subscription",
        payment_status: "paid",
        status: "complete",
        currency: "usd",
        amount_subtotal: 18000,
        amount_total: 18000,
        customer: "cus_test_sub",
        customer_details: { email: "sub@example.com" },
        metadata: { offer: "subscription", plan: "yearly" },
        subscription: "sub_test_yearly",
      },
    },
  });
  assert.equal(await grantCheckoutEvent(db, SECRET, payload, NOW), "granted");
  const grant = await db.prepare(
    "SELECT id, status FROM access_grants WHERE stripe_subscription_id = 'sub_test_yearly'",
  ).first<{ id: string; status: string }>();
  assert.equal(grant?.status, "active");
  assert.ok(grant);
  const cookie = await accessCookie(grant.id, SECRET, NOW, false);
  const fetchImpl: typeof fetch = async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Go on." } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200 },
  );
  const deps: HandlerDeps = { fetchImpl, now: () => NOW, systemPrompt: PROMPT };
  const chatting = await handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "What now?" }] }),
  }), env(db), deps);
  assert.equal(chatting.status, 200);

  const failed = JSON.stringify({
    id: "evt_fail",
    type: "invoice.payment_failed",
    data: { object: { id: "in_fail", object: "invoice", subscription: "sub_test_yearly" } },
  });
  assert.equal(await applyBillingEvent(env(db), failed, NOW, fetchImpl), "ok");
  const blocked = await handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Still here?" }] }),
  }), env(db), deps);
  assert.equal(blocked.status, 402);
  const blockedBody = await blocked.json() as { code: string };
  assert.equal(blockedBody.code, "inactive");
  const free = await db.prepare(
    "SELECT replies FROM usage_counters WHERE period = 'free'",
  ).first<{ replies: number }>();
  assert.equal(free, null);

  const paid = JSON.stringify({
    id: "evt_paid",
    type: "invoice.paid",
    data: { object: { id: "in_paid", object: "invoice", subscription: "sub_test_yearly" } },
  });
  assert.equal(await applyBillingEvent(env(db), paid, NOW, fetchImpl), "ok");
  const again = await handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "And now?" }] }),
  }), env(db), deps);
  assert.equal(again.status, 200);

  const deleted = JSON.stringify({
    id: "evt_deleted",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_test_yearly", object: "subscription", status: "canceled" } },
  });
  const secret = "whsec_test";
  const signed = await handleStripeWebhook(new Request("http://127.0.0.1/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": await sign(deleted, secret, Math.floor(Date.now() / 1000)) },
    body: deleted,
  }), env(db, { STRIPE_WEBHOOK_SECRET: secret }), fetchImpl);
  assert.equal(signed.status, 200);
  const unsigned = await handleStripeWebhook(new Request("http://127.0.0.1/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=deadbeef" },
    body: deleted,
  }), env(db, { STRIPE_WEBHOOK_SECRET: secret }), fetchImpl);
  assert.equal(unsigned.status, 400);
  const after = await handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Gone?" }] }),
  }), env(db), deps);
  assert.equal(after.status, 402);
});

test("the portal link exists only when it is configured", async () => {
  const { db } = openTestDb();
  const missing = await handlePortal(new Request("http://127.0.0.1/api/billing/portal", { method: "POST" }), env(db), fetch, NOW);
  assert.equal(missing.status, 404);
  const offer = await handleOffer(env(db, { STRIPE_PORTAL_ENABLED: "1" }), NOW);
  const shown = await offer.json() as { portal: boolean };
  assert.equal(shown.portal, true);
  await db.prepare(
    `INSERT INTO access_grants (
       id, stripe_session_id, stripe_customer_id, email_hash, created_at, kind, status, stripe_subscription_id
     ) VALUES ('grant-portal-0001', 'cs_portal', 'cus_portal', 'hash', ?1, 'subscription', 'active', 'sub_portal')`,
  ).bind(NOW).run();
  const cookie = await accessCookie("grant-portal-0001", SECRET, NOW, false);
  let portalBody = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    portalBody = String(init?.body ?? "");
    return Response.json({ url: "http://stripe.test/portal/session" });
  };
  const ready = await handlePortal(new Request("http://127.0.0.1/api/billing/portal", {
    method: "POST",
    headers: { cookie },
  }), env(db, { STRIPE_PORTAL_ENABLED: "1" }), fetchImpl, NOW);
  assert.equal(ready.status, 200);
  const body = await ready.json() as { url: string };
  assert.equal(body.url, "http://stripe.test/portal/session");
  assert.equal(new URLSearchParams(portalBody).get("customer"), "cus_portal");
});

test("a founding sale past the cap is refunded and not granted", async () => {
  const { db } = openTestDb();
  for (let index = 0; index < 100; index += 1) {
    await db.prepare(
      "INSERT INTO founding_sales (id, stripe_session_id, status, created_at) VALUES (?1, ?2, 'paid', ?3)",
    ).bind(`full-${index}`, `cs_full_${index}`, NOW).run();
  }
  const payload = JSON.stringify({
    id: "evt_over",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_over",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        status: "complete",
        currency: "usd",
        amount_subtotal: 24900,
        amount_total: 24900,
        customer: "cus_over",
        customer_details: { email: "over@example.com" },
        metadata: { offer: "founding_249", plan: "founding" },
        payment_intent: "pi_over_cap",
      },
    },
  });
  let refundBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "http://stripe.test/v1/refunds");
    refundBody = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Idempotency-Key"), "founding-cap-pi_over_cap");
    return Response.json({ id: "re_over", status: "succeeded" });
  };
  assert.equal(await applyBillingEvent(env(db), payload, NOW, fetchImpl), "ok");
  assert.equal(new URLSearchParams(refundBody).get("payment_intent"), "pi_over_cap");
  const grants = await db.prepare("SELECT COUNT(*) AS n FROM access_grants").first<{ n: number }>();
  assert.equal(grants?.n, 0);
});

test("the checkout form keeps the Stripe session placeholder", () => {
  const body = stripeForm([["success_url", "https://oldcounsel.com/thanks?session_id={CHECKOUT_SESSION_ID}"]]);
  assert.equal(body, "success_url=https%3A%2F%2Foldcounsel.com%2Fthanks%3Fsession_id%3D{CHECKOUT_SESSION_ID}");
});
