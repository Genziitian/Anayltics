import type { Context } from 'hono';
import { db, type Db } from './db';
import type { AppEnv, Site } from './env';
import { convertMinor } from './lib/fx';

export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Phone numbers are compared on their last 10 digits, so "+91 98765-43210" and "9876543210" match. */
export function normalizePhone(v: string | null | undefined): string | null {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(-10) : null;
}

export interface PaymentInput {
  id: string;
  provider: string;
  ts: number;
  amount: number; // minor units (paise); negative for refunds
  kind: 'payment' | 'refund';
  currency: string;
  fee?: number | null;
  tax?: number | null;
  method?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  productId?: string | null;
  renewal?: boolean;
}

export type MatchedBy = 'metadata' | 'return_page' | 'customer' | 'email' | 'phone' | 'timing';

/** The visit that gets the credit: the visitor's last visit that came from somewhere (last non-direct touch). */
export function creditedSessionSql() {
  return `SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND started_at <= ?
          ORDER BY (channel != 'Direct') DESC, started_at DESC LIMIT 1`;
}

/**
 * Work out which visitor paid and which visit gets the credit, trying the most reliable signal first:
 *  1. metadata     gi_visitor_id in the Razorpay notes (added automatically by the script to Checkout)
 *  2. return_page  the visitor's browser reported this payment / order / subscription id
 *                  (Checkout success handler, or ?razorpay_payment_id= on a callback page)
 *  3. customer     the same customer / email / phone paid before (renewals, repeat purchases)
 *  4. email        the email matches a visitor you identify()'d
 *  5. phone        the phone matches a visitor you identify()'d (Razorpay always collects one)
 *  6. timing       exactly one visitor clicked a Razorpay link or checkout button shortly before the payment
 * Credit goes to the last non-direct visit, so "saw an Instagram post, came back directly 17 days later and paid"
 * is credited to Instagram.
 */
async function attribute(db: Db, site: Site, p: PaymentInput) {
  let visitorId = p.visitorId ?? null;
  let matchedBy: MatchedBy | null = visitorId ? 'metadata' : null;
  let renewal = !!p.renewal;
  const phone = normalizePhone(p.phone);

  if (!visitorId) {
    const claim = await db
      .prepare('SELECT visitor_id FROM payment_claims WHERE site_id = ? AND payment_id IN (?, ?, ?) ORDER BY ts LIMIT 1')
      .bind(site.id, p.id, p.orderId ?? p.id, p.subscriptionId ?? p.id)
      .first<{ visitor_id: string }>();
    if (claim) [visitorId, matchedBy] = [claim.visitor_id, 'return_page'];
  }

  if (p.customerId || p.email || phone) {
    const prev = await db
      .prepare(
        `SELECT visitor_id FROM payments WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL AND id != ?
           AND ((customer_id IS NOT NULL AND customer_id = ?) OR (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?))
         ORDER BY ts ASC LIMIT 1`,
      )
      .bind(site.id, p.id, p.customerId ?? null, p.email ?? null, phone)
      .first<{ visitor_id: string }>();
    if (prev) {
      if (!visitorId) [visitorId, matchedBy] = [prev.visitor_id, 'customer'];
      // Same customer paid before: a subscription renewal or repeat purchase.
      if (p.kind === 'payment') renewal = true;
    }
  }
  if (!visitorId && p.email) {
    const v = await db
      .prepare('SELECT id FROM visitors WHERE site_id = ? AND email = ? ORDER BY first_seen DESC LIMIT 1')
      .bind(site.id, p.email)
      .first<{ id: string }>();
    if (v) [visitorId, matchedBy] = [v.id, 'email'];
  }
  if (!visitorId && phone) {
    const v = await db
      .prepare('SELECT id FROM visitors WHERE site_id = ? AND phone = ? ORDER BY first_seen DESC LIMIT 1')
      .bind(site.id, phone)
      .first<{ id: string }>();
    if (v) [visitorId, matchedBy] = [v.id, 'phone'];
  }
  let reason: string | null = null;
  if (!visitorId && p.kind === 'payment' && !renewal) {
    const t = await matchByTiming(db, site, p);
    if (t.visitorId) [visitorId, matchedBy] = [t.visitorId, 'timing'];
    reason = t.reason;
  }

  let sessionId: string | null = null;
  if (visitorId) {
    const s = await db.prepare(creditedSessionSql()).bind(site.id, visitorId, p.ts + 60_000).first<{ id: string }>();
    sessionId = s?.id ?? p.sessionId ?? null;
  }
  return { visitorId, sessionId, renewal, matchedBy, reason };
}

