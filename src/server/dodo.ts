/**
 * Dodo Payments webhooks, ported from Minilytics / Open Analytics. Dodo is a merchant of record, so it suits
 * international (USD) sales next to Razorpay for India; amounts in another currency are converted to the
 * site's currency at the payment day's rate (lib/fx.ts).
 */
import type { Context } from 'hono';
import { db, type Db } from './db';
import { getSite, type AppEnv, type Site } from './env';
import { verifyStandardWebhook } from './lib/crypto';
import { recordPayment, recordRefund, str, type PaymentInput } from './payments';

function pickMeta(meta: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) if (str(meta[k])) return meta[k] as string;
  return null;
}

export function dodoProducts(data: Record<string, any>): string[] {
  return Array.isArray(data.product_cart) ? data.product_cart.map((p: any) => p?.product_id).filter(Boolean) : [];
}

/** A Dodo payment object (a webhook's `data`) as a payment record. */
export function dodoPaymentInput(site: Site, data: Record<string, any>, ts: number): PaymentInput {
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const meta = { ...(customer.metadata as object), ...(data.metadata as object) } as Record<string, unknown>;
  let amount = Number(data.total_amount) || 0;
  let currency = String(data.currency ?? site.currency).toUpperCase();
  // Settled in the site's currency already? Use Dodo's own conversion instead of ours.
  if (currency !== site.currency && str(data.settlement_currency)?.toUpperCase() === site.currency && Number(data.settlement_amount)) {
    amount = Number(data.settlement_amount);
    currency = site.currency;
  }
  return {
    id: String(data.payment_id),
    provider: 'dodo',
    ts,
    amount,
    kind: 'payment',
    currency,
    // The tracker tags Dodo links with metadata_gi_visitor_id; ml_ keys are what Minilytics / Open Analytics used.
    visitorId: pickMeta(meta, ['gi_visitor_id', 'ml_visitor_id', 'visitor_id']),
    sessionId: pickMeta(meta, ['gi_session_id', 'ml_session_id', 'session_id']),
    customerId: str(customer.customer_id) ?? str(data.customer_id),
    email: str(customer.email)?.toLowerCase() ?? null,
    phone: str(customer.phone_number),
    name: str(customer.name),
    subscriptionId: str(data.subscription_id) ?? (Array.isArray(data.subscription_ids) ? str(data.subscription_ids[0]) : null),
    productId: dodoProducts(data)[0] ?? null,
    method: str(data.payment_method),
  };
}

/** One Dodo account selling several products sends every payment to every webhook: keep only this site's. */
function forThisSite(site: Site, products: string[]): boolean {
  const allowed = (site.dodo_product_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allowed.length || products.some((p) => allowed.includes(p));
}

export async function processDodoEvent(db: Db, site: Site, event: { type?: string; timestamp?: string; data?: Record<string, any> }) {
  const data = event.data ?? {};
  const ts = Date.parse(data.created_at ?? event.timestamp ?? '') || Date.now();
  if (event.type === 'payment.succeeded') {
    if (!forThisSite(site, dodoProducts(data))) return 'ignored: another product';
    await recordPayment(db, site, dodoPaymentInput(site, data, ts));
    return 'payment';
  }
  if (event.type === 'refund.succeeded' && data.payment_id) {
    const known = await db.prepare('SELECT 1 FROM payments WHERE site_id = ? AND id = ?').bind(site.id, String(data.payment_id)).first();
    // A refund of a payment this site never recorded (another product, or from before tracking) isn't this site's.
    if (!known) return 'ignored: unknown payment';
    await recordRefund(db, site, {
      id: String(data.refund_id ?? `refund_${data.payment_id}`),
      paymentId: String(data.payment_id),
      provider: 'dodo',
      ts,
      amount: Number(data.amount) || 0,
      currency: str(data.currency),
    });
    return 'refund';
  }
  return 'ignored';
}

/** Dodo Payments webhook: POST /api/webhooks/dodo/:siteId */
export async function handleDodoWebhook(c: Context<AppEnv>) {
  const site = await getSite(db, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.dodo_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);

  const body = await c.req.text();
  const id = c.req.header('webhook-id') ?? null;
  const ok = await verifyStandardWebhook(
    site.dodo_webhook_secret,
    { id, timestamp: c.req.header('webhook-timestamp') ?? null, signature: c.req.header('webhook-signature') ?? null },
    body,
  );
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  if (id) {
    const seen = await db.prepare("SELECT 1 FROM webhook_events WHERE site_id = ? AND provider = 'dodo' AND event_id = ?").bind(site.id, id).first();
    if (seen) return c.json({ ok: true, duplicate: true });
  }
  let event: Parameters<typeof processDodoEvent>[2];
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const result = await processDodoEvent(db, site, event);
  if (id) {
    await db
      .prepare("INSERT INTO webhook_events (site_id, provider, event_id, received_at) VALUES (?, 'dodo', ?, ?) ON CONFLICT DO NOTHING")
      .bind(site.id, id, Date.now())
      .run();
  }
  // Every other event type is acknowledged so Dodo doesn't retry it.
  return c.json({ ok: true, result });
}
