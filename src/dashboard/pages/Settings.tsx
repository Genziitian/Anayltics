import { useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { CodeBlock, CopyButton, CopyField } from '../components/CodeBlock';
import { CloseIcon, Favicon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { SecurityPanel } from '../components/SecurityPanel';
import { CurrencySelect, TimezoneSelect } from '../components/SiteFields';
import { CRAWLER_PATTERN } from '../../shared/bots';
import { buildAiPrompt } from '../lib/aiPrompt';
import { api, type Site } from '../lib/api';
import { fmtAgo } from '../lib/format';

function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 last:mb-0">
      <h3 className="text-[17px] font-semibold tracking-tight">{title}</h3>
      {desc && <p className="mt-1 text-sm leading-relaxed text-stone-500">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Code = ({ label, children }: { label?: string; children: string }) => <CodeBlock label={label}>{children}</CodeBlock>;

function SecretField({
  value,
  configured,
  onChange,
  onSave,
  placeholder = 'the secret you typed in Razorpay',
}: {
  value: string;
  configured: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="flex gap-2">
        <input className="input font-mono" type="password" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn-dark" onClick={onSave}>
          Save
        </button>
      </div>
      {configured && <p className="mt-1.5 text-xs text-emerald-600">Connected</p>}
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-5 text-sm">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="num mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-300 text-[11px] font-semibold text-stone-600">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p>{title}</p>
        {children}
      </div>
    </li>
  );
}

type Tab = 'general' | 'install' | 'goals' | 'crawlers' | 'payments' | 'links' | 'sharing' | 'security' | 'delete';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'install', label: 'Install' },
  { id: 'goals', label: 'Goals' },
  { id: 'crawlers', label: 'AI crawlers' },
  { id: 'payments', label: 'Payments' },
  { id: 'links', label: 'Campaign links' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'security', label: 'Sign-in security' },
  { id: 'delete', label: 'Delete website' },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

/**
 * A site's settings, in a panel that slides over its dashboard. One section at a time, picked from the list
 * on the left (along the top on phones). The section is kept in the URL's #hash so a reload stays on it.
 */
export function Settings({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [form, setForm] = useState<Partial<Site>>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.slice(1);
    return isTab(h) ? h : 'general';
  });
  const origin = window.location.origin;

  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(window.history.state, '', `#${t}`);
  };
  const close = () => ((window.history.state as { app?: boolean } | null)?.app ? window.history.back() : navigate(`/site/${siteId}`));

  useEffect(() => {
    api<Site>(`/api/sites/${siteId}`).then((s) => {
      setSite(s);
      setForm({
        name: s.name,
        domain: s.domain,
        timezone: s.timezone,
        currency: s.currency,
        razorpay_webhook_secret: s.razorpay_webhook_secret ?? '',
        razorpay_key_id: s.razorpay_key_id ?? '',
        razorpay_key_secret: s.razorpay_key_secret ?? '',
        dodo_webhook_secret: s.dodo_webhook_secret ?? '',
        dodo_product_ids: s.dodo_product_ids ?? '',
      });
    });
  }, [siteId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  async function save(patch: Partial<Site>, msg = 'Saved') {
    try {
      const s = await api<Site>(`/api/sites/${siteId}`, { method: 'PATCH', json: patch });
      setSite(s);
      setToast({ text: msg });
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    }
  }

  const set = (patch: Partial<Site>) => setForm({ ...form, ...patch });
  const paymentsConnected = !!site?.razorpay_webhook_secret || !!site?.dodo_webhook_secret;

  return (
    <Modal open side bare onClose={close}>
      <header className="flex items-center gap-3 border-b border-stone-200 bg-surface px-5 py-4">
        {site ? <Favicon domain={site.domain} size={26} /> : <span className="h-[26px] w-[26px] rounded bg-stone-100" />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-tight tracking-tight">{site ? `${site.name} settings` : 'Settings'}</h2>
          <p className="truncate text-[13px] text-stone-500">{site?.domain ?? ' '}</p>
        </div>
        <button className="icon-btn -mr-1.5" onClick={close} aria-label="Close settings">
          <CloseIcon />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-stone-200 bg-surface px-3 py-2 sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:py-4" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                tab === t.id ? 'bg-stone-100 font-medium text-ink' : t.id === 'delete' ? 'text-red-600 hover:bg-red-50' : 'text-stone-500 hover:bg-stone-50 hover:text-ink'
              } ${t.id === 'security' ? 'sm:mt-4' : ''}`}
            >
              {t.label}
              {t.id === 'payments' && paymentsConnected && <span className="h-1.5 w-1.5 rounded-full bg-live" title="Connected" />}
            </button>
          ))}
        </nav>

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[640px] px-5 py-7 sm:px-8">
            {!site ? (
              <div className="space-y-3">
                <div className="h-5 w-40 animate-pulse rounded bg-stone-200/70" />
                <div className="h-24 animate-pulse rounded-lg bg-stone-200/50" />
              </div>
            ) : tab === 'general' ? (
              <Section title="General" desc="How this website is named, and which timezone and currency its numbers use.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="set-name">
                      Name
                    </label>
                    <input id="set-name" className="input" value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                  <div>
                    <label className="label" htmlFor="set-domain">
                      Domain
                    </label>
                    <input id="set-domain" className="input" value={form.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Timezone</label>
                    <TimezoneSelect value={form.timezone ?? 'Asia/Kolkata'} onChange={(timezone) => set({ timezone })} />
                    <p className="hint">Where a day starts and ends.</p>
                  </div>
                  <div>
                    <label className="label">Revenue currency</label>
                    <CurrencySelect value={form.currency ?? 'INR'} onChange={(currency) => set({ currency })} />
                  </div>
                </div>
                <button className="btn-dark mt-6" onClick={() => save({ name: form.name, domain: form.domain, timezone: form.timezone, currency: form.currency }, 'Changes saved')}>
                  Save changes
                </button>
              </Section>
            ) : tab === 'install' ? (
              <>
                <Section title="Tracking script" desc={<>Put this in the &lt;head&gt; of every page on {site.domain}.</>}>
                  <Code label="HTML">{`<script defer data-website-id="${site.id}" src="${origin}/js/gi.js"></script>`}</Code>
                  <details className="group mt-4 rounded-lg border border-stone-200 bg-surface px-4 py-3 text-sm">
                    <summary className="cursor-pointer font-medium text-stone-700">Next.js, and getting past ad blockers</summary>
                    <div className="mt-3 space-y-3">
                      <Code label="app/layout.tsx">{`import Script from 'next/script';

<Script defer data-website-id="${site.id}" src="${origin}/js/gi.js" />`}</Code>
                      <p className="text-stone-500">Serve the script from your own domain so ad blockers don't stop it:</p>
                      <Code label="next.config.js">{`async rewrites() {
  return [
    { source: '/stats/s.js', destination: '${origin}/js/gi.js' },
    { source: '/stats/event', destination: '${origin}/api/event' },
  ];
}
// then: <script defer data-website-id="${site.id}" data-api="/stats/event" src="/stats/s.js"></script>`}</Code>
                    </div>
                  </details>
                  <p className="mt-4 text-sm leading-relaxed text-stone-500">
                    Your own visits aren't counted from any browser you've opened this dashboard in. On other devices, like your phone, open{' '}
                    <code className="text-ink">{site.domain}/?gi_ignore=true</code> once.
                  </p>
                </Section>
                <AiSetup site={site} origin={origin} />
              </>
            ) : tab === 'goals' ? (
              <Section title="Goals" desc="Button clicks and other key actions. They show up under Goals on the dashboard.">
                <Code label="HTML and JavaScript">{`<button data-gi-goal="signup">Get started</button>

window.gitracker('goal', 'signup', { plan: 'pro' });
// After login. Email and phone also help match Razorpay payments to the visitor.
window.gitracker('identify', { email: user.email, phone: user.phone, name: user.name });`}</Code>
              </Section>
            ) : tab === 'crawlers' ? (
              <CrawlerSetup site={site} origin={origin} />
            ) : tab === 'payments' ? (
              <Revenue
                site={site}
                origin={origin}
                form={form}
                set={set}
                save={save}
                onKeyRotated={(api_key) => setSite({ ...site, api_key })}
              />
            ) : tab === 'links' ? (
              <LinkBuilder domain={site.domain} />
            ) : tab === 'sharing' ? (
              <Section
                title="Sharing"
                desc="A public dashboard shows visitors, revenue, sources, pages, places, devices, goals and an anonymous live map. Names, emails, settings and keys stay private, and only you can sign in."
              >
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-stone-200 bg-surface px-4 py-3">
                  <span>
                    <span className="block text-sm font-medium">Public dashboard</span>
                    <span className="block text-[13px] text-stone-500">{site.public ? 'Anyone with the link can see it.' : 'Only you can see it.'}</span>
                  </span>
                  <Switch
                    on={!!site.public}
                    label="Public dashboard"
                    onChange={(on) => save({ public: on ? 1 : 0 }, on ? 'Dashboard is public' : 'Dashboard is private')}
                  />
                </label>
                {!!site.public && (
                  <div className="mt-3">
                    <CopyField value={`${origin}/site/${site.id}`} />
                    <p className="hint">Changes can take up to a minute to show for visitors.</p>
                  </div>
                )}
              </Section>
            ) : tab === 'security' ? (
              <SecurityPanel />
            ) : (
              <DeleteSite site={site} />
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className={`oa-pop-in pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg px-3.5 py-2 text-sm font-medium shadow-pop ${
            toast.error ? 'bg-red-600 text-white' : 'bg-ink text-paper'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Modal>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-visitors' : 'bg-stone-300'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

const STACKS = ['Next.js', 'Express', 'Cloudflare', 'Other'] as const;

/**
 * Settings → AI crawlers: crawlers fetch pages without running JavaScript, so the site's own server reports
 * them. The snippets check the user agent against the known list first, so ordinary visitors are never sent.
 */
function CrawlerSetup({ site, origin }: { site: Site; origin: string }) {
  const [stack, setStack] = useState<(typeof STACKS)[number]>('Next.js');
  const re = `/${CRAWLER_PATTERN}/i`;
  const post = (ua: string, path: string, country: string, key: string) =>
    `fetch('${origin}/api/v1/crawls', {
      method: 'POST',
      headers: { authorization: \`Bearer \${${key}}\`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_agent: ${ua}, path: ${path}${country ? `, country: ${country}` : ''} }),
    }).catch(() => {})`;
  const snippets: Record<(typeof STACKS)[number], { label: string; code: string; note: string }> = {
    'Next.js': {
      label: 'middleware.ts (proxy.ts on Next.js 16)',
      note: "Put it next to your app folder. On Next.js 16 the file is proxy.ts and the function is named proxy. Already have one? Add the if block to it.",
      code: `import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

// Search engines and AI crawlers that identify themselves.
const CRAWLERS = ${re};

export function middleware(req: NextRequest, event: NextFetchEvent) {
  const ua = req.headers.get('user-agent') ?? '';
  if (CRAWLERS.test(ua)) {
    event.waitUntil(
      ${post('ua', 'req.nextUrl.pathname', "req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry')", 'process.env.GI_TRACKER_KEY')},
    );
  }
  return NextResponse.next();
}

// Pages, robots.txt, sitemap.xml and llms.txt; not Next.js internals, images, styles or scripts.
export const config = {
  matcher: ['/((?!_next/|.*\\\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)'],
};`,
    },
    Express: {
      label: 'server.js',
      note: 'Add it before your routes.',
      code: `// Search engines and AI crawlers that identify themselves.
const CRAWLERS = ${re};

app.use((req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (CRAWLERS.test(ua)) {
    ${post('ua', 'req.path', '', 'process.env.GI_TRACKER_KEY')};
  }
  next();
});`,
    },
    Cloudflare: {
      label: 'functions/_middleware.js (Pages) or your Worker',
      note: 'Add GI_TRACKER_KEY as a secret: npx wrangler secret put GI_TRACKER_KEY. In a Worker, put the if block at the top of fetch() and use ctx.waitUntil.',
      code: `// Search engines and AI crawlers that identify themselves.
const CRAWLERS = ${re};

export async function onRequest(context) {
  const { request, env } = context;
  const ua = request.headers.get('user-agent') || '';
  if (CRAWLERS.test(ua)) {
    context.waitUntil(
      ${post('ua', 'new URL(request.url).pathname', 'request.cf?.country', 'env.GI_TRACKER_KEY')},
    );
  }
  return context.next();
}`,
    },
    Other: {
      label: 'Any server: one POST per crawler request',
      note: 'Send the request’s user agent and path. Requests that aren’t from a known crawler are ignored, so it’s safe to send more than needed.',
      code: `curl -X POST ${origin}/api/v1/crawls \\
  -H "Authorization: Bearer $GI_TRACKER_KEY" -H "Content-Type: application/json" \\
  -d '{"user_agent":"Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)","path":"/pricing"}'`,
    },
  };
  const s = snippets[stack];
  return (
    <Section
      title="AI crawlers"
      desc="ChatGPT, Claude, Perplexity, Google and other crawlers read your pages without running JavaScript, so the tracking script can't see them. A few lines in your website's server report each crawler visit. Ordinary visitors are never sent."
    >
      <Steps>
        <Step n={1} title={<>Add this key to your website's server environment as <code className="text-ink">GI_TRACKER_KEY</code>:</>}>
          <CopyField value={site.api_key} />
          <p className="hint">Keep it on the server, never in browser code. It can also record payments for {site.name}.</p>
        </Step>
        <Step n={2} title="Add the snippet for your stack:">
          <div className="tabs">
            {STACKS.map((x) => (
              <button key={x} className={`tab ${stack === x ? 'tab-active' : ''}`} onClick={() => setStack(x)}>
                {x}
              </button>
            ))}
          </div>
          <Code label={s.label}>{s.code}</Code>
          <p className="text-[13px] text-stone-500">{s.note}</p>
        </Step>
        <Step n={3} title="Deploy your site. Crawler visits appear under AI crawlers on the dashboard, usually within a day as crawlers come by." />
      </Steps>
      <p className="mt-6 text-[13px] leading-relaxed text-stone-500">
        Google and Bing sometimes run JavaScript, so a few of their visits are counted from the script alone. Crawlers that pretend to be a browser
        can't be told apart from people.
      </p>
    </Section>
  );
}

/** Deleting asks you to type the domain first, right here rather than in a browser prompt. */
function DeleteSite({ site }: { site: Site }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Delete website" desc={`Removes ${site.name} and everything recorded for it: visits, payments, goals and settings. This can't be undone.`}>
      <label className="label" htmlFor="del-confirm">
        Type <span className="font-mono text-ink">{site.domain}</span> to confirm
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id="del-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <button
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={typed.trim().toLowerCase() !== site.domain.toLowerCase() || busy}
          onClick={async () => {
            setBusy(true);
            await api(`/api/sites/${site.id}`, { method: 'DELETE' });
            navigate('/', { replace: true });
          }}
        >
          {busy ? 'Deleting…' : 'Delete website'}
        </button>
      </div>
    </Section>
  );
}

type Provider = 'razorpay' | 'dodo' | 'api';

interface RevenueProps {
  site: Site;
  origin: string;
  form: Partial<Site>;
  set: (patch: Partial<Site>) => void;
  save: (patch: Partial<Site>, msg?: string) => Promise<void>;
  onKeyRotated: (key: string) => void;
}

/** Revenue attribution: Razorpay built in, anything else through the API. */
function Revenue(props: RevenueProps) {
  const { site } = props;
  const [provider, setProvider] = useState<Provider>(site.dodo_webhook_secret && !site.razorpay_webhook_secret ? 'dodo' : 'razorpay');
  const tabs: { id: Provider; label: string; icon: ReactNode; connected?: boolean }[] = [
    { id: 'razorpay', label: 'Razorpay', icon: <Favicon domain="razorpay.com" size={18} />, connected: !!site.razorpay_webhook_secret },
    { id: 'dodo', label: 'Dodo Payments', icon: <Favicon domain="dodopayments.com" size={18} />, connected: !!site.dodo_webhook_secret },
    { id: 'api', label: 'Other / API', icon: <span className="font-mono text-xs text-stone-500">{'{ }'}</span> },
  ];
  return (
    <Section title="Payments" desc="Each payment is linked to the visitor who paid and to the source that brought them.">
      <div className="mb-5 grid grid-cols-3 gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setProvider(t.id)}
            className={`relative flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
              provider === t.id ? 'border-ink bg-stone-50 ring-1 ring-ink' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
            }`}
          >
            {t.icon}
            <span className="truncate">{t.label}</span>
            {t.connected && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-emerald-500" title="Connected" />}
          </button>
        ))}
      </div>
      {provider === 'razorpay' && <RazorpaySetup {...props} />}
      {provider === 'dodo' && <DodoSetup {...props} />}
      {provider === 'api' && <ApiSetup {...props} />}
    </Section>
  );
}

const RAZORPAY_EVENTS = ['payment.captured', 'order.paid', 'subscription.charged', 'payment_link.paid', 'invoice.paid', 'refund.processed'];

function RazorpaySetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step n={1} title={<>In Razorpay → <b>Accounts &amp; Settings → Webhooks → Add New Webhook</b>, use this URL:</>}>
          <CopyField value={`${origin}/api/webhooks/razorpay/${site.id}`} />
          <p className="hint">
            Choose any secret, and tick{' '}
            {RAZORPAY_EVENTS.map((e, i) => (
              <span key={e}>
                {i > 0 && ', '}
                <code>{e}</code>
              </span>
            ))}
            . Add it in Test mode and Live mode separately.
          </p>
        </Step>
        <Step n={2} title="Paste the same webhook secret:">
          <SecretField
            value={form.razorpay_webhook_secret ?? ''}
            configured={!!site.razorpay_webhook_secret}
            onChange={(v) => set({ razorpay_webhook_secret: v })}
            onSave={() => save({ razorpay_webhook_secret: form.razorpay_webhook_secret ?? '' }, 'Razorpay connected')}
          />
        </Step>
        <Step
          n={3}
          title={
            <>
              <b>Razorpay Checkout: nothing to do.</b> The script adds <code>gi_visitor_id</code> and <code>gi_session_id</code> to the notes of every{' '}
              <code>new Razorpay(options)</code> on your site, and reports the payment id when it succeeds.
            </>
          }
        >
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-stone-600">Creating orders or subscriptions on your server? Add the notes there too (most reliable)</summary>
            <div className="mt-3">
              <Code label="Node.js">{`const jar = await cookies(); // Next.js; or req.cookies

await razorpay.orders.create({
  amount: 49900, // ₹499.00 in paise
  currency: 'INR',
  notes: {
    gi_visitor_id: jar.get('gi_vid')?.value ?? '',
    gi_session_id: jar.get('gi_sid')?.value ?? '',
  },
});`}</Code>
              <p className="hint">API on another domain? Read the ids in the browser with window.gitracker.razorpayNotes() and send them with the request.</p>
            </div>
          </details>
        </Step>
        <Step
          n={4}
          title={
            <>
              <b>Payment Links, Pages and Buttons:</b> set the redirect (callback) URL to a page on {site.domain} that loads the script, e.g.{' '}
              <code>https://{site.domain}/thanks</code>. Razorpay adds <code>?razorpay_payment_id=…</code>, which links the payment to the visitor.
            </>
          }
        />
      </Steps>
      <RazorpayApiKeys site={site} form={form} set={set} save={save} />
      <ProviderFooter note="No notes? Payments are still matched by return page, an earlier payment from the same customer, email, phone, or checkout timing." />
    </>
  );
}

function DodoSetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step n={1} title={<>In Dodo → <b>Developer → Webhooks</b>, add this endpoint with <code>payment.succeeded</code> and <code>refund.succeeded</code>:</>}>
          <CopyField value={`${origin}/api/webhooks/dodo/${site.id}`} />
        </Step>
        <Step n={2} title={<>Paste its signing secret (starts with <code>whsec_</code>):</>}>
          <SecretField
            placeholder="whsec_..."
            value={form.dodo_webhook_secret ?? ''}
            configured={!!site.dodo_webhook_secret}
            onChange={(v) => set({ dodo_webhook_secret: v })}
            onSave={() => save({ dodo_webhook_secret: form.dodo_webhook_secret ?? '' }, 'Dodo connected')}
          />
        </Step>
        <Step
          n={3}
          title={
            <>
              <b>Checkout links (&lt;a href="https://checkout.dodopayments.com/buy/…"&gt;): nothing to do.</b> The script tags them with the visitor. Opening
              checkout from JavaScript instead? Pass the address through <code>gitracker.checkoutUrl()</code>:
            </>
          }
        >
          <Code label="JavaScript">{`window.location.href = window.gitracker?.checkoutUrl
  ? window.gitracker.checkoutUrl(url.toString())
  : url.toString();`}</Code>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-stone-600">Creating checkout sessions on your server?</summary>
            <div className="mt-3">
              <Code label="Node.js">{`await dodo.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_xxx', quantity: 1 }],
  return_url: 'https://${site.domain}/thanks',
  metadata: {
    gi_visitor_id: jar.get('gi_vid')?.value ?? '',
    gi_session_id: jar.get('gi_sid')?.value ?? '',
  },
});`}</Code>
            </div>
          </details>
        </Step>
        <Step
          n={4}
          title={
            <>
              Set the <b>return / redirect URL</b> to a page on {site.domain} that loads the script. Dodo adds <code>?payment_id=…</code>, which links the
              payment to the visitor even without metadata (also when your page removes it from the address bar).
            </>
          }
        />
      </Steps>
      <details className="mt-6 rounded-lg border border-stone-200 bg-surface px-4 py-3 text-sm" open={!!site.dodo_product_ids}>
        <summary className="cursor-pointer font-medium text-stone-700">Selling other products from the same Dodo account?</summary>
        <p className="mt-2 text-stone-500">Dodo sends every payment to every webhook. List this website's product ids and only those are counted here.</p>
        <div className="mt-3 flex gap-2">
          <input
            className="input font-mono"
            placeholder="pdt_abc, pdt_def"
            value={form.dodo_product_ids ?? ''}
            onChange={(e) => set({ dodo_product_ids: e.target.value })}
          />
          <button className="btn-dark" onClick={() => save({ dodo_product_ids: form.dodo_product_ids ?? '' }, 'Products saved')}>
            Save
          </button>
        </div>
      </details>
      <ProviderFooter
        note={`Payments in other currencies (like USD) are converted to ${site.currency} at that day's exchange rate. No metadata? Payments are still matched by return page, email or timing.`}
      />
    </>
  );
}

/** Optional Key ID + Secret: import past payments and re-check the last 48 hours every hour. */
function RazorpayApiKeys({ site, form, set, save }: Pick<RevenueProps, 'site' | 'form' | 'set' | 'save'>) {
  const [days, setDays] = useState(30);
  const [sync, setSync] = useState<{ busy?: boolean; msg?: string; error?: string }>({});
  const connected = !!site.razorpay_key_id && !!site.razorpay_key_secret;
  const synced = site.razorpay_synced_at ? fmtAgo(Date.now() - site.razorpay_synced_at) : '';
  async function run() {
    setSync({ busy: true });
    try {
      const r = await api<{ payments: number; refunds: number; imported: number }>(`/api/sites/${site.id}/razorpay/sync`, { method: 'POST', json: { days } });
      setSync({ msg: `Checked ${r.payments} payments and ${r.refunds} refunds from the last ${days} days. ${r.imported} new.` });
    } catch (e) {
      setSync({ error: (e as Error).message });
    }
  }
  return (
    <details className="mt-6 rounded-lg border border-stone-200 bg-surface px-4 py-3 text-sm" open={connected}>
      <summary className="cursor-pointer font-medium text-stone-700">Optional: API keys, to import past payments and catch missed webhooks</summary>
      <p className="mt-2 text-stone-500">
        From Razorpay → <b>Accounts &amp; Settings → API Keys</b>. GI Tracker only reads payments and refunds, but Razorpay keys have full account access, so
        keep this server secure.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input className="input font-mono" placeholder="rzp_live_..." value={form.razorpay_key_id ?? ''} onChange={(e) => set({ razorpay_key_id: e.target.value })} />
        <input
          className="input font-mono"
          type="password"
          placeholder="Key Secret"
          value={form.razorpay_key_secret ?? ''}
          onChange={(e) => set({ razorpay_key_secret: e.target.value })}
        />
      </div>
      <button className="btn-dark mt-2" onClick={() => save({ razorpay_key_id: form.razorpay_key_id ?? '', razorpay_key_secret: form.razorpay_key_secret ?? '' }, 'API keys saved')}>
        Save keys
      </button>
      {connected && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          Import the last
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <button className="btn" disabled={sync.busy} onClick={run}>
            {sync.busy ? 'Importing…' : 'Import from Razorpay'}
          </button>
          {site.razorpay_synced_at && <span className="text-xs text-stone-400">Last synced {synced ? `${synced} ago` : 'just now'}</span>}
        </div>
      )}
      {sync.msg && <p className="mt-2 text-emerald-700">{sync.msg}</p>}
      {sync.error && <p className="mt-2 text-red-600">{sync.error}</p>}
    </details>
  );
}