const TIMING_WINDOW_MS = 3 * 3_600_000;
const MIN = 60_000;

/** Links and goals that mean "this visitor started paying". */
const CHECKOUT_EVENT_SQL = `((e.type = 'outbound' AND (e.name ILIKE '%rzp.io%' OR e.name ILIKE '%razorpay.me%' OR e.name ILIKE '%razorpay.com%' OR e.name ILIKE '%dodopayments.com%'))
  OR (e.type = 'goal' AND (e.name ILIKE '%checkout%' OR e.name ILIKE '%buy%' OR e.name ILIKE '%purchase%' OR e.name ILIKE '%razorpay%')))`;

/**
 * Last resort when nothing identifies the buyer: look at who clicked a Razorpay link or opened checkout
 * in the 3 hours before the payment. The strongest sign is coming back to the site right after paying
 * (Razorpay redirects buyers to your callback page); people who clicked Buy and gave up don't.
 * Only ever picks a visitor when the evidence points to exactly one person.
 */
async function matchByTiming(db: Db, site: Site, p: PaymentInput): Promise<{ visitorId: string | null; reason: string }> {
  const clicks = await db
    .prepare(
      `SELECT e.visitor_id, MAX(e.ts) AS last_click FROM events e
       WHERE e.site_id = ? AND e.ts BETWEEN ? AND ? AND ${CHECKOUT_EVENT_SQL}
         AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.site_id = e.site_id AND o.visitor_id = e.visitor_id
                         AND o.kind = 'payment' AND o.id != ? AND o.ts BETWEEN ? AND ?)
       GROUP BY e.visitor_id ORDER BY last_click DESC LIMIT 50`,
    )
    .bind(site.id, p.ts - TIMING_WINDOW_MS, p.ts + 2 * MIN, p.id, p.ts - TIMING_WINDOW_MS, p.ts + TIMING_WINDOW_MS)
    .all<{ visitor_id: string; last_click: number }>();
  const cands = clicks.results;
  if (!cands.length) return { visitorId: null, reason: 'No one opened checkout or clicked a Razorpay link in the 3 hours before this payment (was the script installed yet?)' };
  if (cands.length === 1) return { visitorId: cands[0].visitor_id, reason: 'Only checkout click before the payment' };

  // Who came back to the site shortly after the payment, after having clicked checkout?
  const placeholders = cands.map(() => '?').join(',');
  const views = await db
    .prepare(
      `SELECT visitor_id, ts FROM events
       WHERE site_id = ? AND type = 'pageview' AND ts BETWEEN ? AND ? AND visitor_id IN (${placeholders})
       LIMIT 1000`,
    )
    .bind(site.id, p.ts - MIN, p.ts + 30 * MIN, ...cands.map((c) => c.visitor_id))
    .all<{ visitor_id: string; ts: number }>();
  const lastClick = new Map(cands.map((c) => [c.visitor_id, c.last_click]));
  // A pageview after their last checkout click = they came back from the checkout.
  const returned = [...new Set(views.results.filter((v) => v.ts > (lastClick.get(v.visitor_id) ?? Infinity)).map((v) => v.visitor_id))];
  if (returned.length === 1) return { visitorId: returned[0], reason: 'Came back to the site right after paying' };

  // Nobody (or several people) came back: fall back to a single clicker in the 30 minutes before paying.
  const recent = cands.filter((c) => c.last_click >= p.ts - 30 * MIN && c.last_click <= p.ts + MIN);
  if (recent.length === 1) return { visitorId: recent[0].visitor_id, reason: 'Only checkout click in the 30 minutes before the payment' };

  return {
    visitorId: null,
    reason: `${cands.length} people clicked checkout before this payment${returned.length > 1 ? ` and ${returned.length} came back right after` : ''}; too close to call`,
  };
}

/** On a repeat delivery, take the new match if there was none, or if notes now name the visitor and the old match was weaker. */
const UPGRADE_MATCH = `(payments.visitor_id IS NULL OR (EXCLUDED.matched_by = 'metadata' AND payments.matched_by IS DISTINCT FROM 'metadata'))
             AND EXCLUDED.visitor_id IS NOT NULL`;

/**
 * Store a payment (idempotent: Razorpay sends the same payment in payment.captured, order.paid, invoice.paid…).
 * A later delivery can fill in what an earlier one lacked: the visitor (order notes arrive with order.paid),
 * the fee, the subscription.
 */
