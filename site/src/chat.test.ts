import assert from "node:assert/strict";
import test from "node:test";

import { hashEmail } from "./access.ts";
import { handleAccess, handleChat, type HandlerDeps } from "./chat.ts";
import {
  COLD_REPLY_RESERVE_MICRO_USD,
  FREE_CONVERSATION_REPLIES,
  MONTHLY_REPLY_CAP,
} from "./config.ts";
import { accessCookie } from "./cookies.ts";
import { grantAccess, readPaidCheckout, retrievePaidSession } from "./checkout.ts";
import { handleRestoreConfirm, handleRestoreRequest } from "./restore.ts";
import { grantCheckoutEvent } from "./checkout.ts";
import { openTestDb } from "./testing/d1.ts";

const SECRET = "test-access-secret-value";
const KEY = "sk-or-test-key-do-not-log";
const PROMPT = "SYSTEM-PROMPT-BYTES\n";
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const LIVE = /api\.stripe\.com|openrouter\.ai/i;

function env(db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    OPENROUTER_API_KEY: KEY,
    ACCESS_SIGNING_SECRET: SECRET,
    STRIPE_REFUND_KEY: "rk_test_mock",
    OPENROUTER_API_BASE: "http://openrouter.test/v1/chat/completions",
    STRIPE_API_BASE: "http://stripe.test",
    ...extra,
  } as Env;
}

function sse(text: string, cost: number | null = 0.044): Response {
  const usage = cost === null ? "" : `data: ${JSON.stringify({
    choices: [{ delta: {} }],
    usage: {
      cost,
      prompt_tokens: 308000,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 300000 },
    },
  })}\n\n`;
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n${usage}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function deps(fetchImpl: typeof fetch): HandlerDeps {
  return { fetchImpl, now: () => NOW, systemPrompt: PROMPT };
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

async function postChat(db: D1Database, fetchImpl: typeof fetch, cookie: string, content = "I can't sleep.") {
  const request = new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "CF-Connecting-IP": "203.0.113.8" },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
  return handleChat(request, env(db), deps(fetchImpl));
}

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_buyer",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    currency: "usd",
    amount_subtotal: 24900,
    amount_total: 24900,
    customer: "cus_test_buyer",
    customer_details: { email: "Buyer@Example.com" },
    metadata: { offer: "founding_249", plan: "founding" },
    ...overrides,
  };
}

test("free conversation size is 8 replies, then the paywall, with no live calls", async () => {
  assert.equal(FREE_CONVERSATION_REPLIES, 8);
  assert.equal(MONTHLY_REPLY_CAP, 100);
  const { db } = openTestDb();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(LIVE.test(url), false);
    calls.push(url);
    const body = String(init?.body ?? "");
    assert.equal(body.includes(KEY), false);
    const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }>; provider: { only: string[] } };
    assert.deepEqual(parsed.provider.only, ["claude-on-aws"]);
    const system = parsed.messages[0].content as Array<{ text: string }>;
    assert.equal(system[0].text, PROMPT);
    return sse("Look at the next hour, not the whole year.");
  };
  let cookie = "";
  for (let index = 0; index < FREE_CONVERSATION_REPLIES; index += 1) {
    const response = await postChat(db, fetchImpl, cookie, `Trouble ${index}`);
    assert.equal(response.status, 200, await response.clone().text());
    cookie = cookieJar(response, cookie);
    const text = await response.text();
    assert.match(text, /Look at the next hour/);
  }
  assert.equal(calls.length, FREE_CONVERSATION_REPLIES);
  const blocked = await postChat(db, fetchImpl, cookie, "One more");
  assert.equal(blocked.status, 402);
  const body = await blocked.json() as { code: string; message: string };
  assert.equal(body.code, "free_limit");
  assert.equal(body.message.includes("$49"), false);
  assert.match(body.message, /Eight replies/);
  assert.match(body.message, /free conversation/);
  assert.equal(calls.length, FREE_CONVERSATION_REPLIES);
});

