// End-to-end smoke test against a running GI Tracker (default http://localhost:8787).
//   Terminal 1: RAZORPAY_API_BASE=http://localhost:8799 FX_API_BASE=http://localhost:8799/fx npm run dev:api
//   Terminal 2: npm run smoke          (signs in with ADMIN_EMAIL / ADMIN_PASSWORD from .env)
// It starts a fake Razorpay API and a fake exchange-rate API (1 USD = 90 INR) on :8799.
import crypto from 'node:crypto';
import http from 'node:http';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const EMAIL = process.env.ADMIN_EMAIL ?? 'you@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-me';
// The dashboard is used from this browser, so its visits must not be counted.
const OWNER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const assert = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
};

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', origin: BASE, 'user-agent': OWNER_UA, cookie: cookieHeader(), ...(opts.headers ?? {}) },
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') jar.delete(k);
    else jar.set(k, v);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const event = (siteId, payload) =>
  fetch(BASE + '/api/event', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': ua }, body: JSON.stringify({ w: siteId, ...payload }) });
const customer = async (siteId) => (await call(`/api/sites/${siteId}/customers?period=today`)).body;

const login = (body, headers = {}) => call('/api/auth/login', { method: 'POST', body: JSON.stringify(body), headers });
assert((await call('/api/sites')).status === 401, 'dashboard API needs login');
const wrong = await login({ email: EMAIL, password: 'nope' });
assert(wrong.status === 401 && /Wrong email or password\. \d tries left/.test(wrong.body.error), `wrong password rejected: "${wrong.body.error}"`);
assert((await login({ email: 'someone@else.com', password: PASSWORD })).status === 401, 'right password with the wrong email rejected');
assert((await login({ email: EMAIL, password: PASSWORD }, { origin: 'https://evil.example' })).status === 403, 'sign-in from another site rejected');
const t0 = Date.now();
assert((await login({ email: EMAIL.toUpperCase(), password: PASSWORD })).status === 200, 'login (email is case-insensitive)');
assert(Date.now() - t0 >= 850, 'sign-in answers take a fixed minimum time');
const sessionName = [...jar.keys()].find((k) => k.endsWith('gi_session'));
assert(sessionName && [...jar.keys()].some((k) => k.endsWith('gi_device')), 'session and device cookies set');
assert((await call('/api/auth/me')).body.loggedIn === true, 'signed in');
const apiHeaders = await fetch(BASE + '/api/sites', { headers: { cookie: cookieHeader(), 'user-agent': OWNER_UA } });
assert(apiHeaders.headers.get('cache-control') === 'no-store', 'API responses are never cached');
const pageHeaders = (await fetch(BASE + '/')).headers;
assert(pageHeaders.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(pageHeaders.get('content-security-policy') ?? ''), 'dashboard cannot be framed');

// Remove leftovers from an interrupted earlier run (payment ids would collide).
for (const old of (await call('/api/sites')).body) if (old.domain === 'smoke-test.in') await call(`/api/sites/${old.id}`, { method: 'DELETE' });

const site = (await call('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'https://www.smoke-test.in/', name: 'Smoke', timezone: 'Asia/Kolkata' }) })).body;
assert(site.domain === 'smoke-test.in' && site.currency === 'INR', 'domain is normalised, currency defaults to INR');

const tracker = await fetch(BASE + '/js/gi.js');
assert(tracker.status === 200 && tracker.headers.get('access-control-allow-origin') === '*', 'tracker served with CORS');
assert((await fetch(BASE + '/site/abc')).headers.get('content-type')?.includes('text/html'), 'dashboard routes fall back to index.html');

const vid = crypto.randomUUID(), sid = crypto.randomUUID();
let r = await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/?utm_campaign=diwali-reel', r: 'https://l.instagram.com/', vid, sid, sw: 1440 });
assert(r.status === 202, 'pageview accepted');
r = await event(site.id, { t: 'pageview', u: 'https://evil.com/', r: '', vid, sid });
assert(r.status === 403, 'other domains rejected');
r = await fetch(BASE + '/api/event', { method: 'POST', headers: { 'user-agent': 'Googlebot/2.1' }, body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://smoke-test.in/', vid, sid }) });
assert(r.status === 202, 'bots silently dropped');
await event(site.id, { t: 'pageview', u: 'https://app.smoke-test.in/pricing/', r: 'https://smoke-test.in/', vid, sid });
await event(site.id, { t: 'goal', u: 'https://app.smoke-test.in/pricing', n: 'razorpay_checkout_open', p: { plan: 'pro' }, vid, sid });
await event(site.id, { t: 'ping', u: 'https://app.smoke-test.in/pricing', d: 42000, vid, sid });
await event(site.id, { t: 'identify', u: 'https://app.smoke-test.in/pricing', p: { email: 'Priya@Acme.in', name: 'Priya Sharma' }, vid, sid });

// A second, bouncing visitor from Google
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/blog/gst-guide', r: 'https://www.google.co.in/', vid: crypto.randomUUID(), sid: crypto.randomUUID() });

// ---- Razorpay webhooks: hex HMAC-SHA256 of the raw body with the webhook secret
const secret = 'whs-' + crypto.randomBytes(12).toString('hex');
await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ razorpay_webhook_secret: secret }) });
assert((await call(`/api/sites/${site.id}`)).body.razorpay_webhook_secret === '••••••••', 'webhook secret is never sent back');

async function rzp(name, payload, { sign = true, eventId = 'evt_' + crypto.randomUUID().slice(0, 14) } = {}) {
  const body = JSON.stringify({ entity: 'event', account_id: 'acc_smoke', event: name, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${BASE}/api/webhooks/razorpay/${site.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign ? sig : 'bad', 'x-razorpay-event-id': eventId },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const payment = (id, extra = {}) => ({
  id, entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', captured: true, method: 'upi',
  order_id: null, email: 'priya@acme.in', contact: '+919876543210', customer_id: 'cust_1', fee: 1178, tax: 180,
  notes: [], created_at: Math.floor(Date.now() / 1000), ...extra,
});
const captured = (p, more = {}) => rzp('payment.captured', { payment: { entity: p }, ...more });

// 1. Checkout with notes (what the tracker adds automatically)
const p1 = payment('pay_Smoke00000001', { notes: { gi_visitor_id: vid, gi_session_id: sid } });
assert((await rzp('payment.captured', { payment: { entity: p1 } }, { sign: false })).status === 401, 'bad webhook signature rejected');
const dupId = 'evt_dup_' + Date.now();
assert((await rzp('payment.captured', { payment: { entity: p1 } }, { eventId: dupId })).body.ok, 'webhook accepted');
assert((await rzp('payment.captured', { payment: { entity: p1 } }, { eventId: dupId })).body.duplicate === true, 'repeat delivery of the same event is skipped');
await rzp('order.paid', { payment: { entity: { ...p1, order_id: 'order_Smoke0000001' } }, order: { entity: { id: 'order_Smoke0000001', notes: [] } } });

// 2. Subscription renewal with no notes: linked through the customer, marked as renewal
await rzp('subscription.charged', {
  payment: { entity: payment('pay_Smoke00000002') },
  subscription: { entity: { id: 'sub_Smoke0000001', customer_id: 'cust_1', paid_count: 2, notes: [] } },
});
// 3. Refund of the renewal
await rzp('refund.processed', {
  refund: { entity: { id: 'rfnd_Smoke000001', payment_id: 'pay_Smoke00000002', amount: 49900, currency: 'INR', status: 'processed', created_at: Math.floor(Date.now() / 1000) } },
  payment: { entity: payment('pay_Smoke00000002') },
});

const o = (await call(`/api/sites/${site.id}/overview?period=today`)).body;
assert(o.current.visitors === 2, `2 visitors (got ${o.current.visitors})`);
assert(o.current.pageviews === 3, `3 pageviews (got ${o.current.pageviews})`);
assert(o.current.revenue === 49900, `revenue ₹499 after refund, order.paid not double counted (got ${o.current.revenue})`);
assert(o.current.fees === 2356 && o.current.netRevenue === 49900 - 2356, `Razorpay fees ${o.current.fees}, net ${o.current.netRevenue}`);
assert(o.current.customers === 1, 'one customer (renewal not double counted)');
assert(Math.abs(o.current.bounceRate - 0.5) < 1e-9, 'bounce rate 50%');
assert(o.current.avgDuration === 21000, `avg session time 21s (got ${o.current.avgDuration})`);
assert(o.online === 2, 'two online');

const src = (await call(`/api/sites/${site.id}/breakdown?period=today&dim=source`)).body;
const ig = src.find((s) => s.label === 'Instagram');
assert(ig && ig.revenue === 49900 && ig.customers === 1, 'revenue credited to Instagram');
assert(src.some((s) => s.label === 'Google' && s.revenue === 0), 'Google visit, no revenue');
const camp = (await call(`/api/sites/${site.id}/breakdown?period=today&dim=campaign`)).body;
assert(camp.some((c) => c.label === 'diwali-reel' && c.revenue === 49900), 'campaign "diwali-reel" made the money');
const pages = (await call(`/api/sites/${site.id}/breakdown?period=today&dim=page`)).body;
assert(pages.some((p) => p.label === '/pricing'), 'trailing slash normalised (/pricing)');
const goals = (await call(`/api/sites/${site.id}/breakdown?period=today&dim=goal`)).body;
assert(goals[0]?.label === 'razorpay_checkout_open' && goals[0].revenue === 49900, 'goal with revenue');
for (const dim of ['channel', 'country', 'browser', 'entry_page', 'exit_link', 'hostname']) {
  assert((await call(`/api/sites/${site.id}/breakdown?period=today&dim=${dim}`)).status === 200, `breakdown by ${dim}`);
}

const filtered = (await call(`/api/sites/${site.id}/overview?period=today&filters=${encodeURIComponent(JSON.stringify({ source: 'Google' }))}`)).body;
assert(filtered.current.visitors === 1 && filtered.current.revenue === 0, 'filter by referrer');
const byPage = (await call(`/api/sites/${site.id}/overview?period=today&filters=${encodeURIComponent(JSON.stringify({ page: '/pricing' }))}`)).body;
assert(byPage.current.visitors === 1, 'filter by visited page');

let cust = await customer(site.id);
assert(cust.length === 2 && cust.some((c) => c.renewal === 1 && c.matched_by === 'customer'), 'journey lists payment + renewal (matched by customer)');
assert(cust.find((c) => c.id === 'pay_Smoke00000001').matched_by === 'metadata', 'checkout payment matched by notes');
const prof = (await call(`/api/sites/${site.id}/visitors/${vid}`)).body;
assert(prof.visitor.email === 'priya@acme.in' && prof.visitor.phone === '9876543210' && prof.events.length === 3 && prof.payments.length === 3, 'visitor profile');
const vis = (await call(`/api/sites/${site.id}/visitors?period=today`)).body;
assert(vis.length === 2 && vis.some((v) => v.source === 'Instagram' && v.spent === 49900), 'visitors list');

const f = (await call(`/api/sites/${site.id}/funnels`, { method: 'POST', body: JSON.stringify({ name: 'Buy', steps: [{ type: 'page', value: '/' }, { type: 'page', value: '/pric*' }, { type: 'goal', value: 'razorpay_checkout_open' }] }) })).body;
const fs = (await call(`/api/sites/${site.id}/funnels/${f.id}/stats?period=today`)).body;
assert(fs.map((s) => s.visitors).join(',') === '1,1,1', `funnel 1,1,1 (got ${fs.map((s) => s.visitors)})`);

const apiPay = await fetch(BASE + '/api/v1/payments', { method: 'POST', headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: 't1', amount: 10.5, visitor_id: vid }) });
assert((await apiPay.json()).attributed === true, 'generic payments API attributes');

// ---- Payments that arrive WITHOUT notes
const fresh = () => ({ v: crypto.randomUUID(), s: crypto.randomUUID() });
// A different buyer each time: unique email, phone and customer id.
const phoneFor = (id) => '+917' + BigInt('0x' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)).toString().slice(0, 9).padEnd(9, '0');
const noNotes = (id, extra = {}) => payment(id, { email: `${id}@example.com`, contact: phoneFor(id), customer_id: 'cust_' + id, ...extra });

// 4. Return page: webhook first, then the buyer lands on /thanks?razorpay_payment_id=...
const a = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: 'https://chatgpt.com/', vid: a.v, sid: a.s });
await captured(noNotes('pay_Return000001'));
let c1 = (await customer(site.id)).find((c) => c.id === 'pay_Return000001');
assert(c1 && !c1.visitor_id, 'payment without notes starts unlinked');
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/thanks?razorpay_payment_id=pay_Return000001&razorpay_payment_link_status=paid&razorpay_signature=abc', r: 'https://rzp.io/', vid: a.v, sid: a.s });
c1 = (await customer(site.id)).find((c) => c.id === 'pay_Return000001');
assert(c1.visitor_id === a.v && c1.source === 'ChatGPT' && c1.matched_by === 'return_page', 'callback page links it and credits ChatGPT');

