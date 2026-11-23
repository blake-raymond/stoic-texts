import { FOUNDING_BUYER_CAP } from "./config.ts";

export const FOUNDING_OFFER = "founding_249";
export const SUBSCRIPTION_OFFER = "subscription";

/** Abandoned Checkout Sessions stop holding a spot after a day. */
export const RESERVATION_MS = 24 * 60 * 60 * 1000;

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

export async function sweepFoundingReservations(db: D1Database, now: number): Promise<void> {
  await db.prepare(
    "DELETE FROM founding_sales WHERE status = 'reserved' AND created_at < ?1",
  ).bind(now - RESERVATION_MS).run();
}

async function paidCount(db: D1Database): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM founding_sales WHERE status = 'paid'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function heldCount(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM founding_sales
     WHERE status = 'paid' OR (status = 'reserved' AND created_at >= ?1)`,
  ).bind(now - RESERVATION_MS).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Remaining paid spots. Null when the count cannot be read. The offer is closed at the cap. */
export async function foundingAvailability(
  db: D1Database,
  now: number,
): Promise<{ open: boolean; remaining: number } | null> {
  try {
    await sweepFoundingReservations(db, now);
    const paid = await paidCount(db);
    const held = await heldCount(db, now);
    const remaining = Math.max(0, FOUNDING_BUYER_CAP - paid);
    return { open: held < FOUNDING_BUYER_CAP && remaining > 0, remaining };
  } catch (error) {
    console.error(JSON.stringify({
      message: "founding count failed",
      error: error instanceof Error ? error.message : "count failed",
    }));
    return null;
  }
}

/** Hold one spot. Returns the reservation id, or null when the cap is already taken. */
export async function reserveFounding(db: D1Database, now: number): Promise<string | null> {
  await sweepFoundingReservations(db, now);
  const id = crypto.randomUUID();
  const result = await db.prepare(
    `INSERT INTO founding_sales (id, stripe_session_id, status, created_at)
     SELECT ?1, NULL, 'reserved', ?2
     WHERE (
       SELECT COUNT(*) FROM founding_sales
       WHERE status = 'paid' OR (status = 'reserved' AND created_at >= ?3)
     ) < ?4`,
  ).bind(id, now, now - RESERVATION_MS, FOUNDING_BUYER_CAP).run();
  return changes(result) > 0 ? id : null;
}

export async function releaseFounding(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    "DELETE FROM founding_sales WHERE id = ?1 AND status = 'reserved'",
  ).bind(id).run();
}

export async function attachFoundingSession(db: D1Database, id: string, sessionId: string): Promise<void> {
  await db.prepare(
    "UPDATE founding_sales SET stripe_session_id = ?2 WHERE id = ?1",
  ).bind(id, sessionId).run();
}

/**
 * Mark a paid founding Checkout Session. A session we already reserved is updated.
 * A session with no reservation is inserted only while paid sales are under the cap.
 */
export async function markFoundingPaid(
  db: D1Database,
  sessionId: string,
  now: number,
): Promise<"ok" | "full"> {
  const updated = await db.prepare(
    "UPDATE founding_sales SET status = 'paid' WHERE stripe_session_id = ?1 AND status != 'paid'",
  ).bind(sessionId).run();
  if (changes(updated) > 0) return "ok";
  const existing = await db.prepare(
    "SELECT status FROM founding_sales WHERE stripe_session_id = ?1",
  ).bind(sessionId).first<{ status: string }>();
  if (existing?.status === "paid") return "ok";
  const id = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT INTO founding_sales (id, stripe_session_id, status, created_at)
     SELECT ?1, ?2, 'paid', ?3
     WHERE (SELECT COUNT(*) FROM founding_sales WHERE status = 'paid') < ?4
       AND NOT EXISTS (SELECT 1 FROM founding_sales WHERE stripe_session_id = ?2)`,
  ).bind(id, sessionId, now, FOUNDING_BUYER_CAP).run();
  return changes(inserted) > 0 ? "ok" : "full";
}
