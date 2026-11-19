// Fills the database in DATABASE_URL with 35 days of fake traffic so you can see the dashboard.
// Usage: npm run seed   (then open the "GI Demo Store" site)
import pg from 'pg';

const DAY = 86_400_000;
const now = Date.now();
const siteId = 'demo0001';
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(rand() * 16).toString(16));

const SOURCES = [
  [{ source: 'Instagram', channel: 'Organic Social', referrer: 'l.instagram.com', domain: 'l.instagram.com' }, 26],
  [{ source: 'Direct/None', channel: 'Direct', referrer: null, domain: null }, 20],
  [{ source: 'Google', channel: 'Organic Search', referrer: 'www.google.co.in', domain: 'google.co.in' }, 16],
  [{ source: 'WhatsApp', channel: 'Organic Social', referrer: null, domain: 'com.whatsapp' }, 10],
  [{ source: 'YouTube', channel: 'Organic Social', referrer: 'www.youtube.com', domain: 'youtube.com' }, 7],
  [{ source: 'X', channel: 'Organic Social', referrer: 't.co', domain: 't.co' }, 5],
  [{ source: 'ChatGPT', channel: 'AI', referrer: 'chatgpt.com', domain: 'chatgpt.com' }, 4],
  [{ source: 'LinkedIn', channel: 'Organic Social', referrer: 'www.linkedin.com', domain: 'linkedin.com' }, 4],
  [{ source: 'Facebook', channel: 'Organic Social', referrer: 'm.facebook.com', domain: 'm.facebook.com' }, 3],
  [{ source: 'Telegram', channel: 'Organic Social', referrer: 't.me', domain: 't.me' }, 2],
  [{ source: 'Quora', channel: 'Organic Social', referrer: 'www.quora.com', domain: 'quora.com' }, 2],
  [{ source: 'Perplexity', channel: 'AI', referrer: 'www.perplexity.ai', domain: 'perplexity.ai' }, 1],
];
const CAMPAIGNS = { Instagram: ['diwali-reel', 'creator-collab', 'story-swipeup'], YouTube: ['review-video'], WhatsApp: ['broadcast-oct'] };
const PAGES = ['/', '/', '/', '/pricing', '/blog/gst-for-freelancers', '/blog/upi-payments-guide', '/features', '/docs', '/changelog', '/about'];
const COUNTRIES = [['IN', 'Karnataka', 'Bengaluru'], ['IN', 'Maharashtra', 'Mumbai'], ['IN', 'Maharashtra', 'Pune'], ['IN', 'Delhi', 'New Delhi'], ['IN', 'Telangana', 'Hyderabad'], ['IN', 'Tamil Nadu', 'Chennai'], ['IN', 'West Bengal', 'Kolkata'], ['IN', 'Gujarat', 'Ahmedabad'], ['IN', 'Rajasthan', 'Jaipur'], ['AE', 'Dubai', 'Dubai'], ['US', 'California', 'San Francisco'], ['GB', 'England', 'London']];
const DEVICES = [[['Chrome', 'Android', 'Mobile'], 42], [['Instagram', 'Android', 'Mobile'], 10], [['Mobile Safari', 'iOS', 'Mobile'], 12], [['Chrome', 'Windows', 'Desktop'], 18], [['Chrome', 'Mac OS', 'Desktop'], 8], [['Samsung Internet', 'Android', 'Mobile'], 5], [['Edge', 'Windows', 'Desktop'], 3], [['Firefox', 'Linux', 'Desktop'], 2]];
const NAMES = ['Priya Sharma', 'Rahul Verma', 'Ananya Iyer', 'Arjun Reddy', 'Sneha Patil', 'Vikram Singh', 'Kavya Nair', 'Rohan Gupta', 'Ishita Das', 'Aditya Rao', 'Meera Joshi', 'Karthik Subramanian', 'Neha Kapoor', 'Sahil Mehta'];

const out = [];
out.push(`DELETE FROM events WHERE site_id = '${siteId}';`, `DELETE FROM sessions WHERE site_id = '${siteId}';`, `DELETE FROM visitors WHERE site_id = '${siteId}';`, `DELETE FROM payments WHERE site_id = '${siteId}';`, `DELETE FROM payment_claims WHERE site_id = '${siteId}';`, `DELETE FROM funnels WHERE site_id = '${siteId}';`, `DELETE FROM sites WHERE id = '${siteId}';`);
out.push(`INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('${siteId}', 'GI Demo Store', 'demo.gitracker.in', 'Asia/Kolkata', 'INR', 'gi_demo_key', ${now - 60 * DAY});`);
out.push(`INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES ('fun00001', '${siteId}', 'Landing → Checkout', ${q(JSON.stringify([{ type: 'page', value: '/' }, { type: 'page', value: '/pricing' }, { type: 'goal', value: 'checkout_click' }]))}, ${now});`);