// 5. Checkout handler claim BEFORE the webhook arrives (order id)
const b = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: 'https://web.whatsapp.com/', vid: b.v, sid: b.s });
await event(site.id, { t: 'claim', u: 'https://smoke-test.in/', p: { payment_id: 'pay_Claim0000001', order_id: 'order_Claim000001' }, vid: b.v, sid: b.s });
await rzp('order.paid', { payment: { entity: noNotes('pay_Claim0000002', { order_id: 'order_Claim000001' }) }, order: { entity: { id: 'order_Claim000001', notes: [] } } });
const c2 = (await customer(site.id)).find((c) => c.id === 'pay_Claim0000002');
assert(c2.visitor_id === b.v && c2.source === 'WhatsApp' && c2.matched_by === 'return_page', 'checkout handler claim (by order id) seen before webhook still links');

// 6. Phone match: an identify()'d visitor pays without notes
const ph = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/?ref=yt-review', r: '', vid: ph.v, sid: ph.s });
await event(site.id, { t: 'identify', u: 'https://smoke-test.in/', p: { phone: '98111 22334' }, vid: ph.v, sid: ph.s });
await captured(noNotes('pay_Phone0000001', { contact: '+919811122334', email: 'other@example.com' }));
const c3 = (await customer(site.id)).find((c) => c.id === 'pay_Phone0000001');
assert(c3.visitor_id === ph.v && c3.matched_by === 'phone' && c3.ref === 'yt-review', 'matched by phone number');

