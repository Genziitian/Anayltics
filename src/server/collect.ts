import type { Context } from 'hono';
import { crawlerFor } from '../shared/bots';
import { classify } from '../shared/sources';
import { isOwnerVisit } from './auth';
import { recordCrawl } from './crawls';
import { db as defaultDb, type Db, type Statement } from './db';
import { getSite, type AppEnv, type Site } from './env';
import { clientIp, geoOf, type Geo } from './lib/net';
import { isBot, parseUA } from './lib/ua';
import { creditedSessionSql, normalizePhone } from './payments';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify', 'claim']);
const MAX_PING_MS = 10 * 60_000;

interface Payload {
  w: string;
  t: string;
  u: string;
  r?: string;
  vid: string;
  sid: string;
  sw?: number;
  n?: string;
  p?: Record<string, unknown>;
  d?: number;
}

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

/** Razorpay or Dodo payment / order / subscription ids, as seen in the checkout handler or on a return page. */
const RAZORPAY_ID = /^(pay|order|sub)_[A-Za-z0-9]{6,40}$/;

export function normalizePath(pathname: string): string {
  let p = pathname || '/';
  try {
    p = decodeURI(p);
  } catch {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500);
}

function stripWww(h: string) {
  return h.replace(/^www\./, '').toLowerCase();
}

/** Is `hostname` the site's domain or one of its subdomains? */
export function belongsTo(hostname: string, domain: string): boolean {
  const h = stripWww(hostname);
  const d = stripWww(domain);
  return h === d || h.endsWith('.' + d);
}

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  if (!body || !isId(body.w) || !TYPES.has(body.t) || !isId(body.vid) || !isId(body.sid)) return c.body(null, 400);

  const ua = c.req.header('user-agent') ?? '';
  const crawler = crawlerFor(ua);
  if (crawler || isBot(ua)) {
    // Crawlers that run JavaScript (Google, Bing and a few others) reach the script too. Their page loads are
    // counted as crawls, never as visitors.
    if (crawler && body.t === 'pageview') {
      const site = await getSite(defaultDb, body.w);
      let path: string | null = null;
      try {
        const u = new URL(body.u);
        if (site && belongsTo(u.hostname, site.domain)) path = u.pathname.slice(0, 500);
      } catch {}
      if (site && path) recordCrawl(defaultDb, site, ua, path, geoOf(c, clientIp(c)).country).catch(() => {});
    }
    return c.body(null, 202);
  }
  // The owner testing their own site isn't a visitor.
  if (await isOwnerVisit(c)) return c.body(null, 202);

  const site = await getSite(defaultDb, body.w);
  if (!site) return c.body(null, 404);

  let url: URL;
  try {
    url = new URL(body.u);
  } catch {
    return c.body(null, 400);
  }
  // Only accept data for the site's own domain, so nobody can pollute your stats from elsewhere.
  if (!belongsTo(url.hostname, site.domain)) return c.body(null, 403);

  await ingest(defaultDb, site, body, url, ua, geoOf(c, clientIp(c)), Date.now());
  return c.body(null, 202);
}

