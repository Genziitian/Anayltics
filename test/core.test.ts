import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { belongsTo, normalizePath } from '../src/server/collect';
import { toPgPlaceholders } from '../src/server/db';
import type { Site } from '../src/server/env';
import { dodoPaymentInput } from '../src/server/dodo';
import { verifyRazorpaySignature, verifyStandardWebhook } from '../src/server/lib/crypto';
import { pickClientIp } from '../src/server/lib/net';
import { bucketLabels, resolveRange, startOfDay, tzOffset } from '../src/server/lib/time';
import { isBot, parseUA } from '../src/server/lib/ua';
import { normalizePhone } from '../src/server/payments';
import { paymentFromRazorpay } from '../src/server/razorpay';
import { globToLike } from '../src/server/stats';

describe('classify', () => {
  it('maps t.co to X / social', () => {
    expect(classify({ referrerDomain: 't.co' })).toMatchObject({ source: 'X', channel: 'Organic Social' });
  });
  it('maps Google to organic search', () => {
    expect(classify({ referrerDomain: 'google.co.in' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });
  it('recognises AI assistants, including utm_source=chatgpt.com', () => {
    expect(classify({ referrerDomain: null, utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('lets ref/utm tags win over the referrer', () => {
    expect(classify({ referrerDomain: 'google.com', ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ referrerDomain: null, ref: 'my-newsletter-42' })).toMatchObject({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('detects paid and email by medium', () => {
    expect(classify({ referrerDomain: 'google.com', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ referrerDomain: null, utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('falls back to Direct', () => {
    expect(classify({ referrerDomain: null })).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  });
  it('knows Indian favourites, including Android app referrers', () => {
    expect(classify({ referrerDomain: 'com.whatsapp' })).toMatchObject({ source: 'WhatsApp', channel: 'Organic Social' });
    expect(classify({ referrerDomain: 'l.instagram.com' })).toMatchObject({ source: 'Instagram' });
    expect(classify({ referrerDomain: 'com.instagram.android' })).toMatchObject({ source: 'Instagram' });
    expect(classify({ referrerDomain: 't.me' })).toMatchObject({ source: 'Telegram' });
    expect(classify({ referrerDomain: null, utmSource: 'whatsapp', utmMedium: 'paid_social' })).toMatchObject({ source: 'WhatsApp', channel: 'Paid' });
  });
  it('does not confuse mail.google.com with Google search', () => {
    expect(classify({ referrerDomain: 'mail.google.com' })).toMatchObject({ source: 'Gmail', channel: 'Email' });
  });
});

describe('user agents', () => {
  it('parses common browsers', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Mobile Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });
    expect(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36').browser).toBe('Chrome');
  });
  it('flags bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
});

describe('domains and paths', () => {
  it('accepts subdomains only', () => {
    expect(belongsTo('app.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('www.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('evilshipkit.dev', 'shipkit.dev')).toBe(false);
  });
  it('normalises paths', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
});

describe('Razorpay webhook signature', () => {
  const secret = 'my-webhook-secret';
  const body = '{"event":"payment.captured"}';
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  it('accepts a valid signature', async () => {
    expect(await verifyRazorpaySignature(secret, body, sig)).toBe(true);
  });
  it('rejects tampering, a wrong secret, and a missing header', async () => {
    expect(await verifyRazorpaySignature(secret, body + ' ', sig)).toBe(false);
    expect(await verifyRazorpaySignature('other', body, sig)).toBe(false);
    expect(await verifyRazorpaySignature(secret, body, undefined)).toBe(false);
  });
});

describe('Razorpay payloads', () => {
  const site = { id: 's1', currency: 'INR' } as Site;
  const payment = {
    id: 'pay_29QQoUBi66xm2f', amount: 49900, currency: 'INR', status: 'captured', method: 'upi', order_id: 'order_9A33XWu170gUtm',
    email: 'Jane@Example.com', contact: '+919876543210', fee: 1178, tax: 180, notes: [], created_at: 1761000000,
  };
  it('maps amounts (paise), fees, method and identity', () => {
    expect(paymentFromRazorpay(site, payment)).toMatchObject({
      id: 'pay_29QQoUBi66xm2f', amount: 49900, currency: 'INR', fee: 1178, tax: 180, method: 'upi',
      email: 'jane@example.com', phone: '+919876543210', orderId: 'order_9A33XWu170gUtm', ts: 1761000000000, visitorId: null,
    });
  });
  it('reads the visitor from order / subscription notes, payment notes winning', () => {
    const p = paymentFromRazorpay(site, { ...payment, notes: { gi_visitor_id: 'from-payment' } }, { order: { notes: { gi_visitor_id: 'from-order', gi_session_id: 'sess' } } });
    expect(p).toMatchObject({ visitorId: 'from-payment', sessionId: 'sess' });
  });
  it('marks later subscription charges as renewals', () => {
    expect(paymentFromRazorpay(site, payment, { subscription: { id: 'sub_1', paid_count: 1, notes: {} } }).renewal).toBe(false);
    expect(paymentFromRazorpay(site, payment, { subscription: { id: 'sub_1', paid_count: 3, notes: {} } })).toMatchObject({ renewal: true, subscriptionId: 'sub_1' });
  });
  it('uses the INR amount for international payments', () => {
    expect(paymentFromRazorpay(site, { ...payment, currency: 'USD', amount: 1000, base_amount: 83000, base_currency: 'INR' })).toMatchObject({ amount: 83000, currency: 'INR' });
  });
  it('takes the buyer from a payment link', () => {
    expect(paymentFromRazorpay(site, { ...payment, email: null }, { paymentLink: { customer: { name: 'Ravi', email: 'ravi@x.in' }, notes: {} } })).toMatchObject({ name: 'Ravi', email: 'ravi@x.in' });
  });
  it('normalises phone numbers to the last 10 digits', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalizePhone('9876543210')).toBe('9876543210');
    expect(normalizePhone('')).toBe(null);
  });
});

describe('SQL helpers', () => {
  it('numbers placeholders but leaves string literals alone', () => {
    expect(toPgPlaceholders("SELECT ? WHERE a = '?' AND b = ?")).toBe("SELECT $1 WHERE a = '?' AND b = $2");
  });
  it('turns funnel globs into LIKE patterns', () => {
    expect(globToLike('/blog/*')).toBe('/blog/%');
    expect(globToLike('/50%_off')).toBe('/50\\%\\_off');
  });
});

describe('Dodo Payments', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const secret = 'whsec_' + key.toString('base64');
  const body = '{"type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  it('accepts a valid Standard Webhooks signature (also among several)', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,old v1,${sig}` }, body)).toBe(true);
  });
  it('rejects tampering and stale timestamps', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body)).toBe(false);
  });
  const site = { id: 's1', currency: 'INR' } as Site;
  const data = {
    payment_id: 'pay_DodoAbc123', total_amount: 1100, currency: 'USD', settlement_amount: 1100, settlement_currency: 'USD',
    customer: { customer_id: 'cus_1', email: 'Buyer@Example.com', name: 'A Buyer' },
    metadata: { gi_visitor_id: 'vid-1', gi_session_id: 'sid-1' }, product_cart: [{ product_id: 'pdt_mac', quantity: 1 }],
  };
  it('maps a payment, keeping USD for conversion later', () => {
    expect(dodoPaymentInput(site, data, 1)).toMatchObject({
      id: 'pay_DodoAbc123', amount: 1100, currency: 'USD', visitorId: 'vid-1', sessionId: 'sid-1', email: 'buyer@example.com', productId: 'pdt_mac',
    });
  });
  it("uses Dodo's own settlement when it's already in the site's currency", () => {
    expect(dodoPaymentInput(site, { ...data, settlement_amount: 102800, settlement_currency: 'INR' }, 1)).toMatchObject({ amount: 102800, currency: 'INR' });
  });
  it('still reads Minilytics-style ml_ metadata', () => {
    expect(dodoPaymentInput(site, { ...data, metadata: { ml_visitor_id: 'old' } }, 1).visitorId).toBe('old');
  });
});

describe('client IP behind proxies', () => {
  const from = (h: Record<string, string>) => (n: string) => h[n];
  it('behind Caddy, uses the address Caddy appended (the last), not one the client made up', () => {
    expect(pickClientIp(from({ 'x-forwarded-for': '6.6.6.6, 49.36.0.1' }), 'x-forwarded-for')).toEqual({ ip: '49.36.0.1', source: 'x-forwarded-for' });
  });
  it("on Render, trusts Cloudflare's header first, and falls back in order", () => {
    const spec = 'cf-connecting-ip,true-client-ip,x-forwarded-for:first';
    expect(pickClientIp(from({ 'cf-connecting-ip': '49.36.0.1', 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }), spec)?.ip).toBe('49.36.0.1');
    expect(pickClientIp(from({ 'true-client-ip': '49.36.0.2' }), spec)?.source).toBe('true-client-ip');
    expect(pickClientIp(from({ 'x-forwarded-for': '49.36.0.3, 10.0.0.1' }), spec)).toEqual({ ip: '49.36.0.3', source: 'x-forwarded-for:first' });
    expect(pickClientIp(from({}), spec)).toBeNull();
  });
});