// 7. Timing: exactly one visitor clicked a Razorpay payment link shortly before the payment
const t = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/?ref=medium-article', r: '', vid: t.v, sid: t.s });
await event(site.id, { t: 'outbound', u: 'https://smoke-test.in/', n: 'https://rzp.io/l/smoke', vid: t.v, sid: t.s });
await captured(noNotes('pay_Timing000001'));
const c4 = (await customer(site.id)).find((c) => c.id === 'pay_Timing000001');
assert(c4.visitor_id === t.v && c4.matched_by === 'timing' && c4.ref === 'medium-article', 'timing match credits the medium-article ref');

// 8. A timing guess is replaced when order.paid later brings notes naming someone else
const guess = fresh(), real = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: '', vid: guess.v, sid: guess.s });
await event(site.id, { t: 'outbound', u: 'https://smoke-test.in/', n: 'https://rzp.io/l/smoke', vid: guess.v, sid: guess.s });
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: 'https://www.reddit.com/', vid: real.v, sid: real.s });
const p8 = noNotes('pay_Upgrade00001', { order_id: 'order_Upgrade0001' });
await captured(p8);
assert((await customer(site.id)).find((c) => c.id === 'pay_Upgrade00001').matched_by === 'timing', 'first delivery: matched by timing');
await rzp('order.paid', { payment: { entity: p8 }, order: { entity: { id: 'order_Upgrade0001', notes: { gi_visitor_id: real.v, gi_session_id: real.s } } } });
const c8 = (await customer(site.id)).find((c) => c.id === 'pay_Upgrade00001');
assert(c8.visitor_id === real.v && c8.matched_by === 'metadata' && c8.source === 'Reddit', 'order notes upgrade the timing guess');

