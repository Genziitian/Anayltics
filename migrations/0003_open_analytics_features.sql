-- Features merged from Open Analytics (github.com/punyakrit/open-analytics).

-- Approximate visitor location (city level, rounded to ~1 km) for the live globe.
ALTER TABLE sessions ADD COLUMN lat REAL;
ALTER TABLE sessions ADD COLUMN lon REAL;

-- Sites the owner chose to show on a public, read-only dashboard (no login needed to view).
ALTER TABLE sites ADD COLUMN public BOOLEAN NOT NULL DEFAULT FALSE;

-- Visits from search engines and AI crawlers (src/shared/bots.ts). They aren't people, so they never count
-- as visitors. They arrive from the site's own server (POST /api/v1/crawls) or, for the few crawlers that run
-- JavaScript, from the tracking script. Kept about a year.
CREATE TABLE crawls (
  id BIGSERIAL PRIMARY KEY,
  site_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  agent TEXT NOT NULL,   -- the crawler's user-agent token, e.g. GPTBot
  kind TEXT NOT NULL,    -- answers | indexing | training
  path TEXT NOT NULL,
  country TEXT
);
CREATE INDEX crawls_site_time ON crawls (site_id, ts);

-- Where sign-in attempts came from, for Settings → Sign-in security.
ALTER TABLE login_attempts ADD COLUMN country TEXT;

-- "Online now" looks at recent pageviews and goals.
CREATE INDEX events_recent ON events (site_id, ts) WHERE type IN ('pageview', 'goal');