function ApiSetup({ site, origin, onKeyRotated }: RevenueProps) {
  return (
    <>
      <p className="mb-3 text-sm text-stone-500">Any other provider: send payments from your backend with this site's API key.</p>
      <div className="mb-4 flex gap-2">
        <input className="input font-mono" readOnly value={site.api_key} />
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
            const r = await api<{ api_key: string }>(`/api/sites/${site.id}/rotate-key`, { method: 'POST' });
            onKeyRotated(r.api_key);
          }}
        >
          Rotate
        </button>
      </div>
      <Code label="POST /api/v1/payments">{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_id": "txn_123",
    "amount": 499.00,
    "currency": "${site.currency}",
    "visitor_id": "<gi_vid cookie>",
    "email": "priya@acme.in"
  }'`}</Code>
    </>
  );
}

function ProviderFooter({ note = 'No metadata? Payments are still matched by return page, email or timing.' }: { note?: string }) {
  return (
    <p className="mt-5 border-t border-stone-100 pt-4 text-sm text-stone-500">
      {note}
    </p>
  );
}

/** One-click prompt for the owner's coding AI, so it can install everything in their codebase. */
function AiSetup({ site, origin }: { site: Site; origin: string }) {
  const [open, setOpen] = useState(false);
  const prompt = buildAiPrompt(site, origin);
  return (
    <section className="rounded-lg border border-stone-200 bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Set it up with an AI coding tool</h3>
          <p className="mt-0.5 text-[13px] text-stone-500">Paste this into Claude Code or Cursor in the website's project. It adds the script, goals and payment tracking.</p>
        </div>
        <CopyButton text={prompt} label="Copy prompt" className="btn shrink-0" />
      </div>
      <button className="mt-2 text-[13px] font-medium text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-ink" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide the prompt' : 'Read the prompt'}
      </button>
      {open && <pre className="code mt-3 max-h-96 whitespace-pre-wrap rounded-lg">{prompt}</pre>}
    </section>
  );
}