test("a failed upstream call does not spend a free reply", async () => {
  const { db } = openTestDb();
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(LIVE.test(String(input)), false);
    return new Response("no", { status: 503 });
  };
  const first = await postChat(db, fetchImpl, "");
  assert.equal(first.status, 502);
  const second = await postChat(db, fetchImpl, cookieJar(first), "Again");
  assert.equal(second.status, 502);
  const row = await db.prepare("SELECT replies FROM usage_counters").first<{ replies: number }>();
  assert.equal(row?.replies ?? 0, 0);
  const spend = await db.prepare("SELECT micro_usd FROM spend_daily").first<{ micro_usd: number }>();
  assert.equal(spend?.micro_usd ?? 0, 0);
});

test("actual cost replaces the cold reserve", async () => {
  const { db } = openTestDb();
  const fetchImpl: typeof fetch = async () => sse("A short reply.", 0.044);
  const response = await postChat(db, fetchImpl, "");
  assert.equal(response.status, 200);
  await response.text();
  const spend = await db.prepare("SELECT micro_usd FROM spend_daily").first<{ micro_usd: number }>();
  assert.equal(spend?.micro_usd, 44_000);
  assert.ok((spend?.micro_usd ?? 0) < COLD_REPLY_RESERVE_MICRO_USD);
});

test("the daily spend guard stops a reply before OpenRouter is called", async () => {
  const { db } = openTestDb();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return sse("nope");
  };
  const guarded = env(db, { DAILY_SPEND_LIMIT_USD: "0.50" });
  const request = new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  });
  const response = await handleChat(request, guarded, deps(fetchImpl));
  assert.equal(response.status, 503);
  const body = await response.json() as { code: string; message: string };
  assert.equal(body.code, "spend_guard");
  assert.match(body.message, /pausing new replies/);
  assert.equal(calls, 0);
  const used = await db.prepare("SELECT replies FROM usage_counters").first<{ replies: number }>();
  assert.equal(used?.replies ?? 0, 0);
});

test("rate limits apply per anonymous id and per IP", async () => {
  const { db } = openTestDb();
  const fetchImpl: typeof fetch = async () => sse("Yes.");
  const limited = env(db, { CHAT_RATE_ANON_PER_HOUR: "1", CHAT_RATE_IP_PER_HOUR: "10" });
  const send = (cookie: string, ip: string) => handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "CF-Connecting-IP": ip },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  }), limited, deps(fetchImpl));
  const first = await send("", "203.0.113.10");
  assert.equal(first.status, 200);
  await first.text();
  const second = await send(cookieJar(first), "203.0.113.10");
  assert.equal(second.status, 429);
  assert.equal((await second.json() as { code: string }).code, "rate_limit");

  const ipLimited = env(db, { CHAT_RATE_ANON_PER_HOUR: "10", CHAT_RATE_IP_PER_HOUR: "1" });
  const otherIp = await handleChat(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello again" }] }),
  }), ipLimited, deps(fetchImpl));
  assert.equal(otherIp.status, 429);
});

test("a mocked purchase unlocks chat, and the monthly cap refuses at 100", async () => {
  const { db } = openTestDb();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    assert.equal(LIVE.test(url), false);
    calls.push(url);
    if (url.includes("/v1/checkout/sessions/")) {
      return Response.json(paidSession());
    }
    return sse("You can keep talking.");
  };
  const paid = await retrievePaidSession(env(db), "cs_test_buyer", fetchImpl);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const grantId = await grantAccess(db, SECRET, paid.session, NOW);
  const again = await grantAccess(db, SECRET, paid.session, NOW);
  assert.equal(again, grantId);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM access_grants").first<{ n: number }>();
  assert.equal(count?.n, 1);

  const cookie = await accessCookie(grantId, SECRET, NOW, false);
  const chatting = await postChat(db, fetchImpl, cookie, "What now?");
  assert.equal(chatting.status, 200);
  assert.match(await chatting.text(), /keep talking/);

  const emailHash = await hashEmail(SECRET, "buyer@example.com");
  await db.prepare("UPDATE usage_counters SET replies = ?1 WHERE subject = ?2")
    .bind(MONTHLY_REPLY_CAP, `paid:${emailHash}`)
    .run();
  const capped = await postChat(db, fetchImpl, cookie, "And now?");
  assert.equal(capped.status, 429);
  const body = await capped.json() as { code: string; message: string };
  assert.equal(body.code, "monthly_cap");
  assert.match(body.message, /100 replies this month/);
  assert.match(body.message, /the 1st/);
  assert.match(body.message, /help@oldcounsel.com/);
});

