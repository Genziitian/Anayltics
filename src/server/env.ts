import type { Db } from './db';

/** Settings from environment variables (see .env.example). */
export const config = {
  port: Number(process.env.PORT) || 8787,
  /** Dashboard login password. */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  /** Dashboard login email (compared case-insensitively). */
  adminEmail: (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase(),
  /** Don't count tracking events from browsers that use the dashboard (the owner testing their own site). */
  excludeOwnerVisits: process.env.EXCLUDE_OWNER_VISITS !== 'false',
  /** Random string used to sign the login cookie. */
  sessionSecret: process.env.SESSION_SECRET ?? '',
  /**
   * Header(s) holding the real client IP, set by the proxy in front of GI Tracker, tried in order (see
   * lib/net.ts). Caddy/Nginx: x-forwarded-for. Render: cf-connecting-ip,true-client-ip,x-forwarded-for:first.
   */
  ipHeader: (process.env.CLIENT_IP_HEADER ?? 'x-forwarded-for').toLowerCase(),
  /** Path to a GeoLite2/DB-IP City .mmdb file for visitor locations (npm run geoip:download). */
  geoipDb: process.env.GEOIP_DB ?? 'data/geoip.mmdb',
  /** How often to pull recent payments from the Razorpay API, as a backstop for missed webhooks. 0 disables. */
  razorpaySyncMinutes: Number(process.env.RAZORPAY_SYNC_MINUTES ?? 60),
  /** Only changed by the smoke test, which runs a fake Razorpay API. */
  razorpayApiBase: process.env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com/v1',
  /** Exchange rates for payments in another currency. Only changed by the smoke test. */
  fxApiBase: process.env.FX_API_BASE ?? 'https://api.frankfurter.dev/v1',
};

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  razorpay_webhook_secret: string | null;
  razorpay_key_id: string | null;
  razorpay_key_secret: string | null;
  razorpay_synced_at: number | null;
  dodo_webhook_secret: string | null;
  /** Comma-separated Dodo product ids; when set, only those products' payments count for this site. */
  dodo_product_ids: string | null;
  /** Anyone can view this site's stats read-only, without logging in. */
  public: boolean;
  created_at: number;
}

export type AppEnv = { Variables: { site: Site } };

const siteCache = new Map<string, { site: Site | null; at: number }>();

/** Sites change rarely; cache them in memory so ingestion costs one fewer read per event. */
export async function getSite(db: Db, id: string): Promise<Site | null> {
  const hit = siteCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.site;
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Site>();
  siteCache.set(id, { site, at: Date.now() });
  return site;
}

export function forgetSite(id: string) {
  siteCache.delete(id);
}
