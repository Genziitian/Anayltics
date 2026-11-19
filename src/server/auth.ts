import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db } from './db';
import { config, type AppEnv } from './env';
import { randomId, signToken, verifyToken } from './lib/crypto';
import { clientIp, geoOf } from './lib/net';

// Owner sign-in, hardened along the lines of Open Analytics (github.com/punyakrit/open-analytics).

/** Wrong passwords allowed from one network (IP) in LOGIN_WINDOW_MS before it is locked out. */
const MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** The first lock on a network lasts this long; each one after it twice as long as the last, up to a day. */
const FIRST_LOCK_MS = 15 * 60_000;
const LONGEST_LOCK_MS = 24 * 3_600_000;
/** Wrong passwords from all networks together, per window, before sign-in pauses for browsers never signed in. */
const GLOBAL_MAX_FAILURES = 30;
/** Every sign-in answer takes at least this long, right or wrong, so timing reveals nothing and guessing is slow. */
const MIN_LOGIN_MS = 900;
/** How long a sign-in lasts on one device. */
const SESSION_DAYS = 7;
/** How long a dashboard visit keeps that browser out of the stats. */
const OWNER_DEVICE_MS = 30 * 86_400_000;

const SESSION_COOKIE = 'gi_session';
/** Set after a successful sign-in: proof this browser has signed in before. It never signs anyone in by itself. */
const DEVICE_COOKIE = 'gi_device';

/** The address the browser sees (behind Caddy the app itself is reached over plain http). */
export function publicOrigin(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}
const isHttps = (c: Context) => publicOrigin(c).startsWith('https:');
/**
 * Over https cookies get the `__Host-` prefix: the browser then refuses them unless they are Secure, for this
 * exact host and path /. Plain http only happens in local development, where browsers refuse that prefix.
 */
const cookieName = (c: Context, base: string) => (isHttps(c) ? `__Host-${base}` : base);

const sha256 = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time comparison that doesn't leak the length either. */
const same = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** Changing ADMIN_EMAIL or ADMIN_PASSWORD in .env signs every device out. */
const credentialsTag = () => sha256(`${config.adminEmail}\n${config.adminPassword}`).toString('hex').slice(0, 16);

/** Part of every session cookie. "Sign out everywhere" changes it. */
async function sessionEpoch(): Promise<string> {
  await db.prepare("INSERT INTO auth_state (key, value) VALUES ('session_epoch', ?) ON CONFLICT DO NOTHING").bind(randomId(12)).run();
  return (await db.prepare("SELECT value FROM auth_state WHERE key = 'session_epoch'").first<{ value: string }>())!.value;
}

export async function endAllSessions() {
  await db
    .prepare("INSERT INTO auth_state (key, value) VALUES ('session_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
    .bind(randomId(12))
    .run();
}

export async function isLoggedIn(c: Context): Promise<boolean> {
  if (!config.sessionSecret) return false;
  const value = await verifyToken(config.sessionSecret, getCookie(c, cookieName(c, SESSION_COOKIE)));
  if (!value) return false;
  // "admin:<epoch>:<credentials tag>.<expires>"
  const dot = value.lastIndexOf('.');
  if (Number(value.slice(dot + 1)) <= Date.now()) return false;
  const [kind, epoch, tag] = value.slice(0, dot).split(':');
  return kind === 'admin' && tag === credentialsTag() && epoch === (await sessionEpoch());
}

export const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  if (!(await isLoggedIn(c))) return c.json({ error: 'unauthorized' }, 401);
  rememberOwnerDevice(c);
  await next();
};

