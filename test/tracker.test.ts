import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/js/gi.js', import.meta.url), 'utf8');

/** Run the tracker in a tiny fake browser and collect what it sends. */
function load(opts: { attrs?: Record<string, string>; razorpayFirst?: boolean; href?: string; openedAs?: string } = {}) {
  const attrs: Record<string, string> = { 'data-website-id': 'site1234', ...opts.attrs };
  const jar = new Map<string, string>();
  const sent: Promise<any>[] = [];

  class FakeRazorpay {
    static seen: any[] = [];
    options: any;
    constructor(options: any) {
      this.options = options;
      FakeRazorpay.seen.push(options);
    }
    open() {
      return 'opened';
    }
  }

  const document = {
    currentScript: {
      src: 'https://stats.example.com/js/gi.js',
      getAttribute: (n: string) => attrs[n] ?? null,
      hasAttribute: (n: string) => n in attrs,
    },
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(c: string) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/max-age=0/.test(c)) jar.delete(k.trim());
      else jar.set(k.trim(), v);
    },
    referrer: '',
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener() {},
    querySelectorAll: () => [],
  };
  const href = opts.href ?? 'https://shop.example.in/pricing';
  const u = new URL(href);
  const window: any = {
    document,
    location: { hostname: u.hostname, href, pathname: u.pathname, search: u.search, protocol: u.protocol, origin: u.origin },
    performance: { getEntriesByType: () => [{ name: opts.openedAs ?? href }] },
    navigator: {
      webdriver: false,
      sendBeacon: (_url: string, blob: Blob) => {
        sent.push(blob.text().then(JSON.parse));
        return true;
      },
    },
    history: { pushState() {}, replaceState() {} },
    screen: { width: 1440 },
    crypto: globalThis.crypto,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    fetch: (_url: string, init: { body: string }) => {
      sent.push(Promise.resolve(JSON.parse(init.body)));
      return Promise.resolve();
    },
  };
  if (opts.razorpayFirst) window.Razorpay = FakeRazorpay;
  window.window = window;
  runInNewContext(SOURCE, {
    window,
    document,
    location: window.location,
    navigator: window.navigator,
    screen: window.screen,
    crypto: globalThis.crypto,
    performance: window.performance,
    localStorage: window.localStorage,
    fetch: window.fetch,
    URL,
    URLSearchParams,
    Blob,
    setTimeout,
    setInterval: () => 0,
  });
  return { window, FakeRazorpay, jar, sent: () => Promise.all(sent) };
}

describe('tracker: Razorpay Checkout', () => {
  it('adds the visitor to notes, keeps the merchant’s notes and handler, and claims the payment', async () => {
    const { window, FakeRazorpay, jar, sent } = load({ razorpayFirst: true });
    let handled: any = null;
    const rzp = new window.Razorpay({ key: 'rzp_test', amount: 49900, notes: { plan: 'pro' }, handler: (r: any) => (handled = r) });
    const opts = FakeRazorpay.seen[0];
    expect(opts.notes).toEqual({ plan: 'pro', gi_visitor_id: jar.get('gi_vid'), gi_session_id: jar.get('gi_sid') });
    expect(opts.key).toBe('rzp_test');

    expect(rzp.open()).toBe('opened');
    opts.handler({ razorpay_payment_id: 'pay_ABC123456', razorpay_order_id: 'order_XYZ123456', razorpay_signature: 'sig' });
    expect(handled.razorpay_payment_id).toBe('pay_ABC123456');

    const events = await sent();
    expect(events.find((e) => e.t === 'goal')).toMatchObject({ n: 'razorpay_checkout_open' });
    expect(events.find((e) => e.t === 'claim')).toMatchObject({
      w: 'site1234',
      vid: jar.get('gi_vid'),
      p: { payment_id: 'pay_ABC123456', order_id: 'order_XYZ123456' },
    });
  });

  it('wraps checkout.js loaded after the tracker', () => {
    const { window, FakeRazorpay } = load();
    window.Razorpay = FakeRazorpay;
    new window.Razorpay({ key: 'k' });
    expect(FakeRazorpay.seen[0].notes.gi_visitor_id).toMatch(/^[\w-]{8,}$/);
    expect(window.Razorpay.__gi).toBe(true);
  });

  it('passes properties through to Razorpay’s own constructor, like checkout.js expects', () => {
    const { window, FakeRazorpay } = load();
    window.Razorpay = FakeRazorpay;
    // checkout.js does this right after defining window.Razorpay
    window.Razorpay._modules = { upi: true };
    window.Razorpay.callback_1 = () => 'jsonp';
    expect((FakeRazorpay as any)._modules).toEqual({ upi: true });
    expect(window.Razorpay.callback_1()).toBe('jsonp');
    expect(new window.Razorpay({ key: 'k' })).toBeInstanceOf(FakeRazorpay);
    expect(window.Razorpay.prototype).toBe(FakeRazorpay.prototype);
  });

  it('does not add a handler when the merchant uses callback_url instead', () => {
    const { window, FakeRazorpay } = load({ razorpayFirst: true });
    new window.Razorpay({ key: 'k', callback_url: 'https://shop.example.in/thanks', redirect: true });
    expect(FakeRazorpay.seen[0].handler).toBeUndefined();
    expect(FakeRazorpay.seen[0].notes.gi_visitor_id).toBeTruthy();
  });

  it('never exceeds Razorpay’s 15-note limit', () => {
    const { window, FakeRazorpay } = load({ razorpayFirst: true });
    const notes = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 'v']));
    new window.Razorpay({ key: 'k', notes });
    expect(Object.keys(FakeRazorpay.seen[0].notes)).toHaveLength(15);
    expect(FakeRazorpay.seen[0].notes.gi_visitor_id).toBeUndefined();
  });

  it('can be turned off with data-razorpay="false"', () => {
    const { window, FakeRazorpay } = load({ razorpayFirst: true, attrs: { 'data-razorpay': 'false' } });
    expect(window.Razorpay).toBe(FakeRazorpay);
  });

  it('exposes razorpayNotes() for server-side orders', () => {
    const { window, jar } = load();
    expect(window.gitracker.razorpayNotes()).toEqual({ gi_visitor_id: jar.get('gi_vid'), gi_session_id: jar.get('gi_sid') });
  });

  it('sends a pageview on load', async () => {
    const { sent } = load();
    expect((await sent())[0]).toMatchObject({ t: 'pageview', w: 'site1234', u: 'https://shop.example.in/pricing' });
  });
});

describe('tracker: Dodo Payments and return pages', () => {
  it('tags Dodo checkout addresses for sites that redirect from JavaScript, and leaves others alone', () => {
    const { window, jar } = load();
    const tagged = new URL(window.gitracker.checkoutUrl('https://checkout.dodopayments.com/buy/pdt_123?quantity=1'));
    expect(tagged.searchParams.get('metadata_gi_visitor_id')).toBe(jar.get('gi_vid'));
    expect(tagged.searchParams.get('metadata_gi_session_id')).toBe(jar.get('gi_sid'));
    expect(tagged.searchParams.get('quantity')).toBe('1');
    expect(window.gitracker.checkoutUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('reports the payment id even when the site strips it from the address before the script runs', async () => {
    // The page was opened as /?paid=1&payment_id=…, then the site's own script called history.replaceState('/').
    const { sent } = load({ href: 'https://shop.example.in/', openedAs: 'https://shop.example.in/?paid=1&payment_id=pay_DodoAbc123' });
    const first = (await sent())[0];
    expect(first.t).toBe('pageview');
    expect(new URL(first.u).searchParams.get('payment_id')).toBe('pay_DodoAbc123');
  });
});
