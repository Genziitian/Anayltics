-- Stricter owner sign-in (see src/server/auth.ts), adapted from Open Analytics.
--  login_attempts: every sign-in attempt, kept 30 days. Counts toward the locks.
--  login_blocks:   a network (IP) that keeps getting the password wrong. Each new lock lasts twice as long
--                  as the last, up to a day.
--  auth_state:     session_epoch is part of every sign-in cookie; changing it signs out every device.
CREATE TABLE login_attempts (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  ip TEXT NOT NULL,
  ok BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, ts);
CREATE INDEX login_attempts_ts ON login_attempts (ts);

CREATE TABLE login_blocks (
  ip TEXT PRIMARY KEY,
  strikes INTEGER NOT NULL,
  blocked_until BIGINT NOT NULL
);

CREATE TABLE auth_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Browsers the owner uses the dashboard from, as a hash of IP + user agent (the raw IP is never stored).
-- Tracking events from these aren't counted, so the owner testing their own site doesn't skew the stats.
CREATE TABLE owner_devices (
  fp TEXT PRIMARY KEY,
  seen_at BIGINT NOT NULL
);

DROP TABLE login_failures;
