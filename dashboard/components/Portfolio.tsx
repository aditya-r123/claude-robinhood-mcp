'use client';

import { useEffect, useRef, useState } from 'react';

// ── raw API types ──────────────────────────────────────────────────────────
interface RawPortfolio { [k: string]: unknown }
interface RawPosition  { symbol: string; quantity: string; average_buy_price: string; equity?: string; market_value?: string; [k: string]: unknown }
interface RawOrder     { symbol: string; side: string; quantity: string; price?: string; type: string; state: string; time_in_force: string; created_at?: string; [k: string]: unknown }
interface RawQuote     { symbol: string; last_trade_price: string; adjusted_previous_close: string; bid_price?: string; ask_price?: string; [k: string]: unknown }
interface RawHistBar   { begins_at: string; close_price: string; open_price?: string }
interface RawHistEntry { symbol: string; historicals: RawHistBar[] }
interface RawQuoteResp { results: RawQuote[] }
interface RawPosResp   { results: RawPosition[] }
interface RawOrdResp   { results: RawOrder[] }
interface RawHistResp  { results: RawHistEntry[] }

interface ApiData {
  portfolio:   RawPortfolio;
  positions:   RawPosResp;
  orders:      RawOrdResp;
  quotes:      RawQuoteResp;
  historicals: Record<string, RawHistResp>;
  fetchedAt:   string;
  error?:      string;
}

// ── helpers ────────────────────────────────────────────────────────────────
const f$ = (n: number, digits = 2) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits });

const fPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function pf(x: unknown): number { return parseFloat(String(x || '0')) || 0; }

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ── portfolio value chart ──────────────────────────────────────────────────
function pfValueSeries(
  historicals: Record<string, RawHistResp>,
  positions: RawPosition[],
  buyingPower: number,
): { time: string; value: number }[] {
  const qtyMap = new Map(positions.map((p) => [p.symbol, pf(p.quantity)]));

  // Build a map of timestamp → { symbol → close_price }
  const priceByTs = new Map<string, Map<string, number>>();
  for (const [sym, resp] of Object.entries(historicals)) {
    for (const bar of resp?.results?.[0]?.historicals ?? []) {
      if (!priceByTs.has(bar.begins_at)) priceByTs.set(bar.begins_at, new Map());
      priceByTs.get(bar.begins_at)!.set(sym, pf(bar.close_price));
    }
  }

  const sorted = [...priceByTs.keys()].sort();
  // Carry forward last-known price so gaps don't zero out the line
  const lastPrice = new Map<string, number>();

  return sorted.map((ts) => {
    const prices = priceByTs.get(ts)!;
    prices.forEach((v, sym) => lastPrice.set(sym, v));
    let equity = buyingPower;
    qtyMap.forEach((qty, sym) => {
      equity += qty * (lastPrice.get(sym) ?? 0);
    });
    return { time: ts, value: equity };
  }).filter((p) => p.value > buyingPower * 0.01); // drop zero-equity points
}

function LineChart({ series, positive }: { series: { time: string; value: number }[]; positive: boolean }) {
  if (series.length < 2) return <div className="pf-no-chart">No intraday data available</div>;

  const W = 1000, H = 130;
  const PL = 58, PR = 12, PT = 8, PB = 26;
  const pw = W - PL - PR, ph = H - PT - PB;

  const times = series.map((d) => new Date(d.time).getTime());
  const vals  = series.map((d) => d.value);
  const tMin = times[0], tMax = times[times.length - 1];
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  const vRange = vMax - vMin || 1;

  const px = (t: number) => PL + ((t - tMin) / (tMax - tMin)) * pw;
  const py = (v: number) => PT + (1 - (v - vMin) / vRange) * ph;

  const linePts = series.map((d) => `${px(new Date(d.time).getTime())},${py(d.value)}`).join(' ');
  const fillPts = `${px(tMin)},${H - PB} ${linePts} ${px(tMax)},${H - PB}`;
  const color   = positive ? 'var(--green)' : 'var(--red)';
  const gradId  = `pfg-${positive ? 'g' : 'r'}`;

  // ~5 time labels
  const labelIdxs = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (series.length - 1)));
  // 3 Y labels
  const yLabels = [vMin, (vMin + vMax) / 2, vMax];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pf-chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill={`url(#${gradId})`} />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {yLabels.map((v, i) => (
        <text key={i} x={PL - 5} y={py(v) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
          {f$(v, 0)}
        </text>
      ))}
      {labelIdxs.map((idx, i) => (
        <text key={i} x={px(times[idx])} y={H - 5} textAnchor="middle" fontSize="9" fill="var(--muted)">
          {timeLabel(series[idx].time)}
        </text>
      ))}
    </svg>
  );
}