test("checkout rejects unpaid, underpriced, and other payment links", () => {
  assert.equal(readPaidCheckout(paidSession()).ok, true);
  assert.equal(readPaidCheckout(paidSession({ payment_status: "unpaid" })).ok, false);
  assert.equal(readPaidCheckout(paidSession({ amount_subtotal: 100, amount_total: 100 })).ok, false);
  assert.equal(readPaidCheckout(paidSession({ amount_subtotal: 4900, amount_total: 4900 })).ok, false);
  assert.equal(readPaidCheckout(paidSession({ metadata: { offer: "lifetime_49", plan: "founding" } })).ok, false);
  assert.equal(readPaidCheckout(paidSession({ customer_details: { email: "" }, customer_email: null })).ok, false);
});

test("the webhook grants access from the event and does not call Stripe", async () => {
  const { db } = openTestDb();
  const payload = JSON.stringify({
    id: "evt_test",
    type: "checkout.session.completed",
    data: { object: paidSession({ id: "cs_test_webhook" }) },
  });
  const result = await grantCheckoutEvent(db, SECRET, payload, NOW);
  assert.equal(result, "granted");
  const skipped = await grantCheckoutEvent(db, SECRET, JSON.stringify({
    id: "evt_other",
    type: "checkout.session.completed",
    data: { object: paidSession({ id: "cs_test_other", metadata: { offer: "lifetime_49" }, amount_total: 4900, amount_subtotal: 4900 }) },
  }), NOW);
  assert.equal(skipped, "skipped");
  const rows = await db.prepare("SELECT COUNT(*) AS n FROM access_grants").first<{ n: number }>();
  assert.equal(rows?.n, 1);
});

test("restore falls back to help@ when email sending is not configured", async () => {
  const { db } = openTestDb();
  const response = await handleRestoreRequest(new Request("http://127.0.0.1/api/access/restore", {
    method: "POST",
    body: JSON.stringify({ email: "buyer@example.com" }),
  }), env(db), NOW);
  const body = await response.json() as { method: string; message: string };
  assert.equal(body.method, "help");
  assert.match(body.message, /help@oldcounsel.com/);
});

test("a mocked code restores access on a new cookie", async () => {
  const { db } = openTestDb();
  await grantAccess(db, SECRET, {
    sessionId: "cs_test_restore",
    email: "buyer@example.com",
    customerId: "cus_test_buyer",
    kind: "founding",
    subscriptionId: null,
  }, NOW);
  const sent: string[] = [];
  const withMail = env(db);
  (withMail as { EMAIL: { send: (message: { text: string }) => Promise<{ messageId: string }> } }).EMAIL = {
    async send(message) {
      sent.push(message.text);
      return { messageId: "local" };
    },
  };
  const asked = await handleRestoreRequest(new Request("http://127.0.0.1/api/access/restore", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.20" },
    body: JSON.stringify({ email: "buyer@example.com" }),
  }), withMail, NOW);
  assert.equal((await asked.json() as { message: string }).message.includes("code is on its way"), true);
  const code = sent[0]?.match(/\d{6}/)?.[0];
  assert.ok(code);
  const confirmed = await handleRestoreConfirm(new Request("https://oldcounsel.com/api/access/confirm", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.20" },
    body: JSON.stringify({ email: "buyer@example.com", code }),
  }), withMail, NOW);
  assert.equal(confirmed.status, 200);
  const cookie = cookieJar(confirmed);
  assert.match(cookie, /oc_access=/);
  assert.match(confirmed.headers.get("set-cookie") ?? "", /Secure/);
  const access = await handleAccess(new Request("https://oldcounsel.com/api/access", { headers: { cookie } }), withMail, NOW);
  const view = await access.json() as { tier: string };
  assert.equal(view.tier, "paid");
});
