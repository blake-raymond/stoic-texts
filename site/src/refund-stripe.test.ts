import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { codeEmailText, DONE, NEUTRAL } from "./refund-copy.ts";
import {
  EXPERIMENT,
  OFFER_META,
  PAYMENT_LINK_ID,
  StripeApiError,
  StripeLookupIncomplete,
  findOldCounselCharges,
  hasOldCounselMetadata,
  idempotencyKey,
  normalizeEmail,
  refundCharges,
  stripeTransport,
  type StripeCharge,
  type StripePaymentIntent,
} from "./refund-stripe.ts";

const BUYER = "buyer@example.com";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface World {
  sessions: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  intentsByCustomer: Record<string, Record<string, unknown>[]>;
  search: Record<string, unknown>[];
  retrieved: Record<string, StripePaymentIntent>;
  refundStatus?: (paymentIntentId: string) => { status: number; json: unknown };
  sessionPages?: Record<string, unknown>[][];
  brokenList?: boolean;
  foundingSessions?: Record<string, unknown>[];
}

function charge(overrides: Partial<StripeCharge> = {}): StripeCharge {
  return {
    id: "ch_test",
    amount: 4900,
    amount_refunded: 0,
    refunded: false,
    receipt_email: BUYER,
    billing_details: { email: BUYER },
    ...overrides,
  };
}

function intent(
  id: string,
  metadata: Record<string, string>,
  receipt: string | null,
  latest: StripeCharge,
): StripePaymentIntent {
  return {
    id,
    status: "succeeded",
    metadata,
    receipt_email: receipt,
    latest_charge: latest,
    customer: "cus_buyer",
  };
}

function oldMeta(): Record<string, string> {
  return { experiment: EXPERIMENT, offer: OFFER_META };
}

function world(): World {
  const sessions = [
    {
      id: "cs_buyer",
      payment_link: PAYMENT_LINK_ID,
      payment_intent: "pi_session",
      payment_status: "paid",
      status: "complete",
      customer: "cus_buyer",
      customer_details: { email: "Buyer@Example.com" },
      customer_email: "Buyer@Example.com",
    },
    {
      id: "cs_other_email",
      payment_link: PAYMENT_LINK_ID,
      payment_intent: "pi_other_email",
      payment_status: "paid",
      status: "complete",
      customer_details: { email: "other@example.com" },
    },
    {
      id: "cs_say",
      payment_link: "plink_sayas",
      payment_intent: "pi_say_session",
      payment_status: "paid",
      status: "complete",
      customer_details: { email: BUYER },
    },
  ];
  const retrieved: Record<string, StripePaymentIntent> = {
    pi_session: intent("pi_session", {}, null, charge({ id: "ch_session", receipt_email: null, billing_details: { email: null } })),
    pi_meta: intent("pi_meta", oldMeta(), BUYER, charge({ id: "ch_meta" })),
    pi_already: intent("pi_already", oldMeta(), BUYER, charge({
      id: "ch_already",
      amount: 4900,
      amount_refunded: 4900,
      refunded: true,
    })),
    pi_billing: {
      id: "pi_billing",
      status: "succeeded",
      metadata: oldMeta(),
      receipt_email: null,
      customer: null,
      latest_charge: charge({
        id: "ch_billing",
        receipt_email: null,
        billing_details: { email: "Buyer@Example.com" },
      }),
    },
    pi_partial: intent("pi_partial", oldMeta(), BUYER, charge({
      id: "ch_partial",
      amount: 4900,
      amount_refunded: 100,
      refunded: false,
    })),
    pi_stale: intent("pi_stale", { experiment: "sayas" }, BUYER, charge({ id: "ch_stale" })),
    pi_poison: intent("pi_poison", {}, "poison@example.com", charge({ id: "ch_poison", receipt_email: "poison@example.com" })),
    pi_other_email: intent("pi_other_email", oldMeta(), "other@example.com", charge({ id: "ch_other" })),
    pi_say_session: intent("pi_say_session", { product: "sayas" }, BUYER, charge({ id: "ch_say_session", amount: 2000 })),
    pi_say_customer: intent("pi_say_customer", { experiment: "sayas", offer: "monthly" }, BUYER, charge({ id: "ch_say", amount: 1200 })),
    pi_half: intent("pi_half", { experiment: EXPERIMENT }, BUYER, charge({ id: "ch_half" })),
  };
  return {
    sessions,
    customers: [
      { id: "cus_buyer", email: "buyer@example.com" },
      { id: "cus_other", email: "other@example.com" },
    ],
    intentsByCustomer: {
      cus_buyer: [
        retrieved.pi_session,
        retrieved.pi_meta,
        retrieved.pi_say_customer,
        retrieved.pi_half,
      ],
      cus_other: [retrieved.pi_say_customer],
    },
    search: [
      { ...retrieved.pi_meta },
      { ...retrieved.pi_already },
      {
        id: "pi_stranger",
        status: "succeeded",
        metadata: oldMeta(),
        receipt_email: "stranger@example.com",
        latest_charge: "ch_stranger",
      },
      { ...retrieved.pi_stale, metadata: oldMeta() },
      { ...retrieved.pi_billing },
      { ...retrieved.pi_partial },
    ],
    retrieved,
  };
}

