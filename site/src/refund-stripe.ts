// Stripe lookups and refunds for Old Counsel pre-orders only.
// The account is shared with say.as. A charge qualifies only when a Checkout
// Session for PAYMENT_LINK_ID used this email, or the PaymentIntent metadata
// is the Old Counsel experiment and offer. Everything else is left alone.

export const PAYMENT_LINK_ID = "plink_1UejbsRssDxlNdX37XKaLinq";
export const EXPERIMENT = "oldcounsel-fakedoor-nov2026";
export const OFFER_META = "lifetime_49";
export const STRIPE_API = "https://api.stripe.com";

// Session pages for one payment link, and the metadata search, which is only Old Counsel
// payment intents. Past this cap the lookup fails closed instead of guessing.
const MAX_PAGES = 50;
const PAGE_SIZE = "100";

export interface StripeCharge {
  id?: string;
  refunded?: boolean;
  amount?: number;
  amount_refunded?: number;
  receipt_email?: string | null;
  billing_details?: { email?: string | null } | null;
}

export interface StripeCustomer {
  id?: string;
  email?: string | null;
}

export interface StripePaymentIntent {
  id: string;
  status?: string;
  metadata?: Record<string, string> | null;
  receipt_email?: string | null;
  customer?: string | StripeCustomer | null;
  latest_charge?: string | StripeCharge | null;
}

export interface StripeSession {
  id: string;
  payment_link?: string | { id?: string } | null;
  payment_intent?: string | { id?: string } | null;
  payment_status?: string | null;
  status?: string | null;
  customer?: string | { id?: string } | null;
  customer_details?: { email?: string | null } | null;
  customer_email?: string | null;
}

export interface StripeTransport {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; json: unknown }>;
}

export interface ChargeFinding {
  id: string;
  state: "refund" | "already";
}

export class StripeApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
  }
}

export class StripeLookupIncomplete extends Error {
  constructor() {
    super("Stripe lookup stopped before the last page");
    this.name = "StripeLookupIncomplete";
  }
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || email.length < 3) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function emailsEqual(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function hasOldCounselMetadata(metadata: Record<string, string> | null | undefined): boolean {
  if (!metadata) return false;
  return metadata.experiment === EXPERIMENT && metadata.offer === OFFER_META;
}

export function idempotencyKey(paymentIntentId: string): string {
  return `oldcounsel-refund-${paymentIntentId}`;
}

export function stripeTransport(fetchImpl: typeof fetch, key: string): StripeTransport {
  return {
    async fetch(url, init) {
      const response = await fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...init.headers,
        },
        body: init.body,
      });
      let json: unknown = {};
      try {
        json = await response.json();
      } catch {
        json = {};
      }
      return { status: response.status, json };
    },
  };
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stripeQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emailVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  return trimmed === lower ? [lower] : [trimmed, lower];
}

function sessionEmail(session: StripeSession): string {
  return session.customer_details?.email || session.customer_email || "";
}

