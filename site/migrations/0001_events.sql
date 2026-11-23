-- First-party page events and Stripe checkout completions.
-- Aggregates are the counts. Raw session ids stay in this table.

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  variant TEXT,
  offer TEXT NOT NULL,
  cta TEXT,
  session_id TEXT,
  client_reference_id TEXT,
  stripe_event_id TEXT,
  ts INTEGER,
  props TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX events_name ON events (name);
CREATE INDEX events_name_cta_variant ON events (name, cta, variant);
CREATE UNIQUE INDEX events_stripe_event_id ON events (stripe_event_id) WHERE stripe_event_id IS NOT NULL;
