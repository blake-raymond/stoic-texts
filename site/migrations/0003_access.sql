-- Lifetime access, reply counts, the daily spend guard, and chat rate limits.
-- Email addresses are stored only as hashes.

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  email_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_access_grants_email ON access_grants (email_hash, created_at);

CREATE TABLE usage_counters (
  subject TEXT NOT NULL,
  period TEXT NOT NULL,
  replies INTEGER NOT NULL,
  PRIMARY KEY (subject, period)
);

CREATE TABLE spend_daily (
  day TEXT PRIMARY KEY,
  micro_usd INTEGER NOT NULL
);

CREATE TABLE chat_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE access_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