// 9. Two clickers who both came back: too close to call, stays unlinked with a reason
const clicker = async () => {
  const x = fresh();
  await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: '', vid: x.v, sid: x.s });
  await event(site.id, { t: 'outbound', u: 'https://smoke-test.in/', n: 'https://rzp.io/l/smoke', vid: x.v, sid: x.s });
  await new Promise((ok) => setTimeout(ok, 20)); // coming back happens after the click, never in the same millisecond
  await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/thanks', r: '', vid: x.v, sid: x.s });
};
await clicker(); await clicker();
await captured(noNotes('pay_Ambiguous001'));
const c9 = (await customer(site.id)).find((c) => c.id === 'pay_Ambiguous001');
assert(!c9.visitor_id, 'ambiguous timing is not guessed');
const rm = (await call(`/api/sites/${site.id}/rematch`, { method: 'POST' })).body;
assert(rm.checked === 1 && rm.matched === 0 && /too close to call/.test(rm.details[0].reason), `rematch explains: "${rm.details?.[0]?.reason}"`);

// 10. Ignored events are acknowledged; failed payments are not revenue
assert((await rzp('payment.failed', { payment: { entity: payment('pay_Failed000001', { status: 'failed', captured: false }) } })).body.result === 'ignored', 'payment.failed ignored');

