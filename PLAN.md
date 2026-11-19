# Revenue-first Web Analytics with Razorpay: Build Plan

> **Status (2026-11-19): GI Tracker = Minilytics + Open Analytics, on Node/Postgres with Razorpay.** Phases 0–2 are
> built, plus from Open Analytics: its dashboard design (dark mode, sparklines), live globe, AI-crawler tracking, public
> dashboards and hardened sign-in. Left out on purpose: Stripe, Dodo, DataFast import, paid hosted plans.
> Decisions that changed from this plan:
> - **Postgres only, no ClickHouse yet.** GI Tracker starts from Minilytics, which updates session rows on every pageview.
>   ClickHouse handles that pattern badly, and Postgres on the 16 GB Hostinger VPS covers tens of millions of events.
>   Revisit ClickHouse (section 2) if the dashboard gets slow at scale. All stats queries live in `src/server/stats.ts`.
> - **One admin account (email + password, hardened as in Open Analytics).** Teams, multi-user auth and a hosted
>   SaaS come later.
> - **Self-hosted first**, on one VPS with Docker Compose + Caddy.
> - Not built yet: Razorpay OAuth, MRR/churn views, realtime WebSocket view, email reports, MCP/public API, a billing
>   page for selling GI Tracker itself.

**Goal:** a privacy-friendly, lightweight analytics tool that answers one question better than anything else does for
Indian businesses: *which traffic source, campaign and page made me money?* It matches every Razorpay payment to the
visitor who made it and their journey on the site.

---

## 1. What we take from each reference repo

All four repos are MIT-licensed, so code can be adapted with attribution.

| Repo | Stack | What's worth stealing | What to avoid |
|---|---|---|---|
| **minilytics** | CF Workers + D1 + Hono + React | The whole **revenue model**: payment attribution cascade (`metadata → return_page → customer → email → timing`), `payment_claims` table, last-non-direct-touch credit, renewals detection, "Journey" timeline per customer, generic payments API, channel/source classifier (`src/shared/sources.ts`) | D1/SQLite as the only store: it won't scale past small sites. Single-tenant, password login only. |
| **traks** | CF Workers + Durable Objects + Pipelines + Iceberg/R2 SQL | **Hot/cold split** (live data in a fast store, history in a columnar store), realtime WebSocket push, **AI-assistant source detection** (`ai-sources.ts`), bot vs AI-agent classification (`bots.ts`), timezone bucket keys computed at ingest, daily-rotating HMAC visitor hash, MCP tools for agents | Heavy Cloudflare beta stack (Pipelines, R2 SQL): fragile to self-host, hard to debug. |
| **umami** | Next.js + Prisma + Postgres **or ClickHouse** (+ Kafka) | **ClickHouse event schema** and query library (`src/queries/sql/*`: funnels, retention, journeys, attribution, UTM, revenue), click-ID capture (gclid/fbclid/…), web vitals, teams/RBAC, share links, API keys, filters system | Its revenue support is just a `revenue` event property with no payment-provider integration and no matching. It's big, so don't fork it wholesale. |
| **fathom (lite)** | Go + SQL | **Pre-aggregated rollups** (site/page/referrer stats per hour) so dashboards are instant; radically simple UI; referrer blacklist | No sessions or events, too minimal. |

**Positioning:** Umami's breadth + Traks' realtime + Fathom's simplicity + Minilytics' revenue attribution, built
**Razorpay-native**: paise, INR/GST, UPI, Payment Links/Pages, Subscriptions, fees and net settlement.

---

## 2. Architecture

