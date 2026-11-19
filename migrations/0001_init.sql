-- GI Tracker schema (Postgres). Timestamps are BIGINT milliseconds since the epoch, money is BIGINT minor units (paise).

-- Websites you track. One row per site.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency TEXT NOT NULL DEFAULT 'INR',
  api_key TEXT NOT NULL UNIQUE,
  razorpay_webhook_secret TEXT,
  razorpay_key_id TEXT,
  razorpay_key_secret TEXT,
  razorpay_synced_at BIGINT,
  created_at BIGINT NOT NULL
);

-- Anyone with a visitor cookie. Identity fields are filled by identify() or by a payment.
CREATE TABLE visitors (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_seen BIGINT NOT NULL,
  user_id TEXT,
  name TEXT,
  email TEXT,
  phone TEXT, -- digits only, last 10 (matches Razorpay's "contact")
  PRIMARY KEY (site_id, id)
);
CREATE INDEX visitors_email ON visitors (site_id, email) WHERE email IS NOT NULL;
CREATE INDEX visitors_phone ON visitors (site_id, phone) WHERE phone IS NOT NULL;

-- A visit (30 minutes of inactivity ends it). Holds the attribution for that visit.
CREATE TABLE sessions (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  duration BIGINT NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  hostname TEXT,
  entry_page TEXT,
  exit_page TEXT,
  referrer TEXT,
  referrer_domain TEXT,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  ref TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  browser TEXT,
  os TEXT,
  device TEXT,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX sessions_site_time ON sessions (site_id, started_at);
CREATE INDEX sessions_visitor ON sessions (site_id, visitor_id, started_at);
CREATE INDEX sessions_online ON sessions (site_id, last_seen_at);

-- Pageviews, goals (custom events / button clicks) and outbound link clicks.
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  path TEXT,
  props TEXT
);
CREATE INDEX events_site_time ON events (site_id, ts);
CREATE INDEX events_session ON events (site_id, session_id);
CREATE INDEX events_visitor ON events (site_id, visitor_id, ts);
CREATE INDEX events_type_time ON events (site_id, type, ts);

-- Payments from Razorpay (webhooks / API sync) or the generic payments API. Refunds are rows with negative amounts.
CREATE TABLE payments (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ts BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'payment', -- 'payment' or 'refund'
  currency TEXT NOT NULL,
  fee BIGINT, -- gateway fee incl. GST, in the same currency as amount
  tax BIGINT, -- GST part of the fee
  method TEXT, -- upi, card, netbanking, wallet, emi…
  visitor_id TEXT,
  session_id TEXT,
  customer_id TEXT,
  email TEXT,
  phone TEXT,
  name TEXT,
  order_id TEXT,
  subscription_id TEXT,
  renewal INTEGER NOT NULL DEFAULT 0,
  matched_by TEXT, -- metadata, return_page, customer, email, phone, timing
  PRIMARY KEY (site_id, id)
);
CREATE INDEX payments_site_time ON payments (site_id, ts);
CREATE INDEX payments_customer ON payments (site_id, customer_id);
CREATE INDEX payments_email ON payments (site_id, email);
CREATE INDEX payments_visitor ON payments (site_id, visitor_id);
CREATE INDEX payments_order ON payments (site_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payments_subscription ON payments (site_id, subscription_id) WHERE subscription_id IS NOT NULL;

-- Payment, order or subscription ids seen in the browser: from the Razorpay Checkout handler, or on a return page
-- (?razorpay_payment_id=…). Links a payment to the visitor even when notes are missing.
CREATE TABLE payment_claims (
  site_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (site_id, payment_id)
);

-- Webhook deliveries already processed (Razorpay retries, and sends the same payment in several events).
CREATE TABLE webhook_events (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, provider, event_id)
);

CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Failed dashboard logins, used to slow down password guessing.
CREATE TABLE login_failures (
  ip TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX login_failures_ip ON login_failures (ip, ts);