function poisonSession(): Record<string, unknown> {
  return {
    id: "cs_poison",
    payment_link: PAYMENT_LINK_ID,
    payment_intent: "pi_poison",
    payment_status: "paid",
    status: "complete",
    customer_details: { email: "poison@example.com" },
  };
}

function pageOf(data: unknown[], hasMore: boolean, nextPage: string | null = null) {
  return { object: "list", data, has_more: hasMore, next_page: nextPage };
}

function install(state: World): { requests: Recorded[]; fetch: typeof fetch } {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, headers, body });
    const parsed = new URL(url);
    const payload = answer(state, parsed, method, body);
    return new Response(JSON.stringify(payload.json), { status: payload.status });
  };
  return { requests, fetch: fetchImpl };
}

function answer(
  state: World,
  url: URL,
  method: string,
  body: string,
): { status: number; json: unknown } {
  const path = url.pathname;
  if (state.brokenList && method === "GET" && path === "/v1/checkout/sessions") {
    return { status: 200, json: pageOf([{}], true) };
  }
  if (method === "GET" && path === "/v1/checkout/sessions/search") {
    return { status: 200, json: pageOf(state.foundingSessions ?? [], false) };
  }
  if (method === "GET" && path === "/v1/checkout/sessions") {
    if (state.sessionPages) {
      const cursor = url.searchParams.get("starting_after");
      const index = cursor ? 1 : 0;
      const rows = state.sessionPages[index] ?? [];
      return { status: 200, json: pageOf(rows, index === 0) };
    }
    const link = url.searchParams.get("payment_link");
    const email = url.searchParams.get("customer_details[email]");
    const customer = url.searchParams.get("customer");
    let rows = state.sessions.filter((session) => {
      if (link && session.payment_link !== link) return false;
      if (customer && session.customer !== customer) return false;
      if (email) {
        const details = session.customer_details as { email?: string } | undefined;
        const found = details?.email || "";
        if (found.toLowerCase() !== email.toLowerCase()) return false;
      }
      return true;
    });
    if (link === PAYMENT_LINK_ID) rows = [...rows, poisonSession()];
    return { status: 200, json: pageOf(rows, false) };
  }
  if (method === "GET" && path === "/v1/customers/search") {
    return { status: 200, json: pageOf(state.customers, false) };
  }
  if (method === "GET" && path === "/v1/payment_intents") {
    const customer = url.searchParams.get("customer") || "";
    return { status: 200, json: pageOf(state.intentsByCustomer[customer] ?? [], false) };
  }
  if (method === "GET" && path === "/v1/payment_intents/search") {
    return { status: 200, json: pageOf(state.search, false) };
  }
  if (method === "GET" && path.startsWith("/v1/payment_intents/")) {
    const id = path.slice("/v1/payment_intents/".length);
    const found = state.retrieved[id];
    if (!found) return { status: 404, json: { error: { code: "resource_missing", message: "missing" } } };
    return { status: 200, json: found };
  }
  if (method === "POST" && path === "/v1/refunds") {
    const params = new URLSearchParams(body);
    const id = params.get("payment_intent") || "";
    if (state.refundStatus) return state.refundStatus(id);
    return { status: 200, json: { id: `re_${id}`, object: "refund", payment_intent: id, status: "succeeded" } };
  }
  return { status: 500, json: { error: { code: "unexpected", message: `${method} ${path}` } } };
}