export function clearSession(c: Context) {
  deleteCookie(c, cookieName(c, SESSION_COOKIE), { path: '/', secure: isHttps(c) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const inMinutes = (ms: number) => {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.round(m / 60)} hour${m >= 90 ? 's' : ''}` : `${m} minute${m === 1 ? '' : 's'}`;
};

/**
 * POST /api/auth/login { email, password }
 * The attempt is recorded and counted under a per-IP lock BEFORE the password is checked, so a burst of
 * parallel guesses can't all slip under the limit.
 */
export async function handleLogin(c: Context<AppEnv>) {
  if (!config.adminEmail || !config.adminPassword || !config.sessionSecret) {
    return c.json({ error: 'Set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET in .env (see README).' }, 500);
  }
  // Only the dashboard itself may sign in (no cross-site form posts).
  if (c.req.header('origin') !== publicOrigin(c)) return c.json({ error: 'Sign in from the dashboard itself.' }, 403);
  if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: 'Unsupported request.' }, 415);

  const now = Date.now();
  const answer = async (body: Record<string, unknown>, status: 200 | 401 | 429) => {
    await sleep(MIN_LOGIN_MS - (Date.now() - now));
    return c.json(body, status);
  };
  const ip = clientIp(c);

  const client = await db.pool.connect();
  let attemptId: number;
  let failures: number;
  let failuresEverywhere: number;
  let strikes: number;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${ip}`]);
    const lock = (await client.query('SELECT strikes, blocked_until FROM login_blocks WHERE ip = $1', [ip])).rows[0];
    if (lock && Number(lock.blocked_until) > now) {
      await client.query('COMMIT');
      return answer({ error: `Too many wrong passwords from your network. Try again in ${inMinutes(Number(lock.blocked_until) - now)}.` }, 429);
    }
    strikes = Number(lock?.strikes ?? 0);
    const country = geoOf(c, ip).country;
    attemptId = Number((await client.query('INSERT INTO login_attempts (ts, ip, country) VALUES ($1, $2, $3) RETURNING id', [now, ip, country])).rows[0].id);
    // This network's wrong passwords in the window, since its last successful sign-in (includes this attempt).
    failures = Number(
      (
        await client.query(
          `SELECT COUNT(*) AS n FROM login_attempts WHERE ip = $1 AND NOT ok
             AND ts > GREATEST($2, COALESCE((SELECT MAX(ts) FROM login_attempts WHERE ip = $1 AND ok), 0))`,
          [ip, now - LOGIN_WINDOW_MS],
        )
      ).rows[0].n,
    );
    failuresEverywhere = Number((await client.query('SELECT COUNT(*) AS n FROM login_attempts WHERE NOT ok AND ts > $1', [now - LOGIN_WINDOW_MS])).rows[0].n);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const lockOut = async () => {
    const until = now + Math.min(LONGEST_LOCK_MS, FIRST_LOCK_MS * 2 ** strikes);
    await db
      .prepare(
        'INSERT INTO login_blocks (ip, strikes, blocked_until) VALUES (?, ?, ?) ON CONFLICT (ip) DO UPDATE SET strikes = EXCLUDED.strikes, blocked_until = EXCLUDED.blocked_until',
      )
      .bind(ip, strikes + 1, until)
      .run();
    return inMinutes(until - now);
  };

  if (failures > MAX_FAILURES) return answer({ error: `Too many wrong passwords from your network. Try again in ${await lockOut()}.` }, 429);
  const knownDevice = !!(await verifyToken(config.sessionSecret, getCookie(c, cookieName(c, DEVICE_COOKIE))));
  if (failuresEverywhere > GLOBAL_MAX_FAILURES && !knownDevice) {
    return answer({ error: 'Sign-in is paused for a few minutes after many wrong passwords. Try again later.' }, 429);
  }

  const body = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}) as { email?: unknown; password?: unknown });
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 1000) : '';
  // Both are always compared, so the answer never reveals which one was wrong.
  const emailOk = same(email, config.adminEmail);
  const passwordOk = same(password, config.adminPassword);
  if (!emailOk || !passwordOk) {
    if (failures >= MAX_FAILURES) return answer({ error: `Wrong email or password. Sign-in from your network is locked for ${await lockOut()}.` }, 429);
    const left = MAX_FAILURES - failures;
    return answer({ error: `Wrong email or password. ${left} ${left === 1 ? 'try' : 'tries'} left before sign-in locks for 15 minutes.` }, 401);
  }

  await db.batch([
    db.prepare('UPDATE login_attempts SET ok = TRUE WHERE id = ?').bind(attemptId),
    db.prepare('DELETE FROM login_blocks WHERE ip = ?').bind(ip),
  ]);
  const expires = now + SESSION_DAYS * 86_400_000;
  setCookie(c, cookieName(c, SESSION_COOKIE), await signToken(config.sessionSecret, `admin:${await sessionEpoch()}:${credentialsTag()}.${expires}`), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  setCookie(c, cookieName(c, DEVICE_COOKIE), await signToken(config.sessionSecret, `device.${randomId(12)}`), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Strict',
    path: '/',
    maxAge: 365 * 86_400,
  });
  rememberOwnerDevice(c);
  return answer({ ok: true }, 200);
}

