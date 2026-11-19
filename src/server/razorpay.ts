import type { Context } from 'hono';
import { db, type Db } from './db';
import { config, getSite, type AppEnv, type Site } from './env';
import { verifyRazorpaySignature } from './lib/crypto';
import { recordPayment, recordRefund, str, type PaymentInput } from './payments';

type Entity = Record<string, any>;

/** Razorpay sends `notes: []` when there are none. */
const notesOf = (e: Entity | undefined): Record<string, unknown> =>
  e?.notes && typeof e.notes === 'object' && !Array.isArray(e.notes) ? e.notes : {};

function pickNote(notes: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) if (str(notes[k])) return notes[k] as string;
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Turn a Razorpay payment (plus whatever came with it: order, subscription, payment link, invoice)
 * into a PaymentInput. Notes are merged from all of them, payment notes winning.
 */
export function paymentFromRazorpay(
  site: Site,
  payment: Entity,
  related: { order?: Entity; subscription?: Entity; paymentLink?: Entity; invoice?: Entity } = {},
): PaymentInput {
  const { order, subscription, paymentLink, invoice } = related;
  const notes = {
    ...notesOf(paymentLink),
    ...notesOf(invoice),
    ...notesOf(subscription),
    ...notesOf(order),
    ...notesOf(payment),
  };
  const person = paymentLink?.customer ?? invoice?.customer_details ?? {};

  // International payments: report in the site currency when Razorpay gives the converted amount.
  let amount = Number(payment.amount) || 0;
  let currency = String(payment.currency ?? site.currency).toUpperCase();
  const fee = num(payment.fee);
  const tax = num(payment.tax);
  if (currency !== site.currency && str(payment.base_currency)?.toUpperCase() === site.currency && num(payment.base_amount)) {
    amount = payment.base_amount;
    currency = site.currency;
    // Fees are charged in the settlement currency already.
  }

  return {
    id: String(payment.id),
    provider: 'razorpay',
    ts: (Number(payment.created_at) || Date.now() / 1000) * 1000,
    amount,
    kind: 'payment',
    currency,
    fee,
    tax,
    method: str(payment.method),
    visitorId: pickNote(notes, ['gi_visitor_id', 'visitor_id']),
    sessionId: pickNote(notes, ['gi_session_id', 'session_id']),
    customerId: str(payment.customer_id) ?? str(subscription?.customer_id) ?? str(invoice?.customer_id),
    email: (str(payment.email) ?? str(person.email))?.toLowerCase() ?? null,
    phone: str(payment.contact) ?? str(person.contact),
    name: str(person.name) ?? pickNote(notes, ['name', 'customer_name', 'full_name']),
    orderId: str(payment.order_id) ?? str(order?.id),
    subscriptionId: str(subscription?.id) ?? str(invoice?.subscription_id),
    // A subscription's second and later charges are renewals.
    renewal: (num(subscription?.paid_count) ?? 0) > 1,
  };
}

/** Events that mean money arrived. They overlap (one payment can come in 2-3 of them); storage is idempotent. */
const PAID_EVENTS = new Set(['payment.captured', 'order.paid', 'subscription.charged', 'payment_link.paid', 'invoice.paid']);

export async function processRazorpayEvent(db: Db, site: Site, event: { event?: string; payload?: Record<string, { entity?: Entity }> }) {
  const pl = event.payload ?? {};
  const payment = pl.payment?.entity;
  if (event.event && PAID_EVENTS.has(event.event) && payment?.id && payment.status === 'captured') {
    await recordPayment(
      db,
      site,
      paymentFromRazorpay(site, payment, {
        order: pl.order?.entity,
        subscription: pl.subscription?.entity,
        paymentLink: pl.payment_link?.entity,
        invoice: pl.invoice?.entity,
      }),
    );
    return 'payment';
  }
  const refund = pl.refund?.entity;
  if (event.event === 'refund.processed' && refund?.id && refund.payment_id) {
    // The refund can arrive before we ever saw the payment (e.g. webhook added later): store the payment first.
    if (payment?.id && payment.captured) await recordPayment(db, site, paymentFromRazorpay(site, payment));
    await recordRefund(db, site, {
      id: String(refund.id),
      paymentId: String(refund.payment_id),
      provider: 'razorpay',
      ts: (Number(refund.created_at) || Date.now() / 1000) * 1000,
      amount: Number(refund.amount) || 0,
      currency: str(refund.currency),
    });
    return 'refund';
  }
  return 'ignored';
}

