# GI Tracker

Revenue-first, self-hosted web analytics for Indian businesses. GI Tracker shows where visitors came from
(an Instagram reel, a WhatsApp forward, a Google search, ChatGPT…), what they did, and **which source made you money**:
every Razorpay (India) and Dodo Payments (international) payment is linked to the visitor who paid. Payments in other
currencies are converted to your site's currency at that day's exchange rate.

It combines [Minilytics](https://github.com/surendrapandar/minilytics) and
[Open Analytics](https://github.com/punyakrit/open-analytics) (both MIT), rebuilt to run on a Node + Postgres VPS
instead of Cloudflare, with Razorpay as the built-in payment integration.

## What it tracks

- **Visitors, revenue (and revenue after Razorpay fees), conversion rate, revenue per visitor, bounce rate, session time,
  online now**, each compared with the previous period
- A chart of visitors (line) and revenue (bars), hourly, daily, weekly or monthly
- **Where visitors come from:** channel, referrer (Instagram, WhatsApp, Google, YouTube, ChatGPT…, including Android
  app referrers), campaign (`utm_campaign`), keyword, `?ref=` tags
- **Where they are and what they use:** country, state, city (bundled GeoIP database), browser, OS, device
- **What they did:** pages, entry pages, exit links, button clicks and custom goals, funnels
- **Who paid:** a Journey list of every Razorpay payment with its source, amount, how it was matched, and a full
  visitor timeline (visit → pages → clicks → payment)
- Click any row to filter the whole dashboard, for example "only visitors from the Diwali reel"
- **Live globe** (the Live map button): everyone on your site right now, what they open, and payments as they happen
- **AI crawlers:** which AI assistants (ChatGPT, Claude, Perplexity…), search engines and training crawlers read your
  pages, and which pages (Settings → AI crawlers has the snippet for your site's server)
- **Visitor profiles:** where someone came from, every page and action by day, what they spent
- **All websites at a glance,** with sparklines; light and dark mode
- **Public read-only dashboards,** per site, if you want to share your numbers (Settings → Sharing)

## How payments are matched to visitors

GI Tracker tries these in order and records which one worked (shown in the Journey tab):

1. **Notes / metadata.** The tracking script adds `gi_visitor_id` / `gi_session_id` to the `notes` of every Razorpay
   Checkout on your site, and to Dodo checkout links, with no code changes. Orders, subscriptions and checkout sessions
   created on your server can add them too.
2. **Payment id seen in the browser.** The Razorpay Checkout success handler reports the payment id, and a return page
   with `?razorpay_payment_id=…` (Razorpay) or `?payment_id=…` (Dodo) does the same, even if your page removes it from
   the address bar right away.
3. **Same customer as an earlier payment.** Customer id, email or phone. This is how subscription renewals are linked.
4. **Email or phone** of a visitor you `identify()`.
5. **Timing.** Exactly one visitor opened checkout or clicked a Razorpay link shortly before the payment. If it's
   ambiguous, GI Tracker leaves the payment unlinked rather than guessing.

Credit goes to the visitor's last visit that came from a source (not "Direct"). So "saw a reel, came back directly two
weeks later and paid" is credited to Instagram.

## Run it locally

You need Node.js 20+ and Postgres 14+.

```sh
npm install
createdb gitracker_dev
cp .env.example .env          # set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
npm run geoip:download        # optional: visitor locations (~130 MB)
npm run dev                   # API on :8787, dashboard on http://localhost:5173
npm run seed                  # optional: 35 days of demo data ("GI Demo Store")
```

Tests:

```sh
npm test                                                     # unit tests (incl. the tracker's Razorpay wrapper)
RAZORPAY_API_BASE=http://localhost:8799 npm run dev:api      # in one terminal
npm run smoke                                                # in another: end-to-end webhooks + attribution
```

## Deploy on a VPS (Hostinger or any Ubuntu server)

Everything runs in Docker Compose: Postgres, GI Tracker, and Caddy for automatic HTTPS. A 16 GB VPS handles tens of
millions of events. The Postgres settings in `docker-compose.yml` are tuned for that size.

1. **DNS:** add an `A` record, e.g. `analytics.yourdomain.in`, pointing to the VPS IP.
2. **Firewall:** in hPanel → VPS → Firewall (and `ufw`, if enabled), allow ports 22, 80 and 443.
3. **Install Docker** on the VPS. On Hostinger you can pick the "Ubuntu 24.04 with Docker" template, or run:
   ```sh
   curl -fsSL https://get.docker.com | sh
   ```
4. **Copy the project** to the server, e.g. `/opt/gi-tracker`, either with `git clone` from your own repository or with
   ```sh
   rsync -av --exclude node_modules --exclude dist --exclude build --exclude data --exclude .env ./ root@YOUR_VPS_IP:/opt/gi-tracker/
   ```
5. **Configure:**
   ```sh
   cd /opt/gi-tracker
   cp .env.example .env
   nano .env   # DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD (openssl rand -hex 24)
   ```
   GI Tracker refuses to start in production without `ADMIN_EMAIL`, with `ADMIN_PASSWORD=change-me` or a password
   under 10 characters, or with a `SESSION_SECRET` under 32 characters.
6. **Start:**
   ```sh
   docker compose up -d --build
   docker compose logs -f app      # "GI Tracker listening…"
   ```
   Open `https://analytics.yourdomain.in/admin-login`, sign in, and add your website.
7. **Backups:** add the daily backup to cron (`crontab -e`):
   ```
   0 3 * * * cd /opt/gi-tracker && ./scripts/backup.sh >> backups/backup.log 2>&1
   ```
   Copy `backups/` off the server now and then. Restore with
   `gunzip -c backups/FILE.sql.gz | docker compose exec -T postgres psql -U gitracker -d gitracker`.

**Updating:** copy the new code over, then run `docker compose up -d --build`. Database migrations run automatically on
start.

**Monitoring:** `https://analytics.yourdomain.in/api/health` returns `{"ok":true}` when the app and database are up.
Point a free uptime monitor (e.g. UptimeRobot) at it. `docker compose ps` shows the same status.

**Behind Cloudflare?** Set `CLIENT_IP_HEADER=cf-connecting-ip` in `.env`. Visitor locations come from the bundled
GeoIP database either way.

## Sign-in security

You sign in at **`/admin-login`** with `ADMIN_EMAIL` + `ADMIN_PASSWORD` from `.env`. Nothing links to that page on
purpose; logged out, `/` shows only the sites you've made public. This is adapted from
[Open Analytics](https://github.com/punyakrit/open-analytics):

- **Lockout:** after 5 wrong attempts from one network, sign-in locks for 15 minutes. Each repeat lock lasts twice as
  long, up to a day. Attempts are counted before the password is checked, so parallel guessing can't get around this.
- **Global pause:** after 30 wrong attempts across all networks, only browsers that have signed in before can try.
- **No timing hints:** every answer takes the same minimum time, and it never says whether the email or the password
  was wrong.
- **Session cookies:** 7 days, `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix. Sign-in only works from the
  dashboard itself.
- **Signing out:** "Sign out everywhere" ends every session. Changing the email or password in `.env` (and restarting)
  does the same.

Browsers you use the dashboard from are remembered for 30 days (as a hash of IP + browser), and their visits to your
tracked sites aren't counted, so your own testing doesn't skew the numbers. Set `EXCLUDE_OWNER_VISITS=false` to count
them.

## Set up a website

In the dashboard, add the site, then open **Settings** for it:

1. **Install the script** on every page:
   ```html
   <script defer data-website-id="SITE_ID" src="https://analytics.yourdomain.in/js/gi.js"></script>
   ```
2. **Connect Razorpay.** In Razorpay → Accounts & Settings → Webhooks, add
   `https://analytics.yourdomain.in/api/webhooks/razorpay/SITE_ID` with a secret, and tick these events:
   `payment.captured`, `order.paid`, `subscription.charged`, `payment_link.paid`, `invoice.paid`, `refund.processed`.
   Then paste the same secret in GI Tracker. Do this in both Test and Live mode.
3. **Payment Links / Pages:** set the redirect (callback) URL to a page on your site that loads the script.
4. **Dodo Payments** (optional, e.g. for USD sales): in Dodo → Developer → Webhooks, add
   `https://analytics.yourdomain.in/api/webhooks/dodo/SITE_ID` with `payment.succeeded` and `refund.succeeded`, and
   paste its `whsec_…` secret in Settings → Payments → Dodo Payments. Checkout links are tagged automatically; if your
   site opens Dodo checkout from JavaScript, wrap the address:
   ```js
   window.location.href = window.gitracker?.checkoutUrl ? window.gitracker.checkoutUrl(url) : url;
   ```
5. **Optional Razorpay API keys** (Key ID + Secret). With these, GI Tracker imports up to a year of past payments and
   re-checks the last 48 hours every hour, in case a webhook was missed. They are stored in your database, and Razorpay
   keys have full account access, so keep the server secure.

Settings also has a **"Copy AI prompt"** button. Paste the prompt into Claude Code, Cursor or a similar tool opened in
your website's codebase, and it does steps 1, 3, user identification and goal tracking for you.

## Tracker API

```html
<!-- Click goals, no JS needed -->
<button data-gi-goal="signup_click">Get started</button>
<a href="/pricing" data-gi-goal="pricing_click" data-gi-goal-plan="pro">Pricing</a>

<script>
  window.gitracker('goal', 'signup', { plan: 'pro' });
  // After login: links visits to the person, and matches Razorpay payments by email/phone
  window.gitracker('identify', { user_id: '123', email: 'priya@acme.in', phone: '9876543210', name: 'Priya' });
  // For orders created on your server from another domain: send these and put them in the order notes
  window.gitracker.razorpayNotes(); // { gi_visitor_id, gi_session_id }
  // Opening a Dodo checkout from JavaScript: returns the address tagged with the visitor
  window.gitracker.checkoutUrl('https://checkout.dodopayments.com/buy/pdt_…');
</script>
```

Script attributes:

- `data-api="/stats/event"` sends events through your own domain, which helps against ad blockers. Settings shows a
  Next.js rewrite for this.
- `data-razorpay="false"` turns off Checkout instrumentation.
- `data-allow-localhost` tracks while you test locally.

Visit any page with `?gi_ignore=true` to exclude your own browser.

Server-side API (Bearer = the site's API key from Settings):

- `POST /api/v1/payments` records a payment from any other provider:
  `{ transaction_id, amount: 499.00, currency, visitor_id, email, phone }`
- `POST /api/v1/goals` records a goal from your backend: `{ visitor_id, name }`

## Privacy

GI Tracker sets two first-party cookies (`gi_vid` for one year, `gi_sid` for a 30-minute session). It doesn't use
fingerprinting and stores no IP addresses: IPs are used only for the location lookup and the login lockout. Personal
fields in page URLs (`email`, `phone`, `token`…) are removed in the browser before anything is sent. Email and phone
are stored only when you `identify()` a visitor or a payment includes them. Data stays on your own server. Under
India's DPDP Act, mention analytics and payment attribution in your privacy policy.

## Project layout

```
src/server/      Hono API on Node: ingest (collect.ts), attribution (payments.ts), Razorpay (razorpay.ts), stats, auth
src/dashboard/   React + Vite dashboard
src/shared/      traffic source classifier
public/js/gi.js  the tracking script (~2.5 KB gzipped)
migrations/      Postgres schema (applied automatically on start)
scripts/         smoke test, demo seed, GeoIP download, backups
```

## Credits

- [Minilytics](https://github.com/surendrapandar/minilytics) by Surendra Pandar (MIT): the base of this project
- [Open Analytics](https://github.com/punyakrit/open-analytics) (MIT): the dashboard design, live globe, AI-crawler
  tracking, public dashboards, sign-in hardening and own-visit exclusion
- Map tiles by [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, data © OpenStreetMap contributors
- IP geolocation by [DB-IP.com](https://db-ip.com) (CC BY 4.0)
- Exchange rates: European Central Bank reference rates via [Frankfurter](https://frankfurter.dev)
