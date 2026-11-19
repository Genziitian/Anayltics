import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { clearSession, endAllSessions, handleLogin, me, publicOrigin, requireAuth, signInActivity } from './auth';
import { handleEvent } from './collect';
import { crawlStats, handleCrawlApi } from './crawls';
import { handleDodoWebhook } from './dodo';
import { db } from './db';
import { config, forgetSite, type AppEnv, type Site } from './env';
import { randomId } from './lib/crypto';
import { handleGoalApi, handlePaymentApi, rematchPayments } from './payments';
import { handleRazorpayWebhook, RazorpayApiError, syncRazorpay } from './razorpay';
import { clientIp, geoOf, pickClientIp } from './lib/net';
import { breakdown, customers, funnel, makeCtx, ONLINE_EVENTS, ONLINE_MS, overview, realtime, sparklines, visitorProfile, visitors, type FunnelStep } from './stats';

const app = new Hono<AppEnv>();

// ---------- limits and headers

const tooLarge = (c: Context) => c.json({ error: 'request too large' }, 413);
// Events are tiny; reject big bodies before reading them.
app.use('/api/event', bodyLimit({ maxSize: 8 * 1024, onError: tooLarge }));
app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));

/**
 * The page policy (from Open Analytics). Scripts run only from this site's own files: no inline scripts, no eval,
 * nothing from other hosts. Styles and fonts may also come from Google Fonts; images from site favicons, map tiles
 * and Google profile pictures; the map's own worker runs from a blob. Nothing may frame the dashboard.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://www.google.com https://*.gstatic.com https://*.googleusercontent.com https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// Hardening for everything we answer. The tracker and the public endpoints stay usable from other sites.
app.use('*', async (c, next) => {
  await next();
  const p = c.req.path;
  c.header('X-Content-Type-Options', 'nosniff');
  if (publicOrigin(c).startsWith('https:')) c.header('Strict-Transport-Security', 'max-age=31536000');
  if (p.startsWith('/js/') || p === '/api/event' || p.startsWith('/api/webhooks/') || p.startsWith('/api/v1/')) return;
  c.header('Referrer-Policy', 'same-origin');
  if (p.startsWith('/api/')) {
    // Stats, settings and secrets must never sit in a shared or browser cache.
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  } else {
    // Dashboard pages: scripts only from this site, no framing (clickjacking), no access to camera, location and the like.
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', CSP);
    // A private dashboard: nothing here should be in search results.
    c.header('X-Robots-Tag', 'noindex');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
  }
});

/** For Docker's healthcheck and uptime monitors. */
app.get('/api/health', async (c) => {
  try {
    await db.prepare('SELECT 1').first();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: 'database unreachable' }, 503);
  }
});

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
app.post('/api/webhooks/razorpay/:siteId', handleRazorpayWebhook);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);
app.post('/api/v1/crawls', handleCrawlApi);

// ---------- login (see auth.ts)

app.post('/api/auth/login', handleLogin);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => c.json(await me(c)));

// ---------- dashboard API (login required)

app.use('/api/sites', requireAuth);
app.use('/api/sites/*', requireAuth);
app.use('/api/sites-overview', requireAuth);
app.use('/api/auth/logout-all', requireAuth);
app.use('/api/auth/activity', requireAuth);
app.use('/api/auth/network', requireAuth);

/** Sign out every browser, including this one. */
app.post('/api/auth/logout-all', async (c) => {
  await endAllSessions();
  clearSession(c);
  return c.json({ ok: true });
});

/**
 * What GI Tracker sees of your own connection: the IP it uses (for locations, sign-in limits and leaving your
 * own visits out) and the proxy headers it came from. Open it once after deploying to check CLIENT_IP_HEADER.
 */
app.get('/api/auth/network', (c) => {
  const ip = clientIp(c);
  const headers = ['cf-connecting-ip', 'true-client-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ipcountry'];
  return c.json({
    ip,
    from: pickClientIp((n) => c.req.header(n), config.ipHeader)?.source ?? 'the connection itself (no proxy header)',
    setting: config.ipHeader,
    location: geoOf(c, ip),
    headers: Object.fromEntries(headers.map((h) => [h, c.req.header(h) ?? null])),
  });
});