function refundPosts(requests: Recorded[]): URLSearchParams[] {
  return requests
    .filter((request) => request.method === "POST" && new URL(request.url).pathname === "/v1/refunds")
    .map((request) => new URLSearchParams(request.body));
}

test("refunds only Old Counsel charges and skips anything else", async () => {
  const state = world();
  const { requests, fetch: fetchImpl } = install(state);
  const transport = stripeTransport(fetchImpl, "rk_test_mock");
  const findings = await findOldCounselCharges("  Buyer@Example.com ", transport);
  const refundIds = findings.filter((finding) => finding.state === "refund").map((finding) => finding.id);
  const alreadyIds = findings.filter((finding) => finding.state === "already").map((finding) => finding.id);
  assert.deepEqual(alreadyIds, ["pi_already"]);
  assert.deepEqual(new Set(refundIds), new Set(["pi_session", "pi_meta", "pi_billing", "pi_partial"]));

  const settled = await refundCharges(refundIds, transport);
  assert.deepEqual(new Set(settled.refunded), new Set(refundIds));
  assert.deepEqual(settled.already, []);

  const posts = refundPosts(requests);
  assert.equal(posts.length, refundIds.length);
  for (const params of posts) {
    assert.deepEqual([...params.keys()].sort(), ["payment_intent", "reason"]);
    assert.equal(params.get("reason"), "requested_by_customer");
    assert.equal(params.get("amount"), null);
  }
  const refunded = new Set(posts.map((params) => params.get("payment_intent")));
  for (const blocked of [
    "pi_poison",
    "pi_other_email",
    "pi_say_session",
    "pi_say_customer",
    "pi_half",
    "pi_stranger",
    "pi_stale",
    "pi_already",
  ]) {
    assert.equal(refunded.has(blocked), false, blocked);
  }

  const listedAllIntents = requests.filter((request) => new URL(request.url).pathname === "/v1/payment_intents");
  assert.equal(listedAllIntents.length, 0);
  const sessionCalls = requests.filter((request) => new URL(request.url).pathname === "/v1/checkout/sessions");
  assert.ok(sessionCalls.length > 0);
  for (const request of sessionCalls) {
    assert.equal(new URL(request.url).searchParams.get("payment_link"), PAYMENT_LINK_ID);
  }
  const searches = requests.filter((request) => new URL(request.url).pathname === "/v1/payment_intents/search");
  assert.ok(searches.length >= 2);
  const queries = searches.map((request) => new URL(request.url).searchParams.get("query") || "");
  assert.ok(queries.some((query) => query.includes('customer:"cus_buyer"')));
  const search = searches[searches.length - 1];
  assert.ok(search);
  const query = queries[queries.length - 1] || "";
  assert.match(query, /metadata\["experiment"\]:"oldcounsel-fakedoor-nov2026"/);
  assert.match(query, /metadata\["offer"\]:"lifetime_49"/);
  assert.match(query, /AND/);
  assert.equal(query.includes(" OR "), false);
  assert.equal(requests.some((request) => request.url.includes("pi_stranger")), false);

  const post = requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.equal(post.headers.authorization, "Bearer rk_test_mock");
  assert.equal(post.headers["idempotency-key"], idempotencyKey("pi_session"));
  assert.equal(idempotencyKey("pi_session"), "oldcounsel-refund-pi_session");
});

test("follows checkout session pages", async () => {
  const state = world();
  state.sessionPages = [
    [{ id: "cs_filler", payment_link: PAYMENT_LINK_ID, status: "complete", payment_status: "unpaid" }],
    [state.sessions[0]],
  ];
  state.customers = [];
  state.search = [];
  const { requests, fetch: fetchImpl } = install(state);
  const findings = await findOldCounselCharges(BUYER, stripeTransport(fetchImpl, "rk_test_mock"));
  assert.deepEqual(findings.map((finding) => finding.id), ["pi_session"]);
  const cursors = requests
    .filter((request) => new URL(request.url).pathname === "/v1/checkout/sessions")
    .map((request) => new URL(request.url).searchParams.get("starting_after"));
  assert.deepEqual(cursors.slice(0, 2), [null, "cs_filler"]);
});