// ── sub-components ─────────────────────────────────────────────────────────
function SummaryBar({ data }: { data: ApiData }) {
  const pfRaw = data.portfolio as Record<string, unknown>;

  const equity      = pf(pfRaw.equity ?? pfRaw.market_value ?? pfRaw.portfolio_equity);
  const buyingPower = pf(pfRaw.buying_power ?? pfRaw.withdrawable_amount);
  const totalValue  = equity + buyingPower;

  const prevEquity  = pf(pfRaw.adjusted_equity_previous_close ?? pfRaw.previous_close_equity ?? pfRaw.equity_previous_close ?? 0);
  const prevTotal   = prevEquity > 0 ? prevEquity + buyingPower : 0;
  const dayChange   = prevTotal > 0 ? totalValue - prevTotal : 0;
  const dayChangePct = prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0;
  const positive    = dayChange >= 0;

  return (
    <div className="pf-summary">
      <div className="pf-total">
        <div className="pf-total-label">Portfolio Value</div>
        <div className="pf-total-value">{f$(totalValue)}</div>
        {prevTotal > 0 && (
          <div className={`pf-day-change ${positive ? 'pos' : 'neg'}`}>
            {positive ? '▲' : '▼'} {f$(Math.abs(dayChange))} ({fPct(dayChangePct)}) today
          </div>
        )}
      </div>
      <div className="pf-stat-row">
        <div className="pf-stat">
          <span className="pf-stat-label">Invested</span>
          <span className="pf-stat-value">{f$(equity)}</span>
        </div>
        <div className="pf-stat">
          <span className="pf-stat-label">Buying Power</span>
          <span className="pf-stat-value">{f$(buyingPower)}</span>
        </div>
      </div>
    </div>
  );
}

