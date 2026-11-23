-- Subscription status and the founding-lifetime cap.
-- kind is founding or subscription. status active and trialing can talk.
-- Founding reservations older than a day are not a sale.

ALTER TABLE access_grants ADD COLUMN kind TEXT NOT NULL DEFAULT 'founding';
ALTER TABLE access_grants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE access_grants ADD COLUMN stripe_subscription_id TEXT;

CREATE UNIQUE INDEX idx_access_grants_subscription ON access_grants (stripe_subscription_id);

CREATE TABLE founding_sales (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT UNIQUE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
