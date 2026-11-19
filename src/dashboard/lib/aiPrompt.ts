import type { Site } from './api';

/**
 * A copy-paste prompt for the site owner's coding AI (Claude Code, Cursor, Copilot…),
 * filled with this site's real values so the AI can install tracking and revenue attribution itself.
 * The API key and webhook secret are deliberately left out: the integration doesn't need them in code.
 */
export function buildAiPrompt(site: Site, origin: string): string {
  const script = `<script defer data-website-id="${site.id}" src="${origin}/js/gi.js"></script>`;
  return `You are setting up GI Tracker analytics + Razorpay revenue attribution in this codebase. GI Tracker is my self-hosted analytics (like Plausible, but it also shows which traffic source made money). Do the work directly in the code. Only ask me questions about things you cannot find out by reading the codebase, and ask them all together, up front, before making changes.

## My GI Tracker values (already correct — use them as-is)
- Dashboard / API host: ${origin}
- Website ID: ${site.id}
- Tracked domain: ${site.domain} (all subdomains such as app.${site.domain} count as the same site)
- Revenue currency: ${site.currency}
- Script tag:
  ${script}

## Task 1 — Install the tracking script on every page
- Find how this project renders the HTML <head> (e.g. Next.js app/layout.tsx or pages/_document.tsx, Vite/CRA index.html, Astro/Nuxt/SvelteKit/Remix root layout, plain HTML files, WordPress header.php…) and add the script tag so it loads on EVERY page, including the logged-in app, checkout pages and any subdomains that live in this repo.
- Next.js: use next/script: <Script defer data-website-id="${site.id}" src="${origin}/js/gi.js" strategy="afterInteractive" />
- Keep the exact attributes. Load it once only. Single-page-app navigation is tracked automatically; do not add manual pageview calls.
- If the project has a Content-Security-Policy, allow ${origin} in script-src and connect-src.

## Task 2 — Revenue attribution with Razorpay (most important)
The script stores two first-party cookies: \`gi_vid\` (visitor id) and \`gi_sid\` (session id). Every Razorpay payment should carry them in its \`notes\` so GI Tracker knows which visitor (and therefore which Instagram post / Google search / campaign) made the money.
- Search the codebase for payment code: "razorpay", "Razorpay(", "checkout.razorpay.com", "orders.create", "subscriptions.create", "paymentLink.create", "rzp.io", "razorpay.me", "pages.razorpay.com", "dodopayments", "checkoutSessions.create".
- Browser Checkout (\`new Razorpay(options)\` with checkout.js): the GI Tracker script already adds gi_visitor_id / gi_session_id to options.notes and reports the payment id from the success handler. No change needed, but make sure the GI Tracker script loads on that page.
- Where an ORDER, SUBSCRIPTION or PAYMENT LINK is created on the SERVER, read the cookies from the incoming request and MERGE them into the existing notes (never drop existing keys; Razorpay allows at most 15 notes):
    notes: { ...existingNotes, gi_visitor_id: <cookie gi_vid> ?? '', gi_session_id: <cookie gi_sid> ?? '' }
  Next.js App Router example: const jar = await cookies(); jar.get('gi_vid')?.value
- If the request that creates the order goes from the BROWSER to an API on a different domain (so cookies aren't sent), read the ids in the browser with window.gitracker.razorpayNotes() (returns { gi_visitor_id, gi_session_id }) and send them in the request body, then put them in notes on the server.
- Payment Links / Payment Pages / Payment Buttons: make sure they redirect back to a page on this site (callback_url + callback_method: 'get' for links created via the API, or the "redirect after payment" setting) and that page loads the GI Tracker script. Razorpay appends ?razorpay_payment_id=... to it, and GI Tracker uses that to link the payment. Keep those query params on the URL until the page has loaded.
- Dodo Payments (often used for international / USD sales): plain links (<a href="https://checkout.dodopayments.com/buy/...">) need no change, the script tags them. Where code opens a Dodo checkout from JavaScript (window.location.href = ..., window.open(...)), pass the URL through the tracker first: window.gitracker?.checkoutUrl ? window.gitracker.checkoutUrl(url) : url. Where a checkout session is created on the server, merge gi_visitor_id / gi_session_id (from the gi_vid / gi_sid cookies) into its metadata. Keep the return/redirect URL on this site; Dodo adds ?payment_id=..., which GI Tracker uses even if the page later removes it from the address bar.
- Do NOT add payment webhooks for GI Tracker in this codebase. I connect them myself in the providers' dashboards (Razorpay: ${origin}/api/webhooks/razorpay/${site.id}, Dodo: ${origin}/api/webhooks/dodo/${site.id}).

## Task 3 — Identify logged-in users
Right after a successful login/signup (and on app load when a user session exists), call:
  window.gitracker?.('identify', { user_id: user.id, email: user.email, phone: user.phone, name: user.name })
This links anonymous visits to the person, and is a fallback for attributing payments by email or phone (Razorpay always collects a phone number).

## Task 4 — Track key buttons as goals
Add data attributes to the most important calls-to-action (no JS needed), using short snake_case names:
  <button data-gi-goal="signup_click">  ·  data-gi-goal="start_trial"  ·  data-gi-goal="pricing_cta"  ·  data-gi-goal="checkout_click"
Optional details: data-gi-goal-plan="pro". From code: window.gitracker?.('goal', 'signup_completed', { plan: 'pro' }).
Track at least: the main signup/get-started button(s), pricing-page plan buttons, and the buy/pay button. Also fire window.gitracker?.('goal', 'signup_completed') after a successful signup.

## TypeScript
If the project uses TypeScript, add a global declaration so calls type-check:
  declare global { interface Window { gitracker?: ((cmd: 'goal' | 'identify' | 'pageview', a?: any, b?: any) => void) & { attribution?: () => { gi_visitor_id?: string; gi_session_id?: string }; razorpayNotes?: () => { gi_visitor_id?: string; gi_session_id?: string } } } }
Always call it with optional chaining (window.gitracker?.(...)) so pages never break if the script is blocked.

## Rules
- Make minimal, focused changes that match the existing code style. Don't refactor unrelated code.
- Don't hardcode secrets. None are needed for this setup.
- The script ignores localhost by default. To test locally add data-allow-localhost to the script tag temporarily (remove it before committing), or test on the deployed site.

## When you are done, reply with
1. A list of every file you changed and why.
2. Which Razorpay code paths now send gi_visitor_id / gi_session_id in notes (and any you could not find or were unsure about).
3. Which goals you added and where.
4. How I can verify: open the site, in DevTools → Network a POST to ${origin}/api/event returns 202, and the visit appears in my GI Tracker dashboard within seconds. Then make a Razorpay test-mode payment and check it appears in the Journey tab.`;
}
