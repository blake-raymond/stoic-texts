import { hashEmail, signingSecret, stripeKey } from "./access.ts";
import { PRICE_CENTS } from "./config.ts";
import { PAYMENT_LINK_ID, normalizeEmail } from "./refund-stripe.ts";

export interface PaidSession {
  sessionId: string;
  email: string;
  customerId: string | null;
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

/** A paid Old Counsel Checkout Session. Anything else is not access. */
export function readPaidCheckout(value: unknown, expectedSessionId?: string): { ok: true; session: PaidSession } | { ok: false } {
  const session = asRecord(value);
  if (!session) return { ok: false };
  if (session.object !== "checkout.session") return { ok: false };
  if (typeof session.id !== "string" || !/^cs_[A-Za-z0-9_]{1,200}$/.test(session.id)) return { ok: false };
  if (expectedSessionId && session.id !== expectedSessionId) return { ok: false };
  if (session.status !== "complete" || session.payment_status !== "paid") return { ok: false };
  if (idOf(session.payment_link) !== PAYMENT_LINK_ID) return { ok: false };
  if (typeof session.currency !== "string" || session.currency.toLowerCase() !== "usd") return { ok: false };
  const subtotal = session.amount_subtotal;
  const total = session.amount_total;
  const price = typeof subtotal === "number" ? subtotal : total;
  if (price !== PRICE_CENTS) return { ok: false };
  const details = asRecord(session.customer_details);
  const email = normalizeEmail(
    (typeof details?.email === "string" && details.email)
      || (typeof session.customer_email === "string" && session.customer_email)
      || "",
  );
  if (!email) return { ok: false };
  return {
    ok: true,
    session: {
      sessionId: session.id,
      email,
      customerId: idOf(session.customer),
    },
  };
}

export function stripeApiBase(env: Env): string {
  const raw = env.STRIPE_API_BASE;
  if (typeof raw === "string" && raw.trim()) return raw.trim().replace(/\/$/, "");
  return "https://api.stripe.com";
}

export async function retrievePaidSession(
  env: Env,
  sessionId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; session: PaidSession } | { ok: false }> {
  const key = stripeKey(env);
  if (!key || !/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return { ok: false };
  let response: Response;
  try {
    response = await fetchImpl(`${stripeApiBase(env)}/v1/checkout/sessions/${sessionId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "stripe session fetch failed",
      error: error instanceof Error ? error.message : "fetch failed",
    }));
    return { ok: false };
  }
  if (!response.ok) {
    console.error(JSON.stringify({ message: "stripe session rejected", status: response.status }));
    return { ok: false };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false };
  }
  return readPaidCheckout(body, sessionId);
}

export async function grantAccess(db: D1Database, secret: string, session: PaidSession, now: number): Promise<string> {
  const emailHash = await hashEmail(secret, session.email);
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO access_grants (id, stripe_session_id, stripe_customer_id, email_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(stripe_session_id) DO NOTHING`,
  ).bind(id, session.sessionId, session.customerId, emailHash, now).run();
  const row = await db.prepare(
    "SELECT id FROM access_grants WHERE stripe_session_id = ?1",
  ).bind(session.sessionId).first<{ id: string }>();
  if (!row) throw new Error("grant missing");
  return row.id;
}

export async function grantCheckoutEvent(db: D1Database, secret: string, payload: string, now: number): Promise<"granted" | "skipped" | "error"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "skipped";
  }
  const event = asRecord(parsed);
  if (!event || event.type !== "checkout.session.completed") return "skipped";
  const data = asRecord(event.data);
  const paid = readPaidCheckout(data?.object);
  if (!paid.ok) return "skipped";
  try {
    await grantAccess(db, secret, paid.session, now);
    return "granted";
  } catch (error) {
    console.error(JSON.stringify({
      message: "access grant failed",
      error: error instanceof Error ? error.message : "grant failed",
    }));
    return "error";
  }
}

export function canGrant(env: Env): string | undefined {
  return signingSecret(env);
}