let payN = 0;
for (let d = 34; d >= 0; d--) {
  const spike = d === 9 ? 3.2 : d === 24 ? 1.8 : 1;
  const sessionsToday = Math.round((120 + rand() * 90 + Math.sin(d / 2) * 40) * spike);
  for (let i = 0; i < sessionsToday; i++) {
    const start = now - d * DAY - Math.floor(rand() * DAY);
    if (start > now) continue;
    const src = weighted(SOURCES);
    const s = d === 9 && rand() < 0.6 ? SOURCES[0][0] : src;
    const vid = uuid(), sid = uuid();
    const [country, region, city] = pick(COUNTRIES);
    const [browser, os, device] = weighted(DEVICES);
    const camp = CAMPAIGNS[s.source] && rand() < 0.7 ? pick(CAMPAIGNS[s.source]) : null;
    const entry = s.source === 'Google' ? pick(['/blog/gst-for-freelancers', '/blog/upi-payments-guide', '/']) : s.source === 'Quora' ? '/blog/upi-payments-guide' : pick(PAGES.slice(0, 5));
    const bounce = rand() < 0.62;
    const pages = [entry];
    if (!bounce) for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) pages.push(pick(PAGES));
    const wantsToBuy = !bounce && rand() < (s.channel === 'Direct' ? 0.05 : s.source === 'Instagram' ? 0.045 : 0.03);
    if (wantsToBuy && !pages.includes('/pricing')) pages.push('/pricing');
    const duration = bounce ? Math.floor(rand() * 25_000) : Math.floor(20_000 + rand() * 300_000);
    let t = start;
    const events = pages.map((p) => {
      const e = [t, 'pageview', null, p];
      t += Math.floor(duration / pages.length);
      return e;
    });
    if (!bounce && rand() < 0.25) events.push([t, 'goal', 'signup_click', pages.at(-1)]);
    if (wantsToBuy) events.push([t + 1000, 'goal', 'checkout_click', '/pricing'], [t + 2000, 'goal', 'razorpay_checkout_open', '/pricing']);
    else if (!bounce && rand() < 0.1) events.push([t, 'outbound', pick(['https://instagram.com/gidemo', 'https://wa.me/919800000000', 'https://youtube.com/@gidemo']), pages.at(-1)]);
    const goals = events.filter((e) => e[1] === 'goal').length;
    const last = Math.min(now, events.at(-1)[0] + 5000);

    const paid = wantsToBuy && rand() < 0.75;
    const name = paid ? pick(NAMES) : null;
    out.push(`INSERT INTO visitors (site_id, id, first_seen, name, email) VALUES ('${siteId}', '${vid}', ${start - (paid && rand() < 0.5 ? Math.floor(rand() * 10 * DAY) : 0)}, ${q(name)}, ${q(name ? name.toLowerCase().replace(' ', '.') + '@example.com' : null)});`);
    out.push(
      `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, hostname, entry_page, exit_page, referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, country, region, city, browser, os, device) VALUES ('${siteId}', '${sid}', '${vid}', ${start}, ${last}, ${duration}, ${pages.length}, ${goals}, 'demo.gitracker.in', ${q(entry)}, ${q(pages.at(-1))}, ${q(s.referrer)}, ${q(s.domain)}, ${q(s.source)}, ${q(s.channel)}, ${q(camp ? s.source.toLowerCase() : null)}, ${q(camp ? 'social' : null)}, ${q(camp)}, NULL, NULL, NULL, '${country}', ${q(region)}, ${q(city)}, '${browser}', '${os}', '${device}');`,
    );
    for (const [ts, type, n, p] of events) out.push(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES ('${siteId}', '${sid}', '${vid}', ${ts}, '${type}', ${q(n)}, ${q(p)});`);
    if (paid) {
      const amount = pick([49900, 99900, 99900, 199900, 299900]); // paise
      const fee = Math.round(amount * 0.0236); // 2% + 18% GST
      const tax = Math.round((fee * 18) / 118);
      out.push(`INSERT INTO payments (site_id, id, provider, ts, amount, kind, currency, fee, tax, method, visitor_id, session_id, customer_id, email, name, matched_by) VALUES ('${siteId}', 'pay_demo${String(++payN).padStart(6, '0')}', 'razorpay', ${t + 60_000 > now ? now - 1000 : t + 60_000}, ${amount}, 'payment', 'INR', ${fee}, ${tax}, '${weighted([['upi', 70], ['card', 20], ['netbanking', 7], ['wallet', 3]])}', '${vid}', '${sid}', 'cust_demo${payN}', ${q(name.toLowerCase().replace(' ', '.') + '@example.com')}, ${q(name)}, 'metadata');`);
    }
  }
}
// A few people online right now
for (let i = 0; i < 3; i++) {
  const vid = uuid(), sid = uuid();
  out.push(`INSERT INTO visitors (site_id, id, first_seen) VALUES ('${siteId}', '${vid}', ${now - 60_000});`);
  out.push(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, hostname, entry_page, exit_page, referrer_domain, source, channel, country, browser, os, device) VALUES ('${siteId}', '${sid}', '${vid}', ${now - 90_000}, ${now - 20_000}, 60000, 2, 0, 'demo.gitracker.in', '/', '/pricing', 'l.instagram.com', 'Instagram', 'Organic Social', 'IN', 'Chrome', 'Android', 'Mobile');`);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/gitracker_dev' });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(out.join('\n'));
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  await client.end();
}
console.log(`Seeded "GI Demo Store" (${out.length} statements, ${payN} Razorpay payments)`);