export async function ingest(db: Db, site: Site, body: Payload, url: URL, ua: string, geo: Geo, now: number) {
  const path = normalizePath(url.pathname);
  const { t, vid, sid } = body;

  if (t === 'ping') {
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    await db
      .prepare('UPDATE sessions SET duration = duration + ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
      .bind(ms, now, site.id, sid)
      .run();
    return;
  }

  if (t === 'identify') {
    const p = body.p ?? {};
    await db.batch([
      db.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(site.id, vid, now),
      db
        .prepare(
          `UPDATE visitors SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name),
             phone = COALESCE(?, phone) WHERE site_id = ? AND id = ?`,
        )
        .bind(
          clip(p.user_id, 128),
          clip(p.email, 200)?.toLowerCase() ?? null,
          clip(p.name, 128),
          normalizePhone(clip(p.phone, 32)),
          site.id,
          vid,
        ),
    ]);
    return;
  }

  // Razorpay Checkout's success handler fired in the browser: we now know exactly who paid.
  if (t === 'claim') {
    const p = body.p ?? {};
    const ids = [p.payment_id, p.order_id, p.subscription_id].filter((v): v is string => typeof v === 'string' && RAZORPAY_ID.test(v));
    if (ids.length) await db.batch(ids.flatMap((id) => claimPayment(db, site.id, vid, id, now)));
    return;
  }

  const existing = await db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, sid).first();

  const stmts: Statement[] = [];
  if (!existing) {
    stmts.push(...newSession(db, site, body, url, path, ua, geo, now));
  }

  if (t === 'pageview') {
    if (existing) {
      stmts.push(
        db
          .prepare('UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
          .bind(path, now, site.id, sid),
      );
    }
    stmts.push(insertEvent(db, site.id, sid, vid, now, 'pageview', null, path, null));
    for (const id of returnPageIds(url)) stmts.push(...claimPayment(db, site.id, vid, id, now));
  } else if (t === 'goal') {
    const name = clip(body.n, 64);
    if (!name) return;
    const props = body.p && typeof body.p === 'object' ? JSON.stringify(body.p).slice(0, 1000) : null;
    stmts.push(
      db.prepare('UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'goal', name, path, props),
    );
  } else if (t === 'outbound') {
    const target = clip(body.n, 500);
    if (!target) return;
    stmts.push(
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'outbound', target, path, null),
    );
  }
  await db.batch(stmts);
}

/**
 * Razorpay sends buyers back to your callback URL with ?razorpay_payment_id=pay_… (Payment Links, Payment Pages,
 * subscriptions and Checkout with a callback_url); Dodo adds ?payment_id=pay_… or ?subscription_id=sub_… to its
 * return URL. Seeing that on a pageview tells us which visitor paid.
 */
function returnPageIds(url: URL): string[] {
  const q = url.searchParams;
  return ['razorpay_payment_id', 'razorpay_order_id', 'razorpay_subscription_id', 'payment_id', 'subscription_id']
    .map((k) => q.get(k))
    .filter((v): v is string => !!v && RAZORPAY_ID.test(v));
}

function claimPayment(db: Db, siteId: string, vid: string, providerId: string, now: number): Statement[] {
  return [
    db
      .prepare('INSERT INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(siteId, providerId, vid, now),
    // The webhook may have arrived first; link that payment now if nothing else already did.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?, matched_by = 'return_page',
           session_id = (${creditedSessionSql()})
         WHERE site_id = ? AND (id = ? OR order_id = ? OR subscription_id = ?) AND visitor_id IS NULL`,
      )
      .bind(vid, siteId, vid, now + 60_000, siteId, providerId, providerId, providerId),
    db
      .prepare(
        `UPDATE visitors SET
           email = COALESCE(email, (SELECT email FROM payments WHERE site_id = ? AND visitor_id = ? AND email IS NOT NULL LIMIT 1)),
           phone = COALESCE(phone, (SELECT phone FROM payments WHERE site_id = ? AND visitor_id = ? AND phone IS NOT NULL LIMIT 1)),
           name = COALESCE(name, (SELECT name FROM payments WHERE site_id = ? AND visitor_id = ? AND name IS NOT NULL LIMIT 1))
         WHERE site_id = ? AND id = ?`,
      )
      .bind(siteId, vid, siteId, vid, siteId, vid, siteId, vid),
  ];
}

function insertEvent(
  db: Db,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
) {
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props);
}

function newSession(db: Db, site: Site, body: Payload, url: URL, path: string, ua: string, geo: Geo, now: number): Statement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.r) {
    try {
      const r = new URL(body.r);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(body.r);
      if (m) referrerDomain = m[1];
    }
  }
  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref });
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  const pageviews = body.t === 'pageview' ? 1 : 0;

  return [
    db.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(site.id, body.vid, now),
    db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, lat, lon, browser, os, device)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        site.id,
        body.sid,
        body.vid,
        now,
        now,
        stripWww(url.hostname),
        path,
        path,
        referrer,
        referrerDomain,
        source,
        channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        geo.lat,
        geo.lon,
        browser,
        os,
        device,
      ),
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [db.prepare('UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?').bind(site.id, body.sid)]
      : []),
  ];
}