// ---- Import with API keys, against a fake Razorpay API
const imported = payment('pay_Imported0001', { notes: { gi_visitor_id: vid }, created_at: Math.floor(Date.now() / 1000) - 3600 });
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/fx/')) return res.end(JSON.stringify({ amount: 1, base: 'USD', rates: { INR: 90 } }));
  const ok = req.headers.authorization === 'Basic ' + Buffer.from('rzp_test_smoke:sekret').toString('base64');
  res.setHeader('content-type', 'application/json');
  if (!ok) return res.writeHead(401).end('{"error":{"description":"auth"}}');
  const u = new URL(req.url, 'http://x');
  const skip = Number(u.searchParams.get('skip'));
  if (u.pathname.endsWith('/payments')) return res.end(JSON.stringify({ entity: 'collection', items: skip ? [] : [imported, p1, payment('pay_Failed000002', { status: 'failed', captured: false })] }));
  if (u.pathname.endsWith('/refunds')) return res.end(JSON.stringify({ entity: 'collection', items: [] }));
  res.writeHead(404).end('{}');
});
await new Promise((ok) => fake.listen(8799, ok));
await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ razorpay_key_id: 'rzp_test_smoke', razorpay_key_secret: 'wrong' }) });
const bad = await call(`/api/sites/${site.id}/razorpay/sync`, { method: 'POST', body: JSON.stringify({ days: 7 }) });
assert(bad.status === 400 && /rejected the API key/.test(bad.body.error), `wrong API key explained (got ${JSON.stringify(bad.body)}; is the server running with RAZORPAY_API_BASE=http://localhost:8799?)`);
await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ razorpay_key_secret: 'sekret' }) });
const sync = await call(`/api/sites/${site.id}/razorpay/sync`, { method: 'POST', body: JSON.stringify({ days: 7 }) });
assert(sync.status === 200 && sync.body.imported === 1 && sync.body.payments === 3, `import: 1 new of 3 listed (got ${JSON.stringify(sync.body)})`);
assert((await customer(site.id)).some((c) => c.id === 'pay_Imported0001' && c.visitor_id === vid), 'imported payment attributed from its notes');