function paymentIntentIdFromSession(session: StripeSession, email: string): string | null {
  if (idOf(session.payment_link) !== PAYMENT_LINK_ID) return null;
  if (session.status !== "complete" || session.payment_status !== "paid") return null;
  if (!emailsEqual(sessionEmail(session), email)) return null;
  const paymentIntentId = idOf(session.payment_intent);
  if (!paymentIntentId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return null;
  return paymentIntentId;
}

function chargeOf(intent: StripePaymentIntent): StripeCharge | null {
  if (!intent.latest_charge || typeof intent.latest_charge === "string") return null;
  return intent.latest_charge;
}

function intentEmails(intent: StripePaymentIntent): string[] {
  const found: string[] = [];
  if (intent.receipt_email) found.push(intent.receipt_email);
  const charge = chargeOf(intent);
  if (charge?.receipt_email) found.push(charge.receipt_email);
  if (charge?.billing_details?.email) found.push(charge.billing_details.email);
  if (intent.customer && typeof intent.customer === "object" && intent.customer.email) {
    found.push(intent.customer.email);
  }
  return found;
}

function chargeState(intent: StripePaymentIntent): "refund" | "already" | "skip" {
  if (intent.status !== "succeeded") return "skip";
  const charge = chargeOf(intent);
  if (!charge) return "skip";
  const amount = charge.amount ?? 0;
  const refundedAmount = charge.amount_refunded ?? 0;
  if (charge.refunded === true || (amount > 0 && refundedAmount >= amount)) return "already";
  if (amount <= 0) return "skip";
  return "refund";
}

function errorCode(json: unknown): string {
  const record = asRecord(json);
  const error = record ? asRecord(record.error) : null;
  return error && typeof error.code === "string" ? error.code : "";
}

function errorMessage(json: unknown): string {
  const record = asRecord(json);
  const error = record ? asRecord(record.error) : null;
  return error && typeof error.message === "string" ? error.message : "Stripe request failed";
}

async function stripeRequest(
  transport: StripeTransport,
  method: "GET" | "POST",
  path: string,
  params: URLSearchParams,
  idempotency?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  let url = `${STRIPE_API}${path}`;
  let body: string | undefined;
  if (method === "GET") {
    const query = params.toString();
    if (query) url = `${url}?${query}`;
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = params.toString();
  }
  if (idempotency) headers["Idempotency-Key"] = idempotency;
  const result = await transport.fetch(url, { method, headers, body });
  if (result.status < 200 || result.status >= 300) {
    throw new StripeApiError(result.status, errorCode(result.json), errorMessage(result.json));
  }
  return result;
}

interface PageBody {
  data: unknown[];
  hasMore: boolean;
  nextPage: string | null;
}

function readPage(json: unknown): PageBody {
  const record = asRecord(json);
  const data = record && Array.isArray(record.data) ? record.data : [];
  const hasMore = Boolean(record && record.has_more);
  const nextPage = record && typeof record.next_page === "string" ? record.next_page : null;
  return { data, hasMore, nextPage };
}

async function listAll(
  transport: StripeTransport,
  path: string,
  base: URLSearchParams,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let startingAfter = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams(base);
    params.set("limit", PAGE_SIZE);
    if (startingAfter) params.set("starting_after", startingAfter);
    const result = await stripeRequest(transport, "GET", path, params);
    const body = readPage(result.json);
    rows.push(...body.data);
    if (!body.hasMore) return rows;
    const last = asRecord(body.data[body.data.length - 1]);
    const lastId = last && typeof last.id === "string" ? last.id : null;
    if (!lastId) throw new StripeLookupIncomplete();
    startingAfter = lastId;
  }
  throw new StripeLookupIncomplete();
}

async function searchAll(
  transport: StripeTransport,
  path: string,
  query: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("limit", PAGE_SIZE);
    if (pageToken) params.set("page", pageToken);
    const result = await stripeRequest(transport, "GET", path, params);
    const body = readPage(result.json);
    rows.push(...body.data);
    if (!body.hasMore) return rows;
    if (!body.nextPage) throw new StripeLookupIncomplete();
    pageToken = body.nextPage;
  }
  throw new StripeLookupIncomplete();
}

function asSession(value: unknown): StripeSession | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  return record as unknown as StripeSession;
}

function asIntent(value: unknown): StripePaymentIntent | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  return record as unknown as StripePaymentIntent;
}

function asCustomer(value: unknown): StripeCustomer | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  return record as unknown as StripeCustomer;
}

async function retrieveIntent(transport: StripeTransport, paymentIntentId: string): Promise<StripePaymentIntent> {
  const params = new URLSearchParams();
  params.append("expand[]", "latest_charge");
  params.append("expand[]", "customer");
  const result = await stripeRequest(transport, "GET", `/v1/payment_intents/${paymentIntentId}`, params);
  const intent = asIntent(result.json);
  if (!intent || intent.id !== paymentIntentId) {
    throw new StripeApiError(502, "invalid_response", "PaymentIntent response did not match the requested id");
  }
  return intent;
}

function metadataQuery(): string {
  return `metadata["experiment"]:${stripeQuote(EXPERIMENT)} AND metadata["offer"]:${stripeQuote(OFFER_META)} AND status:"succeeded"`;
}