/** Razorpay webhook: POST /api/webhooks/razorpay/:siteId */
export async function handleRazorpayWebhook(c: Context<AppEnv>) {
  const site = await getSite(db, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.razorpay_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);

  const body = await c.req.text();
  if (!(await verifyRazorpaySignature(site.razorpay_webhook_secret, body, c.req.header('x-razorpay-signature')))) {
    return c.json({ error: 'invalid signature' }, 401);
  }

  const eventId = c.req.header('x-razorpay-event-id');
  if (eventId) {
    const seen = await db
      .prepare("SELECT 1 FROM webhook_events WHERE site_id = ? AND provider = 'razorpay' AND event_id = ?")
      .bind(site.id, eventId)
      .first();
    if (seen) return c.json({ ok: true, duplicate: true });
  }

  let event: Parameters<typeof processRazorpayEvent>[2];
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const result = await processRazorpayEvent(db, site, event);
  if (eventId) {
    await db
      .prepare("INSERT INTO webhook_events (site_id, provider, event_id, received_at) VALUES (?, 'razorpay', ?, ?) ON CONFLICT DO NOTHING")
      .bind(site.id, eventId, Date.now())
      .run();
  }
  // Every other event type is acknowledged so Razorpay doesn't retry it.
  return c.json({ ok: true, result });
}

// ---------- API sync: backfill history, and catch payments whose webhook never arrived

export class RazorpayApiError extends Error {}

async function listAll(site: Site, resource: 'payments' | 'refunds', from: number, to: number, fetchImpl = fetch) {
  const auth = 'Basic ' + btoa(`${site.razorpay_key_id}:${site.razorpay_key_secret}`);
  const items: Entity[] = [];
  for (let skip = 0; skip < 50_000; skip += 100) {
    const url = `${config.razorpayApiBase}/${resource}?from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&count=100&skip=${skip}`;
    const res = await fetchImpl(url, { headers: { authorization: auth } });
    if (res.status === 401) throw new RazorpayApiError('Razorpay rejected the API key. Check the Key ID and Key Secret.');
    if (!res.ok) throw new RazorpayApiError(`Razorpay API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as { items?: Entity[] };
    items.push(...(page.items ?? []));
    if ((page.items?.length ?? 0) < 100) break;
  }
  return items;
}

/**
 * Pull payments and refunds in [from, to) from the Razorpay API and store any we don't have.
 * Needs the site's Key ID + Key Secret. Payments made before the tracking script was installed are imported
 * for revenue totals; they stay unattributed unless an email/phone/customer match exists.
 */
export async function syncRazorpay(db: Db, site: Site, from: number, to = Date.now(), fetchImpl = fetch) {
  if (!site.razorpay_key_id || !site.razorpay_key_secret) throw new RazorpayApiError('Add your Razorpay Key ID and Key Secret first.');
  const [payments, refunds] = [await listAll(site, 'payments', from, to, fetchImpl), await listAll(site, 'refunds', from, to, fetchImpl)];
  let imported = 0;
  // Oldest first, so a customer's first payment is stored before their renewals.
  for (const p of payments.filter((p) => p.captured || p.status === 'captured' || p.status === 'refunded').reverse()) {
    const exists = await db.prepare('SELECT 1 FROM payments WHERE site_id = ? AND id = ?').bind(site.id, p.id).first();
    if (!exists) imported++;
    await recordPayment(db, site, paymentFromRazorpay(site, p));
  }
  for (const r of refunds.filter((r) => r.status === 'processed')) {
    await recordRefund(db, site, {
      id: String(r.id),
      paymentId: String(r.payment_id),
      provider: 'razorpay',
      ts: Number(r.created_at) * 1000,
      amount: Number(r.amount) || 0,
      currency: str(r.currency),
    });
  }
  await db.prepare('UPDATE sites SET razorpay_synced_at = ? WHERE id = ?').bind(Date.now(), site.id).run();
  return { payments: payments.length, refunds: refunds.length, imported };
}

/** Every RAZORPAY_SYNC_MINUTES, re-read the last 48 hours for every site with API keys. */
export function startRazorpaySyncLoop() {
  if (!config.razorpaySyncMinutes) return;
  const tick = async () => {
    const sites = await db
      .prepare('SELECT * FROM sites WHERE razorpay_key_id IS NOT NULL AND razorpay_key_secret IS NOT NULL')
      .all<Site>()
      .catch(() => ({ results: [] as Site[] }));
    for (const site of sites.results) {
      try {
        const r = await syncRazorpay(db, site, Date.now() - 48 * 3_600_000);
        if (r.imported) console.log(`razorpay sync ${site.domain}: imported ${r.imported} missed payment(s)`);
      } catch (e) {
        console.warn(`razorpay sync ${site.domain} failed: ${(e as Error).message}`);
      }
    }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, config.razorpaySyncMinutes * 60_000).unref();
}