// ---------- the owner's own browsers don't count as visitors

/** A hash of IP + browser, so the raw IP is never stored. Null when there's nothing to go on. */
export function deviceFingerprint(c: Context): string | null {
  const ip = clientIp(c);
  const ua = c.req.header('user-agent') ?? '';
  if (ip === 'unknown' || !ua) return null;
  return sha256(`${ip}|${ua}`).toString('hex');
}

const recentlyRemembered = new Map<string, number>();
let ownerDevices: { fps: Set<string>; at: number } | null = null;

/** Called when the owner uses the dashboard. Writes at most once an hour per device. */
export function rememberOwnerDevice(c: Context) {
  const fp = deviceFingerprint(c);
  if (!fp || (recentlyRemembered.get(fp) ?? 0) > Date.now() - 3_600_000) return;
  recentlyRemembered.set(fp, Date.now());
  ownerDevices?.fps.add(fp);
  db.prepare('INSERT INTO owner_devices (fp, seen_at) VALUES (?, ?) ON CONFLICT (fp) DO UPDATE SET seen_at = EXCLUDED.seen_at')
    .bind(fp, Date.now())
    .run()
    .catch((e) => console.warn('owner device:', (e as Error).message));
}

/** Is this tracking request coming from a browser the owner used the dashboard from? (Cached for a minute.) */
export async function isOwnerVisit(c: Context): Promise<boolean> {
  if (!config.excludeOwnerVisits) return false;
  const fp = deviceFingerprint(c);
  if (!fp) return false;
  if (!ownerDevices || ownerDevices.at < Date.now() - 60_000) {
    const rows = await db.prepare('SELECT fp FROM owner_devices WHERE seen_at > ?').bind(Date.now() - OWNER_DEVICE_MS).all<{ fp: string }>();
    ownerDevices = { fps: new Set(rows.results.map((r) => r.fp)), at: Date.now() };
  }
  return ownerDevices.fps.has(fp);
}

// ---------- Settings → Sign-in security

/** Show only the start of an address: enough to recognise your own network, not to identify anyone. */
function maskIp(ip: string) {
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4.includes('.')) return v4.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + ':…';
  return ip;
}

/** Recent sign-in attempts and the limits in force. */
export async function signInActivity(c: Context) {
  const now = Date.now();
  const me = clientIp(c);
  const [rows, failed, locked] = await db.batch([
    db.prepare('SELECT ts, ip, ok, country FROM login_attempts ORDER BY ts DESC LIMIT 25'),
    db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE NOT ok AND ts > ?').bind(now - 86_400_000),
    db.prepare('SELECT COUNT(*) AS n FROM login_blocks WHERE blocked_until > ?').bind(now),
  ]);
  return {
    attempts: (rows.results as { ts: number; ip: string; ok: boolean; country: string | null }[]).map((r) => ({
      ts: r.ts,
      ok: r.ok,
      country: r.country,
      network: maskIp(r.ip),
      yours: r.ip === me,
    })),
    failedLastDay: (failed.results[0] as { n: number }).n,
    lockedNetworks: (locked.results[0] as { n: number }).n,
    limits: { maxFailures: MAX_FAILURES, windowMinutes: LOGIN_WINDOW_MS / 60_000, firstLockMinutes: FIRST_LOCK_MS / 60_000, sessionDays: SESSION_DAYS },
  };
}

/** What the dashboard knows about who is signed in. One owner; the shape matches Open Analytics' dashboard. */
export async function me(c: Context) {
  const loggedIn = await isLoggedIn(c);
  if (loggedIn) rememberOwnerDevice(c);
  return {
    loggedIn,
    hosted: false,
    user: loggedIn
      ? { id: 'admin', email: config.adminEmail, name: null, avatar: null, admin: true, paid: true, plan_status: 'active', plan_until: null, plan: null }
      : null,
  };
}
