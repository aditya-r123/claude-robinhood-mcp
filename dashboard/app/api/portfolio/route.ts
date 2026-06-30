import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { callTool, resetSession } from '@/lib/mcpClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── timeframe → API params ─────────────────────────────────────────────────
// 1H  → 15-second bars over last 60 min (finest available)
// 1D  → hourly bars over last 24 h
// 1W  → hourly bars over last 168 h (7 days)
// 1M  → daily bars over last 31 days
// 1Y  → daily bars over last 365 days
// MAX → dynamic: earliest filled order → now, interval auto-selected by account age

function tfParams(tf: string): { interval: string; start_time: string } {
  const now = Date.now();
  switch (tf) {
    // 1H: minute bars over last 6 h — always captures the current/last trading session
    // (15-second is unreliable for stock historicals and returns nothing outside market hours)
    case '1H':  return { interval: 'minute',   start_time: new Date(now - 6 * 3_600_000).toISOString() };
    case '1D':  return { interval: 'hour',     start_time: new Date(now - 86_400_000).toISOString() };
    case '1W':  return { interval: 'hour',     start_time: new Date(now - 7  * 86_400_000).toISOString() };
    case '1M':  return { interval: 'day',      start_time: new Date(now - 31 * 86_400_000).toISOString() };
    case '1Y':  return { interval: 'day',      start_time: new Date(now - 365 * 86_400_000).toISOString() };
    // MAX is computed dynamically in buildData once we know the earliest order date.
    default:    return { interval: 'day',      start_time: new Date(now - 31 * 86_400_000).toISOString() };
  }
}

// How stale the cache is allowed to get before a background refresh fires.
function tfTtl(tf: string): number {
  if (tf === '1H')               return 2_000;
  if (tf === '1D' || tf === '1W') return 5_000;
  return 60_000;
}

// ── MCP response unwrap ────────────────────────────────────────────────────

function unwrap(result: unknown): any {
  const r = result as any;
  // Prefer text content — structuredContent.data can have empty historicals[] while
  // content[0].text carries the real bars under the "bars" key.
  const text = r?.content?.[0]?.text;
  if (typeof text === 'string') {
    try { const p = JSON.parse(text); return p?.data !== undefined ? p.data : p; } catch { /* fall through */ }
  }
  if (r?.structuredContent?.data !== undefined) return r.structuredContent.data;
  return r;
}

// ── in-process cache ───────────────────────────────────────────────────────

const cache   = new Map<string, { data: unknown; at: number }>();
const pending = new Map<string, Promise<unknown>>();

async function buildData(accountId: string, tf: string): Promise<unknown> {
  // Round 1 — portfolio, positions, orders in parallel.
  const [portRaw, posRaw, ordRaw] = await Promise.all([
    callTool('get_portfolio',        { account_number: accountId }),
    callTool('get_equity_positions', { account_number: accountId }),
    callTool('get_equity_orders',    { account_number: accountId }),
  ]);

  const portfolio = unwrap(portRaw);
  const posData   = unwrap(posRaw);
  const positions = { results: posData?.positions ?? posData?.results ?? [] };
  const ordData   = unwrap(ordRaw);
  const orders    = { results: ordData?.orders ?? ordData?.results ?? [] };

  // Find the ISO timestamp of the earliest filled order — used for MAX and for
  // client-side portfolio value filtering (no chart line before first purchase).
  const filledDates = (orders.results as any[])
    .filter((o: any) => o.state === 'filled' && o.created_at)
    .map((o: any) => o.created_at as string)
    .sort();
  const earliestOrderDate: string | null = filledDates[0] ?? null;

  // Determine interval + start_time (MAX is dynamic based on account age).
  let { interval, start_time } = tfParams(tf);
  if (tf === 'MAX') {
    if (earliestOrderDate) {
      // Start at midnight of the first purchase day.
      const first = new Date(earliestOrderDate);
      first.setUTCHours(0, 0, 0, 0);
      start_time = first.toISOString();
      const ageDays = (Date.now() - first.getTime()) / 86_400_000;
      // Pick interval so we get a reasonable number of bars across the full history.
      if      (ageDays < 1)    interval = 'minute';
      else if (ageDays < 3)    interval = 'minute';
      else if (ageDays < 14)   interval = 'hour';
      else if (ageDays < 90)   interval = 'day';
      else if (ageDays < 730)  interval = 'week';
      else                     interval = 'month';
    } else {
      // No orders yet — show nothing meaningful.
      interval   = 'day';
      start_time = new Date().toISOString();
    }
  }

  const symbols = [...new Set(
    (positions.results as Array<{ symbol: string }>).map((p) => p.symbol),
  )].filter(Boolean);

  // Round 2 — quotes + historicals in parallel.
  const [quotesRaw, histRaw] = await Promise.all([
    symbols.length > 0 ? callTool('get_equity_quotes', { symbols }) : Promise.resolve(null),
    symbols.length > 0
      ? callTool('get_equity_historicals', { symbols, start_time, interval })
      : Promise.resolve(null),
  ]);

  const quoteData    = unwrap(quotesRaw);
  const quoteResults = ((quoteData?.results ?? []) as any[]).map((item: any) => ({
    ...item.quote,
    ...(item.close ? { close_price: item.close.price } : {}),
  }));
  const quotes = { results: quoteResults };

  const histData = unwrap(histRaw) as { results: Array<{ symbol: string; bars?: unknown[]; historicals?: unknown[] }> } | null;
  const historicals: Record<string, unknown> = {};
  for (const entry of histData?.results ?? []) {
    historicals[entry.symbol] = { results: [{ symbol: entry.symbol, historicals: entry.bars ?? entry.historicals ?? [] }] };
  }

  return { portfolio, positions, orders, quotes, historicals, earliestOrderDate };
}

function startFetch(accountId: string, tf: string): Promise<unknown> {
  if (!pending.has(tf)) {
    const p = buildData(accountId, tf)
      .then(data => { cache.set(tf, { data, at: Date.now() }); return data; })
      .catch(e  => { resetSession(); throw e; })
      .finally(() => pending.delete(tf));
    pending.set(tf, p);
  }
  return pending.get(tf)!;
}

// ── route handler ──────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const accountId = config.accountId;
  if (!accountId) {
    return NextResponse.json({ error: 'ACCOUNT_ID not set in Makefile.local' }, { status: 500 });
  }

  const tf     = new URL(request.url).searchParams.get('tf') ?? '1W';
  const cached = cache.get(tf);
  const age    = cached ? Date.now() - cached.at : Infinity;
  const ttl    = tfTtl(tf);

  if (age > ttl) {
    const fetchPromise = startFetch(accountId, tf);
    if (!cached) {
      // No cache at all: must await the first fetch.
      try { await fetchPromise; } catch (e: any) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
      }
    }
    // Stale cache: return stale immediately; fetch runs in background.
  }

  const entry = cache.get(tf);
  if (!entry) return NextResponse.json({ error: 'Data unavailable' }, { status: 503 });
  return NextResponse.json({ ...entry.data as object, fetchedAt: new Date(entry.at).toISOString(), tf });
}