export async function recordPayment(db: Db, site: Site, p: PaymentInput) {
  const { visitorId, sessionId, renewal, matchedBy } = await attribute(db, site, p);
  const phone = normalizePhone(p.phone);
  // Totals are in the site's currency: convert at the payment day's rate and keep what the buyer paid.
  // (Razorpay reports fees in the account's settlement currency already.)
  const currency = p.currency.toUpperCase();
  const foreign = currency !== site.currency;
  const amount = foreign ? await convertMinor(db, p.amount, currency, site.currency, p.ts) : p.amount;
  const convertFee = async (v: number | null | undefined) =>
    v == null ? null : foreign && p.provider !== 'razorpay' ? convertMinor(db, v, currency, site.currency, p.ts) : v;
  const [fee, tax] = [await convertFee(p.fee), await convertFee(p.tax)];
  const stmts = [
    db
      .prepare(
        `INSERT INTO payments (site_id, id, provider, ts, amount, kind, currency, fee, tax, method, visitor_id, session_id,
           customer_id, email, phone, name, order_id, subscription_id, renewal, matched_by, orig_amount, orig_currency, product_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, id) DO UPDATE SET
           matched_by = CASE WHEN ${UPGRADE_MATCH} THEN EXCLUDED.matched_by ELSE payments.matched_by END,
           session_id = CASE WHEN ${UPGRADE_MATCH} THEN EXCLUDED.session_id ELSE payments.session_id END,
           visitor_id = CASE WHEN ${UPGRADE_MATCH} THEN EXCLUDED.visitor_id ELSE payments.visitor_id END,
           fee = COALESCE(EXCLUDED.fee, payments.fee),
           tax = COALESCE(EXCLUDED.tax, payments.tax),
           method = COALESCE(payments.method, EXCLUDED.method),
           order_id = COALESCE(payments.order_id, EXCLUDED.order_id),
           subscription_id = COALESCE(payments.subscription_id, EXCLUDED.subscription_id),
           customer_id = COALESCE(payments.customer_id, EXCLUDED.customer_id),
           renewal = GREATEST(payments.renewal, EXCLUDED.renewal)`,
      )
      .bind(
        site.id,
        p.id,
        p.provider,
        p.ts,
        amount,
        p.kind,
        site.currency,
        fee,
        tax,
        p.method ?? null,
        visitorId,
        sessionId,
        p.customerId ?? null,
        p.email ?? null,
        phone,
        p.name ?? null,
        p.orderId ?? null,
        p.subscriptionId ?? null,
        renewal ? 1 : 0,
        matchedBy,
        foreign ? p.amount : null,
        foreign ? currency : null,
        p.productId ?? null,
      ),
  ];
  // A payment tells us who an anonymous visitor really is.
  if (visitorId && p.kind === 'payment' && (p.email || p.name || phone)) {
    stmts.push(
      db.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(site.id, visitorId, p.ts),
      db
        .prepare('UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?), phone = COALESCE(phone, ?) WHERE site_id = ? AND id = ?')
        .bind(p.email ?? null, p.name ?? null, phone, site.id, visitorId),
    );
  }
  await db.batch(stmts);
  return { visitorId, sessionId };
}

