const TOLERANCE_SECONDS = 300;

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function parseSignature(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1" && value) v1.push(value);
  }
  return { t, v1 };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verify a Stripe-Signature header. The secret is the webhook signing secret, used as the HMAC key. */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false;
  const { t, v1 } = parseSignature(header);
  if (!t || !/^\d+$/.test(t) || v1.length === 0) return false;
  const timestamp = Number(t);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return v1.some((candidate) => timingSafeEqual(candidate, expected));
}

export interface CheckoutCompleted {
  eventId: string;
  sessionId: string;
  clientReferenceId: string | null;
}

export function readCheckoutCompleted(payload: string): { ok: true; event: CheckoutCompleted } | { ok: false; ignore?: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "invalid json" };
  const event = parsed as Record<string, unknown>;
  if (event.type !== "checkout.session.completed") return { ok: false, ignore: true };
  if (typeof event.id !== "string" || !event.id) return { ok: false, error: "missing event id" };
  const data = event.data;
  if (!data || typeof data !== "object") return { ok: false, error: "missing data" };
  const object = (data as Record<string, unknown>).object;
  if (!object || typeof object !== "object") return { ok: false, error: "missing session" };
  const session = object as Record<string, unknown>;
  if (session.object !== "checkout.session") return { ok: false, error: "not a checkout session" };
  if (typeof session.id !== "string" || !/^[A-Za-z0-9_]{1,200}$/.test(session.id)) {
    return { ok: false, error: "bad session id" };
  }
  let clientReferenceId: string | null = null;
  if (typeof session.client_reference_id === "string" && session.client_reference_id) {
    if (session.client_reference_id.length > 200) return { ok: false, error: "bad client_reference_id" };
    clientReferenceId = session.client_reference_id;
  }
  return {
    ok: true,
    event: { eventId: event.id, sessionId: session.id, clientReferenceId },
  };
}
