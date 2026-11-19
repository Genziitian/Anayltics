-- Dodo Payments (webhooks), next to Razorpay. Ported from Minilytics / Open Analytics.
ALTER TABLE sites ADD COLUMN dodo_webhook_secret TEXT;
-- Optional: only count payments for these Dodo product ids (comma-separated), when one Dodo account sells
-- several products and each webhook receives every payment.
ALTER TABLE sites ADD COLUMN dodo_product_ids TEXT;

-- Payments in another currency are converted to the site's currency at that day's rate (see lib/fx.ts).
-- The amount the buyer actually paid is kept here.
ALTER TABLE payments ADD COLUMN orig_amount BIGINT;
ALTER TABLE payments ADD COLUMN orig_currency TEXT;
ALTER TABLE payments ADD COLUMN product_id TEXT;

-- Daily exchange rates (European Central Bank, via Frankfurter), cached so each day is fetched once.
CREATE TABLE fx_rates (
  day TEXT NOT NULL,      -- YYYY-MM-DD
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (day, base, quote)
);
