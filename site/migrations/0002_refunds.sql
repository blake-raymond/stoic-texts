-- Hashed one-time refund codes and rate-limit counters. No email addresses.

CREATE TABLE refund_codes (
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_refund_codes_email ON refund_codes (email_hash, expires_at);

CREATE TABLE refund_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
