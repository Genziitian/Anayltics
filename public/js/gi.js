/*! GI Tracker — <script defer data-website-id="SITE_ID" src="https://YOUR-HOST/js/gi.js"></script> */
(function () {
  'use strict';
  var w = window, d = document, loc = w.location, nav = w.navigator;
  var script = d.currentScript;
  if (!script) return;

  var siteId = script.getAttribute('data-website-id');
  var endpoint = script.getAttribute('data-api') || new URL(script.src).origin + '/api/event';
  var allowLocal = script.hasAttribute('data-allow-localhost');
  var cookieDomain = script.getAttribute('data-domain');
  var instrumentRazorpay = script.getAttribute('data-razorpay') !== 'false';
  var VID = 'gi_vid', SID = 'gi_sid', YEAR = 31536000, SESSION = 1800;

  var queued = (w.gitracker && w.gitracker.q) || [];
  function noop() {}

  // Opt yourself out: visit any page with ?gi_ignore=true (undo with ?gi_ignore=false).
  try {
    var ig = new URLSearchParams(loc.search).get('gi_ignore');
    if (ig === 'true') localStorage.setItem('gi_ignore', '1');
    if (ig === 'false') localStorage.removeItem('gi_ignore');
  } catch (e) {}
  var ignored = false;
  try { ignored = localStorage.getItem('gi_ignore') === '1'; } catch (e) {}
  var local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(loc.hostname) || loc.protocol === 'file:';
  if (!siteId || ignored || nav.webdriver || (local && !allowLocal)) {
    w.gitracker = noop;
    w.gitracker.attribution = w.gitracker.razorpayNotes = function () { return {}; };
    w.gitracker.checkoutUrl = function (href) { return String(href); };
    return;
  }

  // ---- cookies (first-party, shared across subdomains so app.site.com and site.com are one visitor)
  function readCookie(name) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function rootDomain() {
    if (cookieDomain) return cookieDomain;
    var parts = loc.hostname.split('.');
    if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1])) return null;
    for (var i = parts.length - 2; i >= 0; i--) {
      var cand = parts.slice(i).join('.');
      d.cookie = 'gi_t=1; path=/; domain=' + cand + '; SameSite=Lax';
      if (readCookie('gi_t')) {
        d.cookie = 'gi_t=; path=/; domain=' + cand + '; max-age=0';
        return cand;
      }
    }
    return null;
  }
  var domain = rootDomain();
  function writeCookie(name, value, maxAge) {
    d.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax' +
      (domain ? '; domain=' + domain : '') + (loc.protocol === 'https:' ? '; Secure' : '');
  }
  function uuid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function ids() {
    var vid = readCookie(VID) || uuid();
    var sid = readCookie(SID) || uuid();
    writeCookie(VID, vid, YEAR);
    writeCookie(SID, sid, SESSION); // sliding 30 minute session
    return { vid: vid, sid: sid };
  }

  // ---- transport
  // Personal data in URLs (e.g. ?email= on a payment return page) never leaves the browser.
  var PRIVATE_PARAM = /^(e-?mail|name|phone|contact|password|pass|token|access_token|id_token|auth|code|secret|key|api_key|license_key|license|razorpay_signature)$/i;
  function cleanUrl(href) {
    try {
      var u = new URL(href);
      var drop = [];
      u.searchParams.forEach(function (_, k) { if (PRIVATE_PARAM.test(k)) drop.push(k); });
      for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
      return u.toString();
    } catch (e) { return href; }
  }
  function send(type, extra, beacon) {
    var id = ids();
    var body = { w: siteId, t: type, u: cleanUrl(loc.href), vid: id.vid, sid: id.sid, sw: w.screen ? screen.width : 0 };
    for (var k in extra) if (extra[k] !== undefined) body[k] = extra[k];
    var json = JSON.stringify(body);
    // text/plain keeps this a "simple" request: no CORS preflight, works with sendBeacon.
    if (beacon && nav.sendBeacon) {
      try { if (nav.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
    }
    try {
      fetch(endpoint, { method: 'POST', body: json, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(noop);
    } catch (e) {}
  }

  // ---- engaged time (only while the tab is visible)
  var visibleSince = d.visibilityState === 'visible' ? Date.now() : 0;
  var pending = 0, pings = 0;
  function flushTime(beacon) {
    if (visibleSince) { pending += Date.now() - visibleSince; visibleSince = d.visibilityState === 'visible' ? Date.now() : 0; }
    if (pending >= 1000) { send('ping', { d: Math.round(pending) }, beacon); pending = 0; }
  }
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'visible') visibleSince = Date.now();
    else flushTime(true);
  });
  w.addEventListener('pagehide', function () { flushTime(true); });
  setInterval(function () {
    if (d.visibilityState === 'visible' && pings < 30) { pings++; flushTime(false); }
  }, 60000);

  // ---- pageviews (including single-page-app navigation)
  var lastPage = null, firstView = true;
  // The address the page was opened with. Sites often strip ?payment_id= or ?utm_… with history.replaceState
  // before this (deferred) script runs; the browser's navigation record still has them.
  function landingUrl() {
    try {
      var nav = w.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (nav && nav.name) {
        var o = new URL(nav.name);
        if (o.origin === loc.origin && o.pathname === loc.pathname && o.search && !loc.search) return o.href;
      }
    } catch (e) {}
    return loc.href;
  }
  function pageview() {
    var page = loc.pathname + loc.search;
    if (page === lastPage) return;
    if (lastPage !== null) flushTime(false);
    lastPage = page;
    pings = 0;
    installRazorpayHook();
    send('pageview', firstView ? { r: d.referrer, u: cleanUrl(landingUrl()) } : { r: '' });
    firstView = false;
  }
  var hist = w.history;
  if (hist && hist.pushState) {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = hist[fn];
      hist[fn] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
    });
    w.addEventListener('popstate', pageview);
  }

  // ---- goals and outbound links
  function goal(name, props) {
    if (!name) return;
    send('goal', { n: String(name).slice(0, 64), p: props || undefined }, true);
  }
  function attribution() {
    var id = ids();
    return { gi_visitor_id: id.vid, gi_session_id: id.sid };
  }

  // ---- Razorpay Checkout: tag every payment with the visitor, and report successful payments.
  // Wraps window.Razorpay (whether checkout.js loads before or after this script), so `new Razorpay(options)`
  // gets gi_visitor_id / gi_session_id in options.notes, and options.handler also tells us the payment id.
  function withNotes(options) {
    var o = {}, k;
    for (k in options) o[k] = options[k];
    var notes = {}, src = options.notes, count = 0;
    if (src && typeof src === 'object' && !(src instanceof Array)) for (k in src) { notes[k] = src[k]; count++; }
    var att = attribution();
    // Razorpay allows at most 15 notes; never push out the merchant's own.
    if (!notes.gi_visitor_id && count < 15) { notes.gi_visitor_id = att.gi_visitor_id; count++; }
    if (!notes.gi_session_id && count < 15) notes.gi_session_id = att.gi_session_id;
    o.notes = notes;
    // Only wrap a handler the merchant set: adding one where there was none would stop Razorpay from
    // redirecting to callback_url (that redirect is claimed on the return page instead).
    var handler = options.handler;
    if (typeof handler === 'function') {
      o.handler = function (resp) {
        try {
          // When our hook sits both inside and on top of another script's hook, report the payment once.
          if (resp && resp.razorpay_payment_id && !resp.__giClaimed) {
            try { resp.__giClaimed = true; } catch (e) {}
            send('claim', { p: { payment_id: resp.razorpay_payment_id, order_id: resp.razorpay_order_id, subscription_id: resp.razorpay_subscription_id } }, true);
          }
        } catch (e) {}
        return handler.apply(this, arguments);
      };
    }
    return o;
  }
  function instrument(inst) {
    try {
      var open = inst.open;
      if (typeof open === 'function' && !inst.__giOpen) {
        inst.__giOpen = true;
        inst.open = function () { goal('razorpay_checkout_open'); return open.apply(inst, arguments); };
      }
    } catch (e) {}
    return inst;
  }
  function tagged(args) {
    var a = Array.prototype.slice.call(args);
    try { if (a[0] && typeof a[0] === 'object') a[0] = withNotes(a[0]); } catch (e) {}
    return a;
  }
  // A Proxy, not a replacement function: checkout.js sets Razorpay.method, Razorpay._modules, JSONP callbacks…
  // on window.Razorpay right after defining it, and those must land on Razorpay's own constructor.
  function wrapRazorpay(Orig) {
    if (typeof Orig !== 'function' || Orig.__gi || typeof Proxy !== 'function') return Orig;
    return new Proxy(Orig, {
      construct: function (target, args, newTarget) {
        return instrument(Reflect.construct(target, tagged(args), newTarget));
      },
      apply: function (target, self, args) {
        return instrument(Reflect.apply(target, self, tagged(args)));
      },
      get: function (target, key, receiver) {
        return key === '__gi' ? true : Reflect.get(target, key, receiver);
      },
    });
  }
  // The hook on window.Razorpay works alongside any other script that hooks it too (sites often do, e.g. to log
  // payment attempts): an existing getter/setter is kept and ours goes on top, and if another script replaces
  // ours later, installRazorpayHook() puts it back on top of theirs. It runs now, on load, on every route change,
  // and right before any click or Enter, which is always before a checkout can open.
  var rzpValue, rzpPrev = null;
  var rzpProxies = typeof WeakMap === 'function' ? new WeakMap() : null;
  function rzpWrapped(v) {
    if (typeof v !== 'function' || v.__gi) return v;
    var p = rzpProxies && rzpProxies.get(v);
    if (!p) {
      p = wrapRazorpay(v);
      if (rzpProxies) rzpProxies.set(v, p);
    }
    return p;
  }
  function rzpGet() {
    return rzpWrapped(rzpPrev ? rzpPrev.get.call(w) : rzpValue);
  }
  function rzpSet(v) {
    if (!rzpPrev) rzpValue = v;
    else if (rzpPrev.set) rzpPrev.set.call(w, v);
  }
  function installRazorpayHook() {
    if (!instrumentRazorpay) return;
    var desc;
    try { desc = Object.getOwnPropertyDescriptor(w, 'Razorpay'); } catch (e) { return; }
    if (desc && desc.get === rzpGet) return;
    if (desc && desc.configurable === false) return;
    if (desc && (desc.get || desc.set)) {
      rzpPrev = { get: desc.get || function () { return undefined; }, set: desc.set };
    } else {
      rzpPrev = null;
      rzpValue = desc ? desc.value : undefined;
    }
    try {
      Object.defineProperty(w, 'Razorpay', { configurable: true, enumerable: true, get: rzpGet, set: rzpSet });
    } catch (e) {}
  }
  installRazorpayHook();
  if (instrumentRazorpay) {
    d.addEventListener('DOMContentLoaded', installRazorpayHook);
    w.addEventListener('load', installRazorpayHook);
    setTimeout(installRazorpayHook, 1000);
    setTimeout(installRazorpayHook, 5000);
  }

  // ---- Dodo Payments checkout links carry the visitor as metadata. They're tagged as soon as they appear on the
  // page, not just on click, because other scripts may copy the href and navigate before our click handler runs.
  // Sites that open checkout from JavaScript can call gitracker.checkoutUrl(url) to get the tagged address.
  function checkoutUrl(href) {
    try {
      var u = new URL(href, loc.href);
      if (!/(^|\.)dodopayments\.com$/.test(u.hostname)) return String(href);
      var att = attribution();
      u.searchParams.set('metadata_gi_visitor_id', att.gi_visitor_id);
      u.searchParams.set('metadata_gi_session_id', att.gi_session_id);
      return u.toString();
    } catch (e) {
      return String(href);
    }
  }
  function tagCheckoutLink(a) {
    var next = checkoutUrl(a.href);
    if (a.href !== next) a.href = next;
  }
  function tagCheckoutLinks() {
    var links = d.querySelectorAll('a[href*="dodopayments.com"]');
    for (var i = 0; i < links.length; i++) tagCheckoutLink(links[i]);
  }
  var tagQueued = false;
  function queueTag() {
    if (tagQueued) return;
    tagQueued = true;
    setTimeout(function () { tagQueued = false; tagCheckoutLinks(); }, 50);
  }
  if (w.MutationObserver) {
    new MutationObserver(queueTag).observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', tagCheckoutLinks);
  else tagCheckoutLinks();
  // Refresh right before a click starts, in case the session id rotated while the page sat idle.
  function onPress(e) {
    installRazorpayHook();
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) tagCheckoutLink(a);
  }
  d.addEventListener('pointerdown', onPress, true);
  d.addEventListener('keydown', function (e) { if (e.key === 'Enter') onPress(e); }, true);

  function onClick(e) {
    var el = e.target && e.target.closest ? e.target : null;
    if (!el) return;
    var g = el.closest('[data-gi-goal]');
    if (g) {
      var props = {};
      for (var i = 0; i < g.attributes.length; i++) {
        var at = g.attributes[i];
        if (at.name.indexOf('data-gi-goal-') === 0) props[at.name.slice(13)] = at.value.slice(0, 255);
      }
      goal(g.getAttribute('data-gi-goal'), Object.keys(props).length ? props : undefined);
    }
    var a = el.closest('a[href]');
    if (a) {
      tagCheckoutLink(a);
      try {
        var u = new URL(a.href, loc.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== loc.hostname && !(domain && u.hostname.slice(-domain.length) === domain)) {
          send('outbound', { n: u.origin + u.pathname }, true);
        }
      } catch (err) {}
    }
  }
  d.addEventListener('click', onClick, true);
  d.addEventListener('auxclick', onClick, true);

  // ---- public API
  function api(cmd, a, b) {
    if (cmd === 'goal' || cmd === 'track') goal(a, b);
    else if (cmd === 'identify' && a) send('identify', { p: { user_id: a.user_id || a.id, email: a.email, name: a.name, phone: a.phone } });
    else if (cmd === 'pageview') { lastPage = null; pageview(); }
  }
  // For server-side orders: send these to your backend and put them in the order's notes.
  api.attribution = attribution;
  api.razorpayNotes = attribution;
  api.checkoutUrl = checkoutUrl;
  w.gitracker = api;

  pageview();
  for (var q = 0; q < queued.length; q++) api.apply(null, queued[q]);
})();