// ---- Dodo Payments: USD sales, converted to INR at the day's rate (the fake rate API says 90)
const dodoKey = crypto.randomBytes(24);
await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ dodo_webhook_secret: 'whsec_' + dodoKey.toString('base64') }) });
assert((await call(`/api/sites/${site.id}`)).body.dodo_webhook_secret === '••••••••', 'Dodo secret is never sent back');
async function dodo(type, data, { sign = true, id = 'msg_' + crypto.randomUUID() } = {}) {
  const body = JSON.stringify({ business_id: 'bus_1', type, timestamp: new Date().toISOString(), data });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', dodoKey).update(`${id}.${ts}.${body}`).digest('base64');
  const res = await fetch(`${BASE}/api/webhooks/dodo/${site.id}`, {
    method: 'POST',
    headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign ? `v1,${sig}` : 'v1,bad' },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const usd = (id, extra = {}) => ({
  payload_type: 'Payment', payment_id: id, total_amount: 1100, currency: 'USD', settlement_amount: 1100, settlement_currency: 'USD',
  created_at: new Date().toISOString(), customer: { customer_id: 'cus_' + id, email: `${id}@example.com`, name: 'Intl Buyer' },
  metadata: {}, product_cart: [{ product_id: 'pdt_mac', quantity: 1 }], ...extra,
});
const dv = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/?utm_source=producthunt', r: '', vid: dv.v, sid: dv.s });
const withMeta = usd('pay_DodoUsd0001', { metadata: { gi_visitor_id: dv.v, gi_session_id: dv.s } });
assert((await dodo('payment.succeeded', withMeta, { sign: false })).status === 401, 'bad Dodo signature rejected');
const dodoDup = 'msg_dup_' + Date.now();
assert((await dodo('payment.succeeded', withMeta, { id: dodoDup })).body.result === 'payment', 'Dodo webhook accepted');
assert((await dodo('payment.succeeded', withMeta, { id: dodoDup })).body.duplicate === true, 'repeat Dodo delivery skipped');
const dodoPays = async (v) => (await call(`/api/sites/${site.id}/visitors/${v}`)).body.payments;
const dp = (await dodoPays(dv.v)).find((x) => x.id === 'pay_DodoUsd0001');
assert(
  dp && dp.amount === 99000 && dp.currency === 'INR' && dp.orig_amount === 1100 && dp.orig_currency === 'USD' && dp.provider === 'dodo',
  `$11 stored as ₹990, original kept (got ${dp?.amount} ${dp?.currency}, paid ${dp?.orig_amount} ${dp?.orig_currency})`,
);
const dpc = (await customer(site.id)).find((x) => x.id === 'pay_DodoUsd0001');
assert(dpc.matched_by === 'metadata' && dpc.source === 'Product Hunt', 'Dodo payment credited to Product Hunt through its metadata');

// No metadata (a JavaScript redirect that wasn't tagged): the return page still links it
const dr = fresh();
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/', r: 'https://www.reddit.com/', vid: dr.v, sid: dr.s });
await dodo('payment.succeeded', usd('pay_DodoReturn01'));
await event(site.id, { t: 'pageview', u: 'https://smoke-test.in/?paid=1&payment_id=pay_DodoReturn01&status=succeeded', r: 'https://checkout.dodopayments.com/', vid: dr.v, sid: dr.s });
const dc = (await customer(site.id)).find((x) => x.id === 'pay_DodoReturn01');
assert(dc.visitor_id === dr.v && dc.matched_by === 'return_page' && dc.source === 'Reddit', 'Dodo return page (?payment_id=) links the payment');

// A USD refund uses the payment's own rate
await dodo('refund.succeeded', { payment_id: 'pay_DodoUsd0001', refund_id: 'ref_Dodo0001', amount: 1100, currency: 'USD', created_at: new Date().toISOString() });
const rf = (await dodoPays(dv.v)).find((x) => x.id === 'ref_Dodo0001');
assert(rf && rf.amount === -99000 && rf.orig_amount === -1100 && rf.kind === 'refund', `Dodo USD refund: ${rf?.amount} (${rf?.orig_amount} USD)`);
assert((await dodo('refund.succeeded', { payment_id: 'pay_NeverSeen01', refund_id: 'ref_x', amount: 500, currency: 'USD' })).body.result === 'ignored: unknown payment', 'refund of an unknown payment ignored');

// One Dodo account, several products: only this site's count
const prod = (await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ dodo_product_ids: 'pdt_other, not-a-product' }) })).body;
assert(prod.dodo_product_ids === 'pdt_other', 'product ids cleaned');
assert((await dodo('payment.succeeded', usd('pay_DodoOther01'))).body.result === 'ignored: another product', "another product's payment is ignored");
await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ dodo_product_ids: '' }) });
fake.close();

for (const p of ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', '12m', 'all']) {
  const res = await call(`/api/sites/${site.id}/overview?period=${p}`);
  assert(res.status === 200 && res.body.series.length > 0, `period ${p} (${res.body.series.length} buckets, ${res.body.range.granularity})`);
}
for (const g of ['hour', 'day', 'week', 'month']) {
  const res = await call(`/api/sites/${site.id}/overview?period=30d&granularity=${g}`);
  assert(res.status === 200, `granularity ${g} -> ${res.body.range.granularity}`);
}

// ---- Features merged from Open Analytics
const who = (await call('/api/auth/me')).body;
assert(who.loggedIn && who.user.admin && who.user.email === EMAIL.toLowerCase() && who.hosted === false, 'auth/me describes the owner');
const act = (await call('/api/auth/activity')).body;
assert(act.attempts[0]?.ok === true && act.limits.maxFailures === 5 && /x\.x$|…$/.test(act.attempts[0].network), 'sign-in activity, with masked networks');
const spark = (await call('/api/sites-overview?period=24h')).body.find((x) => x.id === site.id);
assert(spark && spark.series.length === 24 && spark.visitors > 0 && spark.revenue > 0, `sparkline for the websites page (${spark?.visitors} visitors)`);

// Live globe: a visitor from Mumbai shows up with city-level coordinates
const live = crypto.randomUUID();
await fetch(BASE + '/api/event', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': ua, 'x-forwarded-for': '49.36.0.1' }, body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://smoke-test.in/live', vid: live, sid: live }) });
const rt = (await call(`/api/sites/${site.id}/realtime`)).body;
const dot = rt.visitors.find((v) => v.visitor_id === live);
assert(dot && dot.country === 'IN' && typeof dot.lat === 'number' && Math.abs(dot.lat - 19) < 1, `live map: visitor at ${dot?.city} (${dot?.lat}, ${dot?.lon})`);
assert(rt.feed.some((f) => f.type === 'payment') && rt.feed.some((f) => f.type === 'pageview'), 'live feed has pageviews and payments');