export async function findOldCounselCharges(
  rawEmail: string,
  transport: StripeTransport,
): Promise<ChargeFinding[]> {
  const email = normalizeEmail(rawEmail);
  if (!email) return [];
  const variants = emailVariants(rawEmail);

  const sessionIds = new Set<string>();
  for (const variant of variants) {
    const params = new URLSearchParams();
    params.set("payment_link", PAYMENT_LINK_ID);
    params.set("status", "complete");
    params.set("customer_details[email]", variant);
    const sessions = await listAll(transport, "/v1/checkout/sessions", params);
    for (const row of sessions) {
      const session = asSession(row);
      if (!session) continue;
      const paymentIntentId = paymentIntentIdFromSession(session, email);
      if (paymentIntentId) sessionIds.add(paymentIntentId);
    }
  }

  const customers = await searchAll(
    transport,
    "/v1/customers/search",
    `email:${stripeQuote(email)}`,
  );
  const customerIds = new Set<string>();
  for (const row of customers) {
    const customer = asCustomer(row);
    if (!customer?.id || !emailsEqual(customer.email, email)) continue;
    customerIds.add(customer.id);
  }

  for (const customerId of customerIds) {
    const params = new URLSearchParams();
    params.set("payment_link", PAYMENT_LINK_ID);
    params.set("status", "complete");
    params.set("customer", customerId);
    const sessions = await listAll(transport, "/v1/checkout/sessions", params);
    for (const row of sessions) {
      const session = asSession(row);
      if (!session) continue;
      const paymentIntentId = paymentIntentIdFromSession(session, email);
      if (paymentIntentId) sessionIds.add(paymentIntentId);
    }
  }

  const metadataIds = new Set<string>();
  const seenMetadata = new Set<string>();
  const considerIntent = (intent: StripePaymentIntent | null) => {
    if (!intent || seenMetadata.has(intent.id)) return;
    seenMetadata.add(intent.id);
    if (!hasOldCounselMetadata(intent.metadata)) return;
    if (intent.receipt_email && !emailsEqual(intent.receipt_email, email)) return;
    metadataIds.add(intent.id);
  };

  // Search is limited to Old Counsel metadata. Do not list every PaymentIntent
  // on a customer: this Stripe account also holds say.as charges.
  for (const customerId of customerIds) {
    const searchedForCustomer = await searchAll(
      transport,
      "/v1/payment_intents/search",
      `${metadataQuery()} AND customer:${stripeQuote(customerId)}`,
    );
    for (const row of searchedForCustomer) considerIntent(asIntent(row));
  }

  const searched = await searchAll(transport, "/v1/payment_intents/search", metadataQuery());
  for (const row of searched) considerIntent(asIntent(row));

  const findings: ChargeFinding[] = [];
  const seen = new Set<string>();
  const ids = [...sessionIds, ...metadataIds];
  for (const paymentIntentId of ids) {
    if (seen.has(paymentIntentId)) continue;
    seen.add(paymentIntentId);
    const intent = await retrieveIntent(transport, paymentIntentId);
    const fromSession = sessionIds.has(paymentIntentId);
    const fromMetadata = hasOldCounselMetadata(intent.metadata)
      && intentEmails(intent).some((value) => emailsEqual(value, email));
    if (!fromSession && !fromMetadata) continue;
    const state = chargeState(intent);
    if (state === "skip") continue;
    findings.push({ id: paymentIntentId, state });
  }
  return findings;
}

export async function refundCharges(
  ids: string[],
  transport: StripeTransport,
): Promise<{ refunded: string[]; already: string[] }> {
  const refunded: string[] = [];
  const already: string[] = [];
  for (const paymentIntentId of ids) {
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) continue;
    const params = new URLSearchParams();
    params.set("payment_intent", paymentIntentId);
    params.set("reason", "requested_by_customer");
    try {
      await stripeRequest(
        transport,
        "POST",
        "/v1/refunds",
        params,
        idempotencyKey(paymentIntentId),
      );
      refunded.push(paymentIntentId);
    } catch (error) {
      if (error instanceof StripeApiError && error.code === "charge_already_refunded") {
        already.push(paymentIntentId);
        continue;
      }
      throw error;
    }
  }
  return { refunded, already };
}