// Recent sign-in attempts and the limits in force, for Settings → Sign-in security.
app.get('/api/auth/activity', async (c) => c.json(await signInActivity(c)));

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(c.req.param('id')).first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const MASK = '••••••••';
/** Secrets never go back to the browser, only whether they are set. */
const publicSite = (s: Site) => ({
  ...s,
  razorpay_webhook_secret: s.razorpay_webhook_secret ? MASK : null,
  razorpay_key_secret: s.razorpay_key_secret ? MASK : null,
  dodo_webhook_secret: s.dodo_webhook_secret ? MASK : null,
  public: s.public ? 1 : 0,
});
const SECRET_FIELDS = ['razorpay_webhook_secret', 'razorpay_key_id', 'razorpay_key_secret', 'dodo_webhook_secret'] as const;

/** Public pages are cached for a minute (see publicCache). Any change to a site clears it, so a site made
 * private or deleted disappears from public view at once. */
const publicCacheStore = new Map<string, { at: number; body: string; status: number }>();
const siteChanged = (id: string) => {
  forgetSite(id);
  publicCacheStore.clear();
};

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const [sites, stats, live] = await db.batch([
    db.prepare('SELECT * FROM sites ORDER BY created_at'),
    db.prepare('SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE started_at > ? GROUP BY site_id').bind(now - 86_400_000),
    // Online = opened a page or completed a goal in the last 10 minutes (see ONLINE_MS).
    db.prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS online FROM events WHERE ts > ? AND type IN ${ONLINE_EVENTS} GROUP BY site_id`).bind(now - ONLINE_MS),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  const onlineBy = new Map((live.results as any[]).map((r) => [r.site_id, r.online as number]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: onlineBy.get(s.id) ?? 0,
    })),
  );
});

// Every site's totals and sparkline for the all-websites view.
app.get('/api/sites-overview', async (c) => {
  const rows = await db.prepare('SELECT id FROM sites').all<{ id: string }>();
  return c.json(await sparklines(db, rows.results.map((r) => r.id), c.req.query('period') ?? '30d'));
});

app.post('/api/sites', async (c) => {
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  const tz = b.timezone && validTimezone(b.timezone) ? b.timezone : 'Asia/Kolkata';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'INR').toUpperCase().slice(0, 3),
    api_key: 'gi_' + randomId(16),
    razorpay_webhook_secret: null,
    razorpay_key_id: null,
    razorpay_key_secret: null,
    razorpay_synced_at: null,
    dodo_webhook_secret: null,
    dodo_product_ids: null,
    public: false,
    created_at: Date.now(),
  };
  await db.prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, site.created_at)
    .run();
  siteChanged(site.id);
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  for (const k of SECRET_FIELDS) {
    const v = b[k];
    if (typeof v === 'string' && !v.includes('•')) next[k] = v.trim() || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  const pub: unknown = b.public;
  if (typeof pub === 'boolean' || pub === 0 || pub === 1) next.public = !!pub;
  await db.prepare(
    `UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?,
       razorpay_webhook_secret = ?, razorpay_key_id = ?, razorpay_key_secret = ?, dodo_webhook_secret = ?, dodo_product_ids = ?,
       public = ? WHERE id = ?`,
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.razorpay_webhook_secret,
      next.razorpay_key_id,
      next.razorpay_key_secret,
      next.dodo_webhook_secret,
      next.dodo_product_ids,
      next.public,
      site.id,
    )
    .run();
  siteChanged(site.id);
  return c.json(publicSite(next));
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'gi_' + randomId(16);
  await db.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await db.batch(
    ['events', 'sessions', 'visitors', 'payments', 'payment_claims', 'webhook_events', 'funnels', 'crawls'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(db.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  siteChanged(id);
  return c.json({ ok: true });
});

// ---------- stats

// Aggregate stats only. Shared by the owner's dashboard and the public read-only one.
const overviewHandler = async (c: Context<AppEnv>) => c.json(await overview(makeCtx(c)));
const crawlsHandler = async (c: Context<AppEnv>) => c.json(await crawlStats(makeCtx(c), c.req.query('kind')));
const breakdownHandler = async (c: Context<AppEnv>) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
};
const funnelsHandler = async (c: Context<AppEnv>) => {
  const res = await db.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
};
const funnelStatsHandler = async (c: Context<AppEnv>) => {
  const f = await db.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
};

app.get('/api/sites/:id/overview', overviewHandler);
app.get('/api/sites/:id/crawls', crawlsHandler);
app.get('/api/sites/:id/breakdown', breakdownHandler);
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(db, c.get('site'))));

app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(db, c.get('site'))));

/** Import payments from the Razorpay API: { days } back from now (max 365). Also tests the API keys. */
app.post('/api/sites/:id/razorpay/sync', async (c) => {
  const b = await c.req.json<{ days?: number }>().catch(() => ({}) as { days?: number });
  const days = Math.max(1, Math.min(365, Math.round(Number(b.days) || 30)));
  try {
    const r = await syncRazorpay(db, c.get('site'), Date.now() - days * 86_400_000);
    forgetSite(c.get('site').id);
    return c.json({ ok: true, days, ...r });
  } catch (e) {
    if (e instanceof RazorpayApiError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(db, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', funnelsHandler);

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await db.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await db.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', funnelStatsHandler);

// ---------- public, read-only dashboards (from Open Analytics)
//
// Sites the owner marked "public" in their settings can be viewed by anyone, without logging in.
// Only aggregate stats are served here: no settings, API keys, webhook secrets, visitor names or
// emails, customer lists or per-visitor timelines, and nothing that writes.

const publicFields = (s: Site) => ({ id: s.id, name: s.name, domain: s.domain, timezone: s.timezone, currency: s.currency, created_at: s.created_at });

/** A short server-side cache (a minute; 10 s for the live map) and a per-IP limit on cache misses. */
const publicMisses = new Map<string, { minute: number; n: number }>();
const PUBLIC_MISSES_PER_MINUTE = 120;
const publicCache = async (c: Context<AppEnv>, next: Next) => {
  const key = c.req.url;
  const ttl = c.req.path.endsWith('/realtime') ? 10_000 : 60_000;
  const hit = publicCacheStore.get(key);
  if (hit && hit.at > Date.now() - ttl) return c.body(hit.body, hit.status as 200, { 'content-type': 'application/json' });
  const ip = clientIp(c);
  const minute = Math.floor(Date.now() / 60_000);
  const m = publicMisses.get(ip);
  const n = m?.minute === minute ? m.n + 1 : 1;
  publicMisses.set(ip, { minute, n });
  if (n > PUBLIC_MISSES_PER_MINUTE) return c.json({ error: 'Too many requests' }, 429);
  await next();
  if (c.res.status !== 200) return;
  if (publicCacheStore.size > 2000) publicCacheStore.clear();
  publicCacheStore.set(key, { at: Date.now(), body: await c.res.clone().text(), status: 200 });
};

const loadPublicSite = async (c: Context<AppEnv>, next: Next) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ? AND public').bind(c.req.param('id')).first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};

app.get('/api/public/sites', publicCache, async (c) => {
  const r = await db.prepare('SELECT * FROM sites WHERE public ORDER BY created_at').all<Site>();
  return c.json(r.results.map(publicFields));
});
// Totals and sparklines for the public landing page's website cards.
app.get('/api/public/sites-overview', publicCache, async (c) => {
  const r = await db.prepare('SELECT id FROM sites WHERE public').all<{ id: string }>();
  return c.json(await sparklines(db, r.results.map((s) => s.id), c.req.query('period') ?? '30d'));
});
app.use('/api/public/sites/:id', publicCache, loadPublicSite);
app.use('/api/public/sites/:id/*', publicCache, loadPublicSite);
app.get('/api/public/sites/:id', (c) => c.json(publicFields(c.get('site'))));
app.get('/api/public/sites/:id/overview', overviewHandler);
app.get('/api/public/sites/:id/crawls', crawlsHandler);
app.get('/api/public/sites/:id/breakdown', breakdownHandler);
app.get('/api/public/sites/:id/funnels', funnelsHandler);
app.get('/api/public/sites/:id/funnels/:fid/stats', funnelStatsHandler);
// The live map: where people are and which pages they open. No names, emails, payments or amounts.
app.get('/api/public/sites/:id/realtime', async (c) => {
  const r = await realtime(db, c.get('site'));
  return c.json({
    ...r,
    visitors: (r.visitors as any[]).map(({ name: _n, email: _e, spent: _s, ...v }) => v),
    feed: r.feed.filter((f) => f.type === 'pageview' || f.type === 'goal').map((f) => ({ ...f, name: null })),
  });
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// The dashboard and tracker (static files) are served by main.ts.

export default app;
