import { config } from '../env';
import type { Db } from '../db';
import { currencyDecimals } from '../../shared/currency';

export class FxError extends Error {}

/**
 * The rate from `base` to `quote` on the day of `at` (European Central Bank reference rates via Frankfurter,
 * which answers with the latest business day on or before it). Cached in fx_rates, so each day is fetched once.
 */
export async function fxRate(db: Db, base: string, quote: string, at: number): Promise<number> {
  base = base.toUpperCase();
  quote = quote.toUpperCase();
  if (base === quote) return 1;
  const day = new Date(Math.min(at, Date.now())).toISOString().slice(0, 10);
  const cached = await db
    .prepare('SELECT rate FROM fx_rates WHERE day = ? AND base = ? AND quote = ?')
    .bind(day, base, quote)
    .first<{ rate: number }>();
  if (cached) return cached.rate;

  let rate: number | null = null;
  try {
    const res = await fetch(`${config.fxApiBase}/${day}?from=${base}&to=${quote}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) rate = Number(((await res.json()) as { rates?: Record<string, number> }).rates?.[quote]) || null;
  } catch {}
  if (rate) {
    await db.prepare('INSERT INTO fx_rates (day, base, quote, rate) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(day, base, quote, rate).run();
    return rate;
  }
  // The rate service is down: the closest day we already know is far better than a wrong currency.
  const near = await db
    .prepare('SELECT rate FROM fx_rates WHERE base = ? AND quote = ? ORDER BY ABS(EXTRACT(EPOCH FROM (day::date - ?::date))) LIMIT 1')
    .bind(base, quote, day)
    .first<{ rate: number }>();
  if (near) return near.rate;
  throw new FxError(`No exchange rate for ${base} → ${quote}`);
}

/** Convert an amount in minor units (cents, paise) between currencies, respecting each one's decimals. */
export async function convertMinor(db: Db, amount: number, from: string, to: string, at: number): Promise<number> {
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  const rate = await fxRate(db, from, to, at);
  const major = amount / 10 ** currencyDecimals(from);
  return Math.round(major * rate * 10 ** currencyDecimals(to));
}