function HoldingsTable({ data }: { data: ApiData }) {
  const positions = data.positions?.results ?? [];
  const quotes    = new Map((data.quotes?.results ?? []).map((q) => [q.symbol, q]));

  if (positions.length === 0) return <div className="pf-empty">No open positions.</div>;

  return (
    <table className="pf-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="r">Shares</th>
          <th className="r">Avg Cost</th>
          <th className="r">Current</th>
          <th className="r">Today</th>
          <th className="r">Value</th>
          <th className="r">Total P&L</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((pos) => {
          const qty     = pf(pos.quantity);
          const avgCost = pf(pos.average_buy_price);
          const q       = quotes.get(pos.symbol);
          const price   = q ? pf(q.last_trade_price) : pf(pos.equity) / qty || 0;
          const prevClose = q ? pf(q.adjusted_previous_close) : 0;
          const value   = qty * price;
          const cost    = qty * avgCost;
          const pnl     = value - cost;
          const pnlPct  = cost > 0 ? (pnl / cost) * 100 : 0;
          const dayPct  = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          const pos_    = pnl >= 0;
          return (
            <tr key={pos.symbol}>
              <td className="pf-sym">{pos.symbol}</td>
              <td className="r">{qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(4).replace(/0+$/, '')}</td>
              <td className="r muted">{f$(avgCost)}</td>
              <td className="r">{f$(price)}</td>
              <td className={`r ${dayPct >= 0 ? 'pos' : 'neg'}`}>{fPct(dayPct)}</td>
              <td className="r">{f$(value)}</td>
              <td className={`r ${pos_ ? 'pos' : 'neg'}`}>
                {f$(pnl)} <span className="muted">({fPct(pnlPct)})</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ORDER_STATE_LABEL: Record<string, string> = {
  queued: 'Queued', confirmed: 'Confirmed', partially_filled: 'Partial',
  filled: 'Filled', cancelled: 'Cancelled',
};

function OrdersSection({ data }: { data: ApiData }) {
  const orders = data.orders?.results ?? [];
  if (orders.length === 0) return <div className="pf-empty">No recent orders.</div>;

  return (
    <div className="pf-orders">
      {orders.map((o, i) => {
        const active = ['queued', 'confirmed', 'partially_filled'].includes(o.state);
        const price  = o.price ? f$(pf(o.price)) : 'market';
        const label  = ORDER_STATE_LABEL[o.state] ?? o.state;
        return (
          <div key={i} className={`pf-order ${active ? 'active' : 'done'}`}>
            <span className={`pf-order-side ${o.side}`}>{o.side.toUpperCase()}</span>
            <span className="pf-order-sym">{o.symbol}</span>
            <span className="muted">×{pf(o.quantity)}</span>
            <span className="muted">@ {price}</span>
            <span className="muted">{o.type} · {o.time_in_force.toUpperCase()}</span>
            <span className={`pf-order-state ${o.state}`}>{label}</span>
            {o.created_at && (
              <span className="muted">{timeLabel(o.created_at as string)} ET</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────
export default function Portfolio() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function load(showSpinner = false) {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/portfolio', { cache: 'no-store', signal: ac.signal });
      const d: ApiData = await r.json();
      if (ac.signal.aborted) return;
      if (d.error) { setError(d.error); return; }
      setData(d);
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setError(e.message ?? 'Load failed');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    function schedule() {
      if (stopped) return;
      timerRef.current = setTimeout(async () => {
        if (stopped) return;
        await load();
        schedule();
      }, 5000);
    }
    (async () => { await load(true); schedule(); })();
    return () => {
      stopped = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const pfRaw    = (data?.portfolio ?? {}) as Record<string, unknown>;
  const equity   = pf(pfRaw.equity ?? pfRaw.market_value ?? pfRaw.portfolio_equity ?? 0);
  const bp       = pf(pfRaw.buying_power ?? 0);
  const positions = data?.positions?.results ?? [];

  const series = data
    ? pfValueSeries(data.historicals ?? {}, positions, bp)
    : [];

  const prevEquity = pf(pfRaw.adjusted_equity_previous_close ?? pfRaw.previous_close_equity ?? 0);
  const positive   = equity >= prevEquity;

  const fetchedAt = data?.fetchedAt ? new Date(data.fetchedAt) : null;
  const updatedStr = fetchedAt
    ? fetchedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
    : '';

  return (
    <div className="card">
      <div className="row">
        <span className="meta">Portfolio · Robinhood account</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {updatedStr && <span className="meta">as of {updatedStr}</span>}
          <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}

      {!error && loading && !data && (
        <div className="pf-empty">Fetching portfolio via Robinhood MCP…</div>
      )}

      {data && (
        <>
          <SummaryBar data={data} />
          <div className="pf-chart-wrap">
            <LineChart series={series} positive={positive} />
          </div>

          <div className="pf-section">
            <div className="pf-section-head">Holdings</div>
            <HoldingsTable data={data} />
          </div>

          <div className="pf-section">
            <div className="pf-section-head">Orders</div>
            <OrdersSection data={data} />
          </div>
        </>
      )}
    </div>
  );
}