// AI crawlers: reported by the site's server, or seen by the script (crawlers that run JavaScript)
const crawl = (body) => fetch(BASE + '/api/v1/crawls', { method: 'POST', headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
assert((await crawl({ user_agent: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', path: '/pricing' })).crawler === 'OpenAI', 'GPTBot crawl recorded');
assert((await crawl({ user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)', url: 'https://smoke-test.in/blog?x=1' })).kind === 'answers', 'ChatGPT answer fetch recorded');
assert((await crawl({ user_agent: ua, path: '/' })).recorded === false, 'ordinary browsers are not crawls');
const visitorsBefore = (await call(`/api/sites/${site.id}/overview?period=today`)).body.current.visitors;
await fetch(BASE + '/api/event', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://smoke-test.in/features', vid: crypto.randomUUID(), sid: crypto.randomUUID() }) });
await new Promise((ok) => setTimeout(ok, 200));
const cr = (await call(`/api/sites/${site.id}/crawls?period=today&kind=answers`)).body;
// indexing: this Googlebot, plus the one from "bots silently dropped" at the start
assert(cr.totals.training === 1 && cr.totals.answers === 1 && cr.totals.indexing === 2 && cr.pages[0]?.path === '/blog', `crawler panel: ${JSON.stringify(cr.totals)}`);
assert((await call(`/api/sites/${site.id}/overview?period=today`)).body.current.visitors === visitorsBefore, 'Googlebot running the script is a crawl, not a visitor');

// Public read-only dashboard
assert((await fetch(`${BASE}/api/public/sites/${site.id}/overview?period=today`)).status === 404, 'private site is not public');
assert((await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ public: 1 }) })).body.public === 1, 'site made public');
const ownerView = (await call(`/api/sites/${site.id}/overview?period=today`)).body.current;
const pub = await fetch(`${BASE}/api/public/sites/${site.id}/overview?period=today`);
assert(pub.status === 200 && (await pub.json()).current.revenue === ownerView.revenue, 'public overview works without login');
const pubLive = await (await fetch(`${BASE}/api/public/sites/${site.id}/realtime`)).json();
assert(pubLive.visitors.every((v) => v.name === undefined && v.email === undefined && v.spent === undefined) && pubLive.feed.every((f) => f.type !== 'payment'), 'public live map hides names and payments');
assert((await fetch(`${BASE}/api/public/sites/${site.id}/customers?period=today`)).status === 404, 'no customer list in public');
assert((await (await fetch(`${BASE}/api/public/sites`)).json()).some((x) => x.id === site.id && x.api_key === undefined), 'public site list (no keys)');

// Pages
const page = await fetch(BASE + '/admin-login');
assert(page.status === 200 && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-robots-tag') === 'noindex', 'sign-in page served with a strict policy, kept out of search');
assert((await fetch(BASE + '/no-such-page')).status === 404, 'unknown pages are real 404s');

// The owner's own browser (the one using the dashboard) isn't counted as a visitor
const before = (await call(`/api/sites/${site.id}/overview?period=today`)).body.current.visitors;
const own = crypto.randomUUID();
await fetch(BASE + '/api/event', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': OWNER_UA }, body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://smoke-test.in/', vid: own, sid: own }) });
assert((await call(`/api/sites/${site.id}/overview?period=today`)).body.current.visitors === before, 'owner visits are not counted');

await call(`/api/sites/${site.id}`, { method: 'DELETE' });
assert((await call(`/api/sites/${site.id}`)).status === 404, 'site deleted');
assert(!(await (await fetch(`${BASE}/api/public/sites`)).json()).some((x) => x.id === site.id), 'a deleted site disappears from public view at once');

// Sign out everywhere: an old session cookie stops working
const oldSession = jar.get(sessionName);
assert((await call('/api/auth/logout-all', { method: 'POST' })).status === 200, 'sign out everywhere');
jar.set(sessionName, oldSession);
assert((await call('/api/auth/me')).body.loggedIn === false, 'old sessions are signed out');
console.log('\nAll smoke tests passed');
