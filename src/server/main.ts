import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CRAWL_RETENTION_MS } from './crawls';
import { db } from './db';
import { config } from './env';
import app from './index';
import { loadGeoDb } from './lib/net';
import { migrate } from './migrate';
import { startRazorpaySyncLoop } from './razorpay';

const STATIC_ROOT = process.env.STATIC_ROOT ?? './dist';

// The tracker is loaded by other sites: allow cross-origin, cache for an hour so updates roll out quickly.
app.use('/js/*', async (c, next) => {
  await next();
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'public, max-age=3600');
});
// Vite fingerprints dashboard assets, so they can be cached forever.
app.use('/assets/*', async (c, next) => {
  await next();
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
});
app.use('*', serveStatic({ root: STATIC_ROOT }));
// Single-page app: the dashboard's own pages get index.html; anything else gets the same page with a real 404
// (the app shows "There's nothing here").
const APP_PAGES = /^\/(admin-login|site\/[\w-]+(\/settings|\/live)?\/?)?$/;
let indexHtml: string | null = null;
app.get('*', async (c) => {
  indexHtml ??= await readFile(join(STATIC_ROOT, 'index.html'), 'utf8');
  return c.html(indexHtml, APP_PAGES.test(c.req.path) ? 200 : 404);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

if (!config.adminEmail || !config.adminPassword || !config.sessionSecret) {
  console.warn('ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET are not all set: the dashboard login is disabled until you set them.');
}
// A public server with the example password would be open to anyone who has read the README.
if (process.env.NODE_ENV === 'production') {
  const problems = [
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.adminEmail) ? 'ADMIN_EMAIL must be the email you sign in with' : null,
    config.adminPassword === 'change-me' || config.adminPassword.length < 10 ? 'ADMIN_PASSWORD must be at least 10 characters and not "change-me"' : null,
    config.sessionSecret.length < 32 ? 'SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)' : null,
  ].filter(Boolean);
  if (problems.length) {
    console.error(`Refusing to start:\n- ${problems.join('\n- ')}\nFix them in .env and restart.`);
    process.exit(1);
  }
}

await migrate();
await loadGeoDb();
startRazorpaySyncLoop();

// Webhook ids only need to be remembered while Razorpay may still retry; sign-in records for 30 days.
const cleanup = () =>
  db
    .batch([
      db.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(Date.now() - 30 * 86_400_000),
      db.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(Date.now() - 30 * 86_400_000),
      db.prepare('DELETE FROM login_blocks WHERE blocked_until < ?').bind(Date.now()),
      db.prepare('DELETE FROM owner_devices WHERE seen_at < ?').bind(Date.now() - 30 * 86_400_000),
      db.prepare('DELETE FROM crawls WHERE ts < ?').bind(Date.now() - CRAWL_RETENTION_MS),
    ])
    .catch((e) => console.warn('cleanup failed:', (e as Error).message));
setInterval(cleanup, 6 * 3_600_000).unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`GI Tracker listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  db.pool.end().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
