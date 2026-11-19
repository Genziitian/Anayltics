export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    // Always ask the server: never answer from the browser's HTTP cache, which could hold hours-old stats
    // (including copies cached before the server stopped allowing it).
    cache: 'no-store',
    ...init,
    credentials: 'same-origin',
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('gi:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  /** Masked ("••••••••") when set; the secrets themselves never reach the browser. */
  razorpay_webhook_secret?: string | null;
  razorpay_key_id?: string | null;
  razorpay_key_secret?: string | null;
  razorpay_synced_at?: number | null;
  dodo_webhook_secret?: string | null;
  /** Comma-separated Dodo product ids this site counts (empty = all). */
  dodo_product_ids?: string | null;
  /** 1 = anyone can view this site's stats read-only, without logging in. */
  public?: number;
  created_at: number;
  visitors24h?: number;
  online?: number;
}

export interface SiteSpark {
  id: string;
  visitors: number;
  revenue: number;
  online: number;
  series: { visitors: number; revenue: number }[];
}

export interface Kpis {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgDuration: number;
  revenue: number;
  /** Razorpay's fees (incl. GST) on those payments; netRevenue = revenue - fees. */
  fees: number;
  netRevenue: number;
  payments: number;
  customers: number;
  conversionRate: number;
  revenuePerVisitor: number;
}

export interface Overview {
  range: { from: number; to: number; granularity: 'hour' | 'day' | 'week' | 'month' };
  currency: string;
  decimals: number;
  current: Kpis;
  previous: Kpis;
  online: number;
  series: { bucket: string; visitors: number; pageviews: number; revenue: number; payments: number }[];
}

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  extra?: string | null;
}

export type Filters = Record<string, string>;

export interface Query {
  period: string;
  from?: string;
  to?: string;
  granularity?: string;
  filters: Filters;
}

export function qs(q: Query, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.granularity) p.set('granularity', q.granularity);
  if (Object.keys(q.filters).length) p.set('filters', JSON.stringify(q.filters));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

export interface Me {
  loggedIn: boolean;
  hosted: boolean;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    avatar: string | null;
    admin: boolean;
    paid: boolean;
    plan_status: string;
    plan_until: number | null;
    plan: string | null;
  } | null;
}
