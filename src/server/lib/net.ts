import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { open, type CityResponse, type Reader } from 'maxmind';
import { existsSync } from 'node:fs';
import { config } from '../env';

/**
 * Where the visitor's IP comes from, as configured in CLIENT_IP_HEADER: headers tried in order, each optionally
 * `:first` or `:last` for comma-separated lists. Only headers set by our own proxy can be trusted, so a client
 * can't spoof its way past the login lockout or into the owner's excluded devices.
 *  - Caddy / Nginx in front (the VPS setup): `x-forwarded-for` (the last entry is the one our proxy added)
 *  - Render (behind Cloudflare): `cf-connecting-ip,true-client-ip,x-forwarded-for:first`
 */
export function pickClientIp(header: (name: string) => string | undefined, spec: string): { ip: string; source: string } | null {
  for (const part of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [name, pos] = part.split(':');
    const value = header(name);
    if (!value) continue;
    const ips = value.split(',').map((s) => s.trim()).filter(Boolean);
    // A bare x-forwarded-for means our own proxy appended the last entry; other headers hold a single address.
    const ip = (pos ?? (name === 'x-forwarded-for' ? 'last' : 'first')) === 'last' ? ips[ips.length - 1] : ips[0];
    if (ip) return { ip, source: part };
  }
  return null;
}

export function clientIp(c: Context): string {
  const picked = pickClientIp((n) => c.req.header(n), config.ipHeader);
  if (picked) return picked.ip;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** City-level coordinates, rounded to 2 decimals (~1 km) so no precise location is ever stored. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 100) / 100 : null;
}

let reader: Reader<CityResponse> | null = null;
let loading: Promise<void> | null = null;

/** Open the GeoIP database once, if one has been downloaded. Without it, only proxy geo headers are used. */
export function loadGeoDb(path = config.geoipDb): Promise<void> {
  if (!loading) {
    loading = (async () => {
      if (!existsSync(path)) {
        console.warn(`GeoIP database not found at ${path}; run "npm run geoip:download" for visitor locations`);
        return;
      }
      reader = await open<CityResponse>(path, { cache: { max: 10_000 } });
      console.log(`GeoIP database loaded from ${path}`);
    })().catch((e) => console.error('GeoIP database failed to load:', e));
  }
  return loading;
}

const decode = (v: string | undefined) => {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/**
 * Visitor location. Proxy headers win when present: Vercel (when the script is proxied through a Next.js site)
 * and Cloudflare (with "Add visitor location headers" turned on). Otherwise look the IP up locally.
 */
export function geoOf(c: Context, ip: string): Geo {
  const h = (n: string) => decode(c.req.header(n));
  if (h('x-vercel-ip-country')) {
    return {
      country: h('x-vercel-ip-country'),
      region: h('x-vercel-ip-country-region'),
      city: h('x-vercel-ip-city'),
      lat: coord(h('x-vercel-ip-latitude'), 90),
      lon: coord(h('x-vercel-ip-longitude'), 180),
    };
  }
  const cfCountry = h('cf-ipcountry');
  if (cfCountry && cfCountry !== 'XX' && h('cf-ipcity')) {
    return { country: cfCountry, region: h('cf-region'), city: h('cf-ipcity'), lat: coord(h('cf-iplatitude'), 90), lon: coord(h('cf-iplongitude'), 180) };
  }
  const hit = reader && ip !== 'unknown' ? safeGet(reader, ip) : null;
  if (hit) {
    return {
      country: hit.country?.iso_code ?? cfCountry ?? null,
      region: hit.subdivisions?.[0]?.names?.en ?? null,
      city: hit.city?.names?.en ?? null,
      lat: coord(hit.location?.latitude, 90),
      lon: coord(hit.location?.longitude, 180),
    };
  }
  return { country: cfCountry && cfCountry !== 'XX' ? cfCountry : null, region: null, city: null, lat: null, lon: null };
}

function safeGet(r: Reader<CityResponse>, ip: string) {
  try {
    return r.get(ip.replace(/^::ffff:/, ''));
  } catch {
    return null;
  }
}