/** A refund: a negative row credited to the same visitor and visit as the original payment. */
export async function recordRefund(
  db: Db,
  site: Site,
  r: { id: string; paymentId: string; provider: string; ts: number; amount: number; currency?: string | null },
) {
  const original = await db
    .prepare('SELECT * FROM payments WHERE site_id = ? AND id = ?')
    .bind(site.id, r.paymentId)
    .first<{
      visitor_id: string | null;
      session_id: string | null;
      currency: string;
      amount: number;
      orig_amount: number | null;
      orig_currency: string | null;
      customer_id: string | null;
      email: string | null;
      phone: string | null;
      name: string | null;
    }>();
  // In the site's currency, like the payment: a refund of a converted payment uses that payment's rate.
  const refundCurrency = (r.currency ?? original?.orig_currency ?? original?.currency ?? site.currency).toUpperCase();
  let amount = Math.abs(r.amount || original?.orig_amount || original?.amount || 0);
  let orig: { amount: number; currency: string } | null = null;
  if (refundCurrency !== site.currency) {
    orig = { amount, currency: refundCurrency };
    amount =
      original?.orig_amount && original.orig_currency === refundCurrency
        ? Math.round((amount * original.amount) / original.orig_amount)
        : await convertMinor(db, amount, refundCurrency, site.currency, r.ts);
  }
  await db
    .prepare(
      `INSERT INTO payments (site_id, id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, phone, name,
         orig_amount, orig_currency)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(
      site.id,
      r.id,
      r.provider,
      r.ts,
      -amount,
      site.currency,
      original?.visitor_id ?? null,
      original?.session_id ?? null,
      original?.customer_id ?? null,
      original?.email ?? null,
      original?.phone ?? null,
      original?.name ?? null,
      orig ? -orig.amount : null,
      orig?.currency ?? null,
    )
    .run();
}

/** Try again to link payments that have no visitor yet (e.g. ones imported before the script was installed). */
export async function rematchPayments(db: Db, site: Site) {
  const rows = await db
    .prepare("SELECT * FROM payments WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NULL ORDER BY ts LIMIT 500")
    .bind(site.id)
    .all<{ id: string; ts: number; amount: number; currency: string; customer_id: string | null; email: string | null; phone: string | null; name: string | null; provider: string; order_id: string | null; subscription_id: string | null }>();
  let matched = 0;
  const details: { id: string; name: string | null; matched: boolean; reason: string | null }[] = [];
  for (const r of rows.results) {
    const a = await attribute(db, site, {
      id: r.id,
      provider: r.provider,
      ts: r.ts,
      amount: r.amount,
      kind: 'payment',
      currency: r.currency,
      customerId: r.customer_id,
      email: r.email,
      phone: r.phone,
      name: r.name,
      orderId: r.order_id,
      subscriptionId: r.subscription_id,
    });
    details.push({ id: r.id, name: r.name, matched: !!a.visitorId, reason: a.reason });
    if (!a.visitorId) continue;
    matched++;
    await db.batch([
      db
        .prepare('UPDATE payments SET visitor_id = ?, session_id = ?, matched_by = ?, renewal = ? WHERE site_id = ? AND id = ?')
        .bind(a.visitorId, a.sessionId, a.matchedBy, a.renewal ? 1 : 0, site.id, r.id),
      db.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(site.id, a.visitorId, r.ts),
      db
        .prepare('UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?), phone = COALESCE(phone, ?) WHERE site_id = ? AND id = ?')
        .bind(r.email, r.name, r.phone, site.id, a.visitorId),
    ]);
  }
  return { checked: rows.results.length, matched, details };
}

export const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

async function siteFromApiKey(c: Context<AppEnv>): Promise<Site | null> {
  const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!key) return null;
  return db.prepare('SELECT * FROM sites WHERE api_key = ?').bind(key).first<Site>();
}

/**
 * Generic payments API, for any provider without a built-in integration.
 * POST /api/v1/payments  Authorization: Bearer <site api key>
 * { "transaction_id": "...", "amount": 499.00, "currency": "INR", "visitor_id": "<gi_vid cookie>", "email": "..." }
 */
export async function handlePaymentApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!b || !str(b.transaction_id) || typeof b.amount !== 'number') {
    return c.json({ error: 'transaction_id (string) and amount (number, e.g. 499.00) are required' }, 400);
  }
  const currency = (str(b.currency) ?? site.currency).toUpperCase();
  const minor = Math.round((b.amount as number) * 10 ** currencyDecimals(currency));
  const refunded = b.refunded === true;
  const res = await recordPayment(db, site, {
    id: `${site.id}:${b.transaction_id}${refunded ? ':refund' : ''}`,
    provider: 'api',
    ts: typeof b.timestamp === 'string' ? Date.parse(b.timestamp) || Date.now() : Date.now(),
    amount: refunded ? -Math.abs(minor) : minor,
    kind: refunded ? 'refund' : 'payment',
    currency,
    visitorId: str(b.visitor_id),
    sessionId: str(b.session_id),
    customerId: str(b.customer_id),
    email: str(b.email)?.toLowerCase() ?? null,
    phone: str(b.phone),
    name: str(b.name),
    renewal: b.renewal === true,
  });
  return c.json({ ok: true, attributed: !!res.sessionId, visitor_id: res.visitorId });
}

/**
 * Server-side goals (e.g. "signup" from your backend).
 * POST /api/v1/goals  { "visitor_id": "...", "name": "signup" }
 */
export async function handleGoalApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const vid = str(b?.visitor_id);
  const name = str(b?.name)?.slice(0, 64);
  if (!vid || !name) return c.json({ error: 'visitor_id and name are required' }, 400);
  const s = await db
    .prepare('SELECT id, exit_page FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1')
    .bind(site.id, vid)
    .first<{ id: string; exit_page: string }>();
  if (!s) return c.json({ error: 'visitor not found' }, 404);
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE sessions SET goals = goals + 1 WHERE site_id = ? AND id = ?').bind(site.id, s.id),
    db
      .prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, 'goal', ?, ?, ?)")
      .bind(site.id, s.id, vid, now, name, s.exit_page, b?.props ? JSON.stringify(b.props).slice(0, 1000) : null),
  ]);
  return c.json({ ok: true });
}
