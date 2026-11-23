import { OFFER } from "./config.ts";

export const PUBLIC_EVENTS = [
  "page_view",
  "scroll_depth",
  "example_view",
  "cta_click",
  "door_view",
  "door_close",
  "checkout_click",
  "faq_open",
  "link_click",
  "purchase_return",
] as const;

const CTA_EVENTS = new Set(["cta_click", "door_view", "door_close", "checkout_click"]);
const CTAS = new Set(["hero", "example", "offer", "close", "chat"]);
const VARIANTS = new Set(["a", "b", "c"]);
const DEPTHS = new Set([25, 50, 75, 100]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export interface EventRow {
  name: string;
  variant: string;
  offer: string;
  cta: string | null;
  sessionId: string | null;
  clientReferenceId: string | null;
  stripeEventId: string | null;
  ts: number;
  props: string;
}

function isPublicEvent(value: string): boolean {
  return (PUBLIC_EVENTS as readonly string[]).includes(value);
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

export function clientReferenceParts(ref: string | null): { cta: string | null; variant: string | null } {
  if (!ref) return { cta: null, variant: null };
  const splitAt = ref.indexOf("_");
  if (splitAt < 0) return { cta: ref, variant: null };
  return { cta: ref.slice(0, splitAt), variant: ref.slice(splitAt + 1) };
}

export function sanitizePublicEvent(raw: unknown, now: number): { ok: true; row: EventRow } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "expected an object" };
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.event !== "string" || !isPublicEvent(input.event)) {
    return { ok: false, error: "unknown event" };
  }
  const name = input.event;
  const variant = cleanString(input.variant, 16);
  if (!variant || !VARIANTS.has(variant)) {
    return { ok: false, error: "unknown variant" };
  }

  let cta: string | null = null;
  if (CTA_EVENTS.has(name) || input.cta !== undefined) {
    cta = cleanString(input.cta, 32);
    if (!cta || !CTAS.has(cta)) {
      if (CTA_EVENTS.has(name)) return { ok: false, error: "unknown cta" };
      cta = null;
    }
  }

  const props: Record<string, unknown> = {
    event: name,
    variant,
    offer: OFFER,
  };

  let ts = now;
  if (typeof input.ts === "number" && Number.isFinite(input.ts)) {
    const rounded = Math.round(input.ts);
    if (rounded > 1_577_836_800_000 && rounded < 4_102_444_800_000) ts = rounded;
  }
  props.ts = ts;

  if (name === "scroll_depth") {
    const depth = input.depth;
    if (typeof depth !== "number" || !DEPTHS.has(depth)) {
      return { ok: false, error: "unknown depth" };
    }
    props.depth = depth;
  }

  if (name === "faq_open") {
    const question = cleanString(input.q, 300);
    if (!question) return { ok: false, error: "missing question" };
    props.q = question;
  }

  if (name === "link_click") {
    const link = cleanString(input.link, 64);
    if (!link) return { ok: false, error: "missing link" };
    props.link = link;
  }

  if (name === "page_view") {
    const referrer = cleanString(input.referrer, 500);
    props.referrer = referrer ?? "";
  }

  if (name === "door_close" || name === "checkout_click") {
    const openFor = input.ms_open;
    if (typeof openFor !== "number" || !Number.isFinite(openFor) || openFor < 0 || openFor > 86_400_000) {
      return { ok: false, error: "bad ms_open" };
    }
    props.ms_open = Math.round(openFor);
  }

  let sessionId: string | null = null;
  if (name === "purchase_return" || input.session_id !== undefined) {
    if (input.session_id !== undefined && input.session_id !== null && input.session_id !== "") {
      if (typeof input.session_id !== "string" || !/^[A-Za-z0-9_]{1,200}$/.test(input.session_id)) {
        return { ok: false, error: "bad session_id" };
      }
      sessionId = input.session_id;
    }
    if (name === "purchase_return") props.session_id = sessionId ?? "";
  }

  for (const key of UTM_KEYS) {
    const value = cleanString(input[key], 200);
    if (value) props[key] = value;
  }

  if (cta) props.cta = cta;

  return {
    ok: true,
    row: {
      name,
      variant,
      offer: OFFER,
      cta,
      sessionId,
      clientReferenceId: null,
      stripeEventId: null,
      ts,
      props: JSON.stringify(props),
    },
  };
}

export function serverEvent(name: string, props: Record<string, unknown>, now: number): EventRow {
  return {
    name,
    variant: "",
    offer: OFFER,
    cta: null,
    sessionId: null,
    clientReferenceId: null,
    stripeEventId: null,
    ts: now,
    props: JSON.stringify(props),
  };
}

export async function insertEvent(db: D1Database, row: EventRow): Promise<void> {
  await db.prepare(
    `INSERT INTO events
      (name, variant, offer, cta, session_id, client_reference_id, stripe_event_id, ts, props)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      row.name,
      row.variant || null,
      row.offer,
      row.cta,
      row.sessionId,
      row.clientReferenceId,
      row.stripeEventId,
      row.ts,
      row.props,
    )
    .run();
}

export function purchaseEvent(input: {
  now: number;
  sessionId: string;
  clientReferenceId: string | null;
  stripeEventId: string;
  offer?: string;
}): EventRow {
  const offer = input.offer === "founding_249" || input.offer === "subscription" ? input.offer : OFFER;
  const parts = clientReferenceParts(input.clientReferenceId);
  const variant = parts.variant && VARIANTS.has(parts.variant) ? parts.variant : null;
  const cta = parts.cta && CTAS.has(parts.cta) ? parts.cta : null;
  const props: Record<string, unknown> = {
    event: "purchase",
    offer,
    ts: input.now,
    session_id: input.sessionId,
    stripe_event_id: input.stripeEventId,
  };
  if (input.clientReferenceId) props.client_reference_id = input.clientReferenceId;
  if (cta) props.cta = cta;
  if (variant) props.variant = variant;
  return {
    name: "purchase",
    variant: variant ?? "",
    offer,
    cta,
    sessionId: input.sessionId,
    clientReferenceId: input.clientReferenceId,
    stripeEventId: input.stripeEventId,
    ts: input.now,
    props: JSON.stringify(props),
  };
}