test("stops before refunding when a Stripe page never ends", async () => {
  const state = world();
  state.brokenList = true;
  const { requests, fetch: fetchImpl } = install(state);
  await assert.rejects(
    () => findOldCounselCharges(BUYER, stripeTransport(fetchImpl, "rk_test_mock")),
    (error: unknown) => error instanceof StripeLookupIncomplete,
  );
  assert.equal(refundPosts(requests).length, 0);
});

test("an already-refunded Stripe error is not a second refund", async () => {
  const { requests, fetch: fetchImpl } = install({
    ...world(),
    refundStatus: () => ({
      status: 400,
      json: { error: { code: "charge_already_refunded", message: "Charge already refunded" } },
    }),
  });
  const settled = await refundCharges(["pi_meta"], stripeTransport(fetchImpl, "rk_test_mock"));
  assert.deepEqual(settled, { refunded: [], already: ["pi_meta"] });
  assert.equal(refundPosts(requests).length, 1);
  assert.equal(requests[0]?.headers["idempotency-key"], "oldcounsel-refund-pi_meta");
});

test("other Stripe refund errors are not treated as success", async () => {
  const { fetch: fetchImpl } = install({
    ...world(),
    refundStatus: () => ({
      status: 400,
      json: { error: { code: "charge_disputed", message: "disputed" } },
    }),
  });
  await assert.rejects(
    () => refundCharges(["pi_meta"], stripeTransport(fetchImpl, "rk_test_mock")),
    (error: unknown) => error instanceof StripeApiError && error.code === "charge_disputed",
  );
});

test("a founding lifetime charge is refundable when its price id is configured", async () => {
  const state = world();
  state.foundingSessions = [{
    id: "cs_founding",
    mode: "payment",
    payment_intent: "pi_founding",
    payment_status: "paid",
    status: "complete",
    amount_total: 24900,
    metadata: { offer: "founding_249" },
    customer_details: { email: BUYER },
  }];
  state.retrieved.pi_founding = intent(
    "pi_founding",
    { offer: "founding_249" },
    BUYER,
    charge({ id: "ch_founding", amount: 24900 }),
  );
  const { fetch: fetchImpl } = install(state);
  const findings = await findOldCounselCharges(BUYER, stripeTransport(fetchImpl, "rk_test_mock"), "price_foundingEnv");
  assert.equal(findings.some((finding) => finding.id === "pi_founding" && finding.state === "refund"), true);
  const withoutPrice = await findOldCounselCharges(BUYER, stripeTransport(install(world()).fetch, "rk_test_mock"));
  assert.equal(withoutPrice.some((finding) => finding.id === "pi_founding"), false);
});

test("matching helpers reject lookalikes and bad emails", () => {
  assert.equal(hasOldCounselMetadata({ experiment: EXPERIMENT, offer: OFFER_META }), true);
  assert.equal(hasOldCounselMetadata({ experiment: EXPERIMENT, offer: "lifetime_49_preorder" }), false);
  assert.equal(hasOldCounselMetadata({ experiment: EXPERIMENT }), false);
  assert.equal(hasOldCounselMetadata({ offer: OFFER_META }), false);
  assert.equal(normalizeEmail("  Buyer@Example.com "), BUYER);
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(idempotencyKey("pi_abc").includes("@"), false);
  assert.equal(DONE.includes("\u2014"), false);
  assert.equal(NEUTRAL.includes("\u2014"), false);
  const mailed = codeEmailText("042013");
  assert.match(mailed, /042013/);
  assert.equal(mailed.includes("\u2014"), false);
  assert.equal(/\bphone\b/i.test(mailed), false);
});

test("buyers cannot post refund events through the public tracker", () => {
  const source = readFileSync(new URL("./events.ts", import.meta.url), "utf8");
  const publicEvents = source.split("] as const", 1)[0] ?? "";
  assert.equal(publicEvents.includes("refund_"), false);
});
