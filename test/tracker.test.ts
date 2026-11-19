import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/js/gi.js', import.meta.url), 'utf8');

/** Run the tracker in a tiny fake browser and collect what it sends. */
function load(opts: { attrs?: Record<string, string>; razorpayFirst?: boolean; href?: string; openedAs?: string; before?: (window: any) => void } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const on = (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn);
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
    addEventListener: on,
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
  opts.before?.(window);
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
  /** A click somewhere on the page (the tracker listens in the capture phase). */
  const press = () => (listeners.pointerdown ?? []).forEach((fn) => fn({ target: null }));
  return { window, FakeRazorpay, jar, press, sent: () => Promise.all(sent) };
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

/**
 * class.genziitian.in hooks window.Razorpay itself, to log payment attempts and show its own popups. This is the
 * same logic as its layout code: a getter/setter that wraps whatever checkout.js assigns, installed once.
 */
function siteHook(win: any, log: string[]) {
  const MARK = '__genzWrapped';
  function wrap(e: any) {
    if (e[MARK]) return e;
    function t(opts: any) {
      const s = { ...opts };
      const merchant = s.handler;
      s.handler = async (r: any) => {
        log.push('site-handler');
        await merchant?.(r);
      };
      return new e(s);
    }
    Object.assign(t, e);
    (t as any)[MARK] = true;
    t.prototype = e.prototype;
    return t;
  }
  if (win.__genzRzpInstalled) return;
  win.__genzRzpInstalled = true;
  let t = win.Razorpay ? wrap(win.Razorpay) : undefined;
  Object.defineProperty(win, 'Razorpay', { configurable: true, get: () => t, set: (e) => (t = e ? wrap(e) : e) });
}

describe('tracker: alongside a site that hooks Razorpay itself', () => {
  async function checkout(env: ReturnType<typeof load>, log: string[]) {
    env.window.Razorpay = env.FakeRazorpay; // checkout.js loads
    const merchant = (r: any) => log.push('merchant-handler:' + r.razorpay_payment_id);
    new env.window.Razorpay({ key: 'k', amount: 49900, order_id: 'order_Abc123456', handler: merchant }).open();
    const final = env.FakeRazorpay.seen[0];
    await final.handler({ razorpay_payment_id: 'pay_Abc1234567', razorpay_order_id: 'order_Abc123456' });
    const events = await env.sent();
    return { final, claims: events.filter((e) => e.t === 'claim'), opens: events.filter((e) => e.n === 'razorpay_checkout_open') };
  }

  it("site hook installed first: both hooks run, the site's popups/logging keep working", async () => {
    const log: string[] = [];
    const env = load({ before: (w) => siteHook(w, log) });
    const { final, claims, opens } = await checkout(env, log);
    expect(final.notes.gi_visitor_id).toBe(env.jar.get('gi_vid'));
    expect(log).toEqual(['site-handler', 'merchant-handler:pay_Abc1234567']);
    expect(claims).toHaveLength(1);
    expect(opens).toHaveLength(1);
  });

  it('site hook installed after ours (replacing it): we get back on top before checkout opens', async () => {
    const log: string[] = [];
    const env = load();
    siteHook(env.window, log); // the site's code runs later and redefines window.Razorpay
    env.press(); // the visitor clicks "Buy"
    const { final, claims, opens } = await checkout(env, log);
    expect(final.notes.gi_visitor_id).toBe(env.jar.get('gi_vid'));
    expect(log).toEqual(['site-handler', 'merchant-handler:pay_Abc1234567']);
    expect(claims).toHaveLength(1);
    expect(opens).toHaveLength(1);
  });

  it('checkout.js loaded before both: our hook ends up inside and on top, still one claim and one open', async () => {
    const log: string[] = [];
    const env = load({ razorpayFirst: true });
    siteHook(env.window, log); // wraps our proxy
    env.press(); // we go on top again
    const merchant = (r: any) => log.push('merchant-handler:' + r.razorpay_payment_id);
    new env.window.Razorpay({ key: 'k', handler: merchant }).open();
    await env.FakeRazorpay.seen[0].handler({ razorpay_payment_id: 'pay_Twice00001' });
    const events = await env.sent();
    expect(events.filter((e) => e.t === 'claim')).toHaveLength(1);
    expect(events.filter((e) => e.n === 'razorpay_checkout_open')).toHaveLength(1);
    expect(log).toEqual(['site-handler', 'merchant-handler:pay_Twice00001']);
  });
});