const PRESETS = [
  { label: 'Instagram', source: 'instagram', medium: 'social' },
  { label: 'WhatsApp', source: 'whatsapp', medium: 'social' },
  { label: 'YouTube', source: 'youtube', medium: 'video' },
  { label: 'X / Twitter', source: 'x', medium: 'social' },
  { label: 'LinkedIn', source: 'linkedin', medium: 'social' },
  { label: 'Reddit', source: 'reddit', medium: 'social' },
  { label: 'Medium', source: 'medium', medium: 'article' },
  { label: 'Newsletter', source: 'newsletter', medium: 'email' },
  { label: 'Product Hunt', source: 'producthunt', medium: 'referral' },
];

/** Build a tagged link per tweet / article, so each one shows up separately in Campaign. */
function LinkBuilder({ domain }: { domain: string }) {
  const [url, setUrl] = useState(`https://${domain}/`);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [campaign, setCampaign] = useState('');
  let built = '';
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', preset.source);
    u.searchParams.set('utm_medium', preset.medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign.trim().toLowerCase().replace(/\s+/g, '-'));
    built = u.toString();
  } catch {}
  return (
    <Section title="Campaign links" desc="Tag the link you share in each post, so the dashboard shows which post brought visitors and revenue (under Referrer, then Campaign).">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <label className="label">Page</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="label">Where you post it</label>
          <select className="input" value={preset.label} onChange={(e) => setPreset(PRESETS.find((p) => p.label === e.target.value)!)}>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Post name</label>
          <input className="input" placeholder="launch-tweet" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        </div>
      </div>
      {built && (
        <div className="mt-4">
          <CopyField value={built} />
        </div>
      )}
    </Section>
  );
}