```
customer site
  └─ tracker.js (<2 KB gz, cookieless option)      Razorpay
       │ POST /e  (sendBeacon)                        │ webhooks (payment.captured, refund.processed, subscription.charged…)
       ▼                                              ▼
┌──────────────── Ingest API (Hono on Node/Bun) ───────────────┐
│ validate site + domain · bot/AI-agent filter · UA/geo parse   │
│ source/channel classify · visitor id · session stitching      │
└───────┬──────────────────────────────┬────────────────────────┘
        │ batch insert (async buffer)  │ payments: verify sig → dedupe → attribute
        ▼                              ▼
   ClickHouse (events, sessions)   Postgres (users, teams, sites, payments,
   + materialized-view rollups      subscriptions, razorpay_connections, goals, funnels)
        │                              │
        └────────── Dashboard API ─────┘── Redis (realtime "online now", rate limits, queue)
                        │
                 Dashboard (React + Vite SPA, Recharts/ECharts)
```

**Stack decisions (recommended):**

- **Language:** TypeScript end to end, as a pnpm + Turborepo monorepo (the Traks layout).
- **Events store: ClickHouse from day one.** Umami proves the schema works, and moving off Postgres/SQLite later is
  painful. Use `ReplacingMergeTree` for sessions, `MergeTree` for events, and materialized views for hourly rollups
  (Fathom's idea, done natively).
- **Metadata + money: Postgres.** Payments need transactions, unique constraints and idempotency, not a columnar store.
  Payments are mirrored into ClickHouse for revenue-by-dimension queries.
- **API:** Hono, which runs on Node, Bun or Workers, so ingest can move to the edge later.
- **Auth:** Better Auth (email + Google login, teams, API keys). Same choice as Traks.
- **Hosting:** AWS/GCP **Mumbai region** for data residency under the DPDP Act 2023. ClickHouse Cloud or self-managed. Ship a
  `docker-compose.yml` for self-hosting (the Umami/Fathom model).
- **Queue:** Redis streams (or BullMQ) for webhook processing, re-matching and backfills.

---

## 3. Data model (core)

**ClickHouse**

```sql
events (site_id, ts, event_id, visitor_id, session_id, type /*pageview|goal|outbound|identify|vital*/,
        name, path, query, title, hostname, props Map(String,String),
        referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        ref, gclid, fbclid, country, region, city, browser, os, device, screen, lang,
        date_key, hour_key)                     -- bucket keys in the site's timezone (Traks)
  ENGINE = MergeTree ORDER BY (site_id, ts) PARTITION BY toYYYYMM(ts)

sessions (... entry_page, exit_page, pageviews, duration, goals, is_bounce, first-touch attribution fields ...)
  ENGINE = ReplacingMergeTree(last_seen_at) ORDER BY (site_id, session_id)

payments_ch  -- mirror of Postgres payments joined to the credited session's attribution, for fast breakdowns
mv_hourly_site_stats, mv_hourly_page_stats, mv_hourly_source_stats  -- rollups
```

**Postgres**

```sql
sites(id, team_id, domain, timezone, currency DEFAULT 'INR', public_key, privacy_mode, ...)
razorpay_connections(site_id, mode /*webhook|oauth*/, account_id, webhook_secret_enc, oauth_tokens_enc, last_sync_at)
visitors(site_id, visitor_id, first_seen, user_id, email_hash, phone_hash, name)
payments(id /*pay_xxx*/, site_id, provider, kind /*payment|refund*/, amount_minor, currency,
         amount_base_minor /*converted to site currency*/, fee_minor, tax_minor, method /*upi|card|netbanking|wallet*/,
         order_id, subscription_id, invoice_id, payment_link_id, customer_id, email_hash, phone_hash,
         visitor_id, session_id, matched_by, match_reason, is_renewal, ts,
         UNIQUE(site_id, id))
payment_claims(site_id, provider_ref /*pay_/order_/sub_/plink_ id*/, visitor_id, session_id, ts)
webhook_events(provider, event_id PRIMARY KEY, received_at, payload, status)   -- idempotency + replay
subscriptions(id /*sub_xxx*/, site_id, plan_id, status, visitor_id, mrr_minor, started_at, cancelled_at)
goals, funnels, share_links, api_keys, teams, memberships
```

Store money as **integer minor units (paise)**, never floats (Minilytics does this too).

---

## 4. Razorpay integration (the differentiator)

### 4.1 Connecting an account

1. **MVP: webhook mode.** The user pastes a webhook secret. We show them the URL
   `https://api.<you>/webhooks/razorpay/:siteId` and the list of events to tick.
2. **v2: OAuth "Connect with Razorpay"** (Razorpay Partner / Technology Partner program). One click, no copy-paste. We
   register the webhooks through the API and can **backfill historical payments** via `GET /v1/payments?from=&to=`
   (paginate `count=100&skip=`). Apply to the partner program early, because approval takes time.

### 4.2 Webhooks to handle

| Event | Action |
|---|---|
| `payment.captured` | Record payment, run attribution |
| `order.paid` | Same (dedupe on payment id); carries order `notes` |
| `payment_link.paid` | Payment Links / Pages revenue |
| `subscription.activated` / `subscription.charged` | Create subscription; renewals → `is_renewal=true`, credited to the original acquisition source |
| `subscription.cancelled` / `halted` / `completed` | Churn metrics |
| `refund.processed` | Negative-amount row linked to the original payment's visitor |
| `payment.failed` | Optional: "checkout started but failed" funnel step |

**Security and reliability:**

- Verify `X-Razorpay-Signature` = HMAC-SHA256(raw body, webhook secret) with a constant-time compare.
- Dedupe on the `x-razorpay-event-id` header via the `webhook_events` table.
- Return `200` immediately and process from the queue.
- Run a **daily reconciliation job** that calls the Payments API for the last 48h and inserts anything a missed webhook
  dropped.

### 4.3 Matching a payment to a visitor (adapted from minilytics `payments.ts`)

Try the most reliable signal first and store `matched_by` + `match_reason` so the user can see *why*:

1. **`notes`**: `wa_visitor_id` / `wa_session_id` on the order, payment or subscription. This is the best signal.
   - **Auto-inject:** the tracker wraps `window.Razorpay` so every `new Razorpay(options)` gets
     `options.notes.wa_vid/wa_sid` added (respecting Razorpay's 15-note limit). This needs zero code changes from
     the merchant.
   - **Server-side helper:** `analytics.razorpayNotes()` returns `{ wa_vid, wa_sid }` so backends can add it at
     `orders.create`. We ship snippets for Node, Python, PHP and Next.js.
2. **Checkout handler claim:** the tracker also wraps `options.handler` and sends a `claim` event with
   `razorpay_payment_id` / `razorpay_order_id` / `razorpay_subscription_id` → `payment_claims`.
3. **Return/callback page claim:** on any page whose URL has `razorpay_payment_id` or `razorpay_payment_link_id` (the
   Payment Link/Page `callback_url`), auto-claim.
4. **Customer match:** the same `customer_id` / email / phone paid before. This also marks it as a renewal.
5. **Identify match:** the email or phone hash matches a visitor sent through `analytics.identify()`. Razorpay always
   provides `contact`, which is useful for UPI-heavy Indian traffic.
6. **Timing fallback:** exactly one visitor clicked a `rzp.io`, `pages.razorpay.com` or `razorpay.me` link, or a
   checkout goal, in the window before payment. Prefer visitors who came back right after paying. Never guess when two
   or more visitors are candidates.

**Credit model:** default is last non-direct touch (Minilytics). Also offer **first touch** and **linear multi-touch** as
a dashboard toggle. The ClickHouse session table makes this a query, not a re-ingest.

### 4.4 Revenue metrics

- Gross revenue, refunds, **net revenue after Razorpay fees and GST** (from the `fee` and `tax` fields; no other analytics
  tool shows this).
- Revenue per visitor, conversion rate, average order value, time-to-convert, payments by method (UPI vs card vs
  netbanking).
- Subscriptions: MRR, new MRR by source, churn, **LTV by acquisition source/campaign**.
- Every breakdown table (source, campaign, page, country, device, entry page) gets a revenue column + revenue/visitor.
- Customer Journey: visit → pages → clicks → checkout → payment timeline (the Minilytics VisitorModal).
- Multi-currency: store original + converted-to-site-currency (daily FX rates table).

### 4.5 Other providers later

Use one internal `PaymentInput` interface (as in Minilytics) and add provider adapters: Stripe, Cashfree, PayU,
Dodo, LemonSqueezy. Also keep Minilytics' **generic `POST /api/v1/payments`** for anything else.

---

## 5. Tracker script (`packages/tracker`)

- Target <2 KB gzipped, `sendBeacon` with a `fetch keepalive` fallback, no dependencies.
- Auto: pageviews (including SPA `pushState`/`popstate`), outbound clicks, file downloads, `data-goal="signup"`
  click goals, scroll depth, engagement time pings, optional web vitals (Umami).
- Captures UTMs, `?ref=`, `gclid`/`fbclid`/`msclkid`.
- API: `track(name, props)`, `identify({ user_id, email, phone })`, `razorpayNotes()`, plus the Razorpay
  auto-instrumentation (behind the `data-razorpay="true"` attribute, on by default).
- **Visitor identity has two modes. This is a deliberate trade-off:**
  - **Standard (default):** a first-party random ID (cookie/localStorage, 1 year). It's needed to credit a payment on
    day 17 to a tweet seen on day 1.
  - **Privacy mode:** no storage. Uses the daily-rotating `HMAC(secret+date, ip+ua+site)` (Traks/Plausible). Revenue
    still attributes via `notes` within the same day, but cross-day attribution is lost. The UI states this clearly.
- **Ad-blocker resilience:** serve from a custom subdomain (CNAME) or provide proxy snippets for Next.js, Vercel,
  Cloudflare and Nginx (Minilytics does this).
- Respect DNT/GPC as an option and exclude the owner's own visits.

---

## 6. Dashboard features

**MVP**

- Overview cards with % change: visitors, pageviews, **revenue**, conversion rate, revenue/visitor, bounce, session time,
  online now.
- Combined chart: visitors as a line, revenue as bars. Hour/day/week/month granularity.
- Date ranges with prev/next stepping and comparison to the previous period.
- Panels: Channels / Sources / Campaigns / Referrers (with AI assistants like ChatGPT, Perplexity, Gemini and Claude as
  their own channel), Pages / Entry / Exit, Countries / Regions / Cities, Browser / OS / Device, Goals.
- Click any row to filter the whole dashboard (stackable filters, URL-encoded so views are shareable).
- Payments / Customers list with the journey modal and `matched_by` badge. "Unmatched payments" list with a
  "retry matching" button.
- Multi-site, team invites, public share link, CSV export.

**v2**

- Funnels with revenue as the final step, retention cohorts, user journeys/paths (port Umami's queries).
- Realtime view over WebSocket (Traks): live visitors, live payments ticker, India/world map.
- Weekly email reports ("₹42,300 this week, 61% from Instagram").
- Alerts: traffic spike, payment drop, webhook failing.
- Public REST API + **MCP server** so AI agents can query analytics (Umami and Traks both have this).
- AI insights: "Ask your data", plus a prompt export like Minilytics' `aiPrompt.ts`.
- Google Search Console import, annotations, goals by URL pattern.

**Later:** session replay (Umami has a recorder), heatmaps, A/B test revenue, WordPress/Shopify/WooCommerce plugins.

---

## 7. Monorepo layout

```
apps/
  ingest/        Hono: /e (events), /webhooks/razorpay/:siteId, /api/v1/payments, /api/v1/goals
  api/           Hono: dashboard API, auth, queries, share links, public API, MCP
  web/           React + Vite dashboard
  worker/        queue consumers: webhook processing, rematch, reconciliation, backfill, email reports
  site/          marketing + docs (Astro)
packages/
  tracker/       tracker.js
  shared/        zod schemas, source/channel classifier, AI-source + bot lists, period/timezone math
  db/            Postgres (Drizzle) schema + migrations, ClickHouse migrations + query builders
  payments/      provider-agnostic PaymentInput, attribution engine, razorpay adapter (+ future adapters)
docker/          docker-compose: postgres, clickhouse, redis, api, ingest, web
```

---

## 8. Phased roadmap

These are estimates for one or two developers working full-time.

| Phase | Weeks | Deliverables | Done when |
|---|---|---|---|
| **0. Foundations** | 1 | Monorepo, docker-compose (PG + CH + Redis), CI, auth, sites CRUD, Drizzle + CH migrations | Can log in and create a site |
| **1. Core analytics** | 2–3 | Tracker, ingest (bots, UA, geo via MaxMind/IP2Location, classifier, sessions), CH schema + rollup MVs, overview + breakdown panels, filters, date ranges | Pageviews from a test site show up in the dashboard within 5s; dashboard p95 < 500 ms on 10M events |
| **2. Razorpay revenue** | 2–3 | Webhook endpoint (sig verify, idempotency, queue), Razorpay auto-instrumentation in tracker, attribution cascade, payments list + journey modal, revenue columns everywhere, refunds, net-of-fees | A test-mode Razorpay payment is attributed to the right UTM campaign via notes, handler claim, and Payment Link callback, each tested |
| **3. Subscriptions + polish** | 2 | Subscription events, MRR/churn/LTV by source, reconciliation job, unmatched payments rematch, share links, CSV export, onboarding wizard ("install script → connect Razorpay → verify") | Onboarding to first attributed payment takes < 10 min |
| **4. Launch (beta)** | 1 | Landing page, docs, pricing, **bill your own plans via Razorpay Subscriptions** (dogfood), status page, backups | 10 beta users with real revenue flowing |
| **5. v2** | ongoing | Razorpay OAuth + backfill, funnels/retention/journeys, realtime, email reports, alerts, API + MCP, AI insights, more providers | n/a |

---

## 9. Testing strategy

- **Attribution engine:** table-driven unit tests for each `matched_by` path and the ambiguous-timing "don't guess"
  cases. Port Minilytics' `test/core.test.ts` ideas.
- **Webhooks:** fixtures of real Razorpay test-mode payloads; signature failures; duplicate deliveries; out-of-order
  delivery (refund before payment).
- **Tracker:** Playwright against a demo site that uses real Razorpay Checkout in **test mode**, end to end:
  visit with UTM → pay → assert attribution.
- **Load:** k6 at 2k events/sec on ingest; seed script for 100M events to check query latency (Umami/Traks both have
  seed scripts).

---

## 10. Risks and decisions to make

| Risk | Mitigation |
|---|---|
| Merchants create orders server-side and `notes` from checkout options don't reach `order.paid` | Use payment-level notes + handler claim + callback claim, and document the server helper prominently |
| Ad-blockers drop the tracker, so payments go unmatched | Custom-domain/proxy setup in onboarding; email/phone/customer fallbacks; show the match rate on the dashboard |
| DPDP Act / privacy | Hash email/phone (store plaintext only when the user opts in to "show customer names"), India hosting, data deletion API, DPA, cookieless mode |
| Razorpay Partner approval delay | Webhook mode works without it; apply in week 1 |
| ClickHouse ops burden | Start on ClickHouse Cloud; self-host docs for docker users |
| Scope creep vs Umami | Stay revenue-first; only port Umami features that get a revenue column |

**Open decisions for you:**

1. **Hosted SaaS, self-hosted open source, or both?** I recommend open core: an MIT self-host version plus a paid
   cloud.
2. **Stack.** I recommend the Node + ClickHouse + Postgres stack above. The alternative is an all-Cloudflare stack
   (Minilytics/Traks style): cheaper at small scale, harder to scale analytics queries.
3. **Default identity mode.** I recommend first-party ID by default, because revenue attribution depends on it.
