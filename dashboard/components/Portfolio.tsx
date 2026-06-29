'use client';

import { useEffect, useRef, useState } from 'react';

// ── raw API types ──────────────────────────────────────────────────────────
interface RawPortfolio { [k: string]: unknown }
interface RawPosition  { symbol: string; quantity: string; average_buy_price: string; [k: string]: unknown }
interface RawOrder     { symbol: string; side: string; quantity: string; price?: string; type: string; state: string; time_in_force: string; created_at?: string; [k: string]: unknown }
interface RawQuote     { symbol: string; last_trade_price: string; adjusted_previous_close: string; [k: string]: unknown }
interface RawHistBar   { begins_at: string; close_price: string }
interface RawHistEntry { symbol: string; historicals: RawHistBar[] }
interface RawHistResp  { results: RawHistEntry[] }

interface ApiData {
  portfolio:         RawPortfolio;
  positions:         { results: RawPosition[] };
  orders:            { results: RawOrder[] };
  quotes:            { results: RawQuote[] };
  historicals:       Record<string, RawHistResp>;
  fetchedAt:         string;
  tf:                string;
  earliestOrderDate: string | null;
}

// ── timeframe ──────────────────────────────────────────────────────────────
type TF = '1H' | '1D' | '1W' | '1M' | '1Y' | 'MAX';
const TFS: { tf: TF; label: string }[] = [
  { tf: '1H',  label: 'hourly'   },
  { tf: '1D',  label: 'daily'    },
  { tf: '1W',  label: 'weekly'   },
  { tf: '1M',  label: 'monthly'  },
  { tf: '1Y',  label: 'yearly'   },
  { tf: 'MAX', label: 'MAX'      },
];

// ── session cache ──────────────────────────────────────────────────────────
function scGet(key: string): ApiData | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, at } = JSON.parse(raw);
    if (Date.now() - at > 120_000) return null;
    return data as ApiData;
  } catch { return null; }
}
function scSet(key: string, data: ApiData) {
  try { sessionStorage.setItem(key, JSON.stringify({ data, at: Date.now() })); } catch {}
}

// ── data hook ──────────────────────────────────────────────────────────────
function usePortfolioData(tf: TF) {
  const [data, setData]       = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    const key    = `pf:${tf}`;
    const cached = scGet(key);
    if (cached) { setData(cached); setLoading(false); }
    else         { setLoading(true); }

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const r = await fetch(`/api/portfolio?tf=${tf}`, { cache: 'no-store' });
        const d: ApiData = await r.json();
        if (!alive) return;
        if ((d as any).error) { setError((d as any).error); }
        else { setData(d); setError(''); scSet(key, d); }
      } catch (e: any) {
        if (alive) setError(e.message ?? 'fetch failed');
      } finally {
        if (alive) { setLoading(false); timer = setTimeout(poll, 500); }
      }
    }

    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [tf]);

  return { data, loading, error };
}

// ── helpers ────────────────────────────────────────────────────────────────
const f$ = (n: number, d = 2) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d });
const fPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
function pf(x: unknown): number { return parseFloat(String(x ?? '0')) || 0; }
function bpNum(raw: unknown): number {
  if (typeof raw === 'object' && raw !== null)
    return pf((raw as Record<string, unknown>).buying_power);
  return pf(raw as string | undefined);
}
function barLabel(iso: string, tf: TF): string {
  const d = new Date(iso);
  if (tf === '1H') {
    return d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
      second: '2-digit', hour12: true,
    });
  }
  if (tf === '1D') {
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', hour12: true,
    });
  }
  const isDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  if (isDay) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

// ── chart data types ───────────────────────────────────────────────────────
interface Point { time: string; value: number }


// ── interactive line chart ─────────────────────────────────────────────────
interface ScrubPoint { idx: number; svgX: number; svgY: number; point: Point }

// Unique gradient ID counter (avoids SVG ID collisions across multiple charts)
let _gid = 0;

function LineChart({
  series,
  height = 160,
  showAxes = true,
  tf,
  onScrub,
  onRange,
}: {
  series:     Point[];
  height?:    number;
  showAxes?:  boolean;
  tf?:        TF;
  onScrub?:   (p: Point | null) => void;
  onRange?:   (from: Point | null, to: Point | null) => void;
}) {
  const svgRef     = useRef<SVGSVGElement>(null);
  const gradId     = useRef(`rh-g${++_gid}`).current;
  // Refs for reliable reads in event handlers (avoid stale closure issues)
  const anchorRef  = useRef<ScrubPoint | null>(null);
  const hasDragRef = useRef(false);
  const isDownRef  = useRef(false);

  const [scrub,      setScrub]      = useState<ScrubPoint | null>(null);
  const [hasDragged, setHasDragged] = useState(false);
  const [locked,     setLocked]     = useState<{ a: ScrubPoint; b: ScrubPoint } | null>(null);

  if (series.length < 2) {
    return <div className="pf-no-chart">No data for this timeframe</div>;
  }

  const W = 1000, H = height;
  const PL = showAxes ? 54 : 2, PR = 2, PT = 6, PB = showAxes ? 22 : 2;
  const pw = W - PL - PR, ph = H - PT - PB;

  const times  = series.map((d) => new Date(d.time).getTime());
  const vals   = series.map((d) => d.value);
  const tMin   = times[0], tMax = times[times.length - 1];
  const vMin   = Math.min(...vals), vMax = Math.max(...vals);
  const vRange = vMax - vMin || vMax * 0.002 || 1;

  const px = (t: number) => PL + ((t - tMin) / (tMax - tMin || 1)) * pw;
  const py = (v: number) => PT + (1 - (v - vMin) / vRange) * ph;

  // Range mode: actively dragging OR selection locked
  const inRange = hasDragged || locked !== null;

  // Active range endpoints, always ordered left → right (earlier → later)
  const rawA = locked ? locked.a : (hasDragged && anchorRef.current ? anchorRef.current : null);
  const rawB = locked ? locked.b : (hasDragged ? scrub : null);
  const [rangeFrom, rangeTo] = (rawA && rawB && rawA.svgX > rawB.svgX)
    ? [rawB, rawA] : [rawA, rawB];

  // Color is determined by the hovered/cursor value vs the series open value.
  // When scrubbing, the portion right of cursor stays visible but faded.
  const anchorSeries  = !inRange && scrub ? series.slice(0, scrub.idx + 1) : series;
  const lastVal       = anchorSeries[anchorSeries.length - 1]?.value ?? vals[vals.length - 1];
  const positive      = lastVal >= vals[0];
  const color         = positive ? 'var(--rh-green)' : 'var(--rh-red)';

  // Full-series coordinates (always needed — either as the only render, or as the faded backdrop)
  const fullLinePts = series
    .map((d) => `${px(new Date(d.time).getTime())},${py(d.value)}`).join(' ');
  const fullEndX    = px(new Date(series[series.length - 1].time).getTime());
  const fullFillPts = `${PL},${H - PB} ${fullLinePts} ${fullEndX},${H - PB}`;

  // When hovering (not in range mode) also compute the highlighted left portion
  const isScrubHover  = !inRange && scrub !== null;
  const leftLinePts   = isScrubHover
    ? anchorSeries.map((d) => `${px(new Date(d.time).getTime())},${py(d.value)}`).join(' ')
    : null;
  const leftEndX      = isScrubHover
    ? px(new Date(anchorSeries[anchorSeries.length - 1].time).getTime())
    : null;
  const leftFillPts   = isScrubHover && leftLinePts !== null && leftEndX !== null
    ? `${PL},${H - PB} ${leftLinePts} ${leftEndX},${H - PB}`
    : null;

  // For axis labels, always use full series
  const linePts = fullLinePts;
  const fillPts = fullFillPts;

  const xIdxs  = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (series.length - 1)));
  const yLabels = [vMin, (vMin + vMax) / 2, vMax];

  // ── event helpers ──────────────────────────────────────────────────────
  function mkScrub(e: React.MouseEvent<SVGSVGElement>): ScrubPoint | null {
    if (!svgRef.current) return null;
    const r    = svgRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1,
      (e.clientX - r.left - (PL / W) * r.width) / ((pw / W) * r.width),
    ));
    const idx = Math.max(0, Math.min(Math.round(frac * (series.length - 1)), series.length - 1));
    const p   = series[idx];
    return { idx, svgX: px(new Date(p.time).getTime()), svgY: py(p.value), point: p };
  }

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    const sp = mkScrub(e);
    if (!sp) return;
    isDownRef.current  = true;
    anchorRef.current  = sp;
    hasDragRef.current = false;
    setHasDragged(false);
    setLocked(null);
    onRange?.(null, null);
  }

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const sp = mkScrub(e);
    if (!sp) return;
    setScrub(sp);

    if (isDownRef.current && anchorRef.current) {
      if (Math.abs(sp.svgX - anchorRef.current.svgX) > 8) {
        hasDragRef.current = true;
        setHasDragged(true);
        const [from, to] = sp.svgX >= anchorRef.current.svgX
          ? [anchorRef.current, sp] : [sp, anchorRef.current];
        onRange?.(from.point, to.point);
      }
    } else if (!locked) {
      onScrub?.(sp.point);
    }
  }

  function handleMouseUp(e: React.MouseEvent<SVGSVGElement>) {
    isDownRef.current = false;
    const sp = mkScrub(e);

    if (hasDragRef.current && anchorRef.current && sp) {
      const [a, b] = sp.svgX >= anchorRef.current.svgX
        ? [anchorRef.current, sp] : [sp, anchorRef.current];
      setLocked({ a, b });
      // onRange was already called continuously during drag
    } else if (!hasDragRef.current) {
      // Plain click: toggle off any existing locked selection
      setLocked(null);
      onRange?.(null, null);
      if (sp && !locked) onScrub?.(sp.point);
    }

    anchorRef.current  = null;
    hasDragRef.current = false;
    setHasDragged(false);
  }

  function handleMouseLeave() {
    isDownRef.current  = false;
    anchorRef.current  = null;
    hasDragRef.current = false;
    setHasDragged(false);
    if (!locked) {
      setScrub(null);
      onScrub?.(null);
    }
  }

  const ttX = scrub ? Math.min(scrub.svgX + 8, W - 130) : 0;
  const ttY = scrub ? Math.max(scrub.svgY - 26, PT) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="pf-chart"
      preserveAspectRatio="none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{
        cursor: inRange ? 'col-resize' : (scrub ? 'crosshair' : 'default'),
        userSelect: 'none',
      }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.20" />
          <stop offset="100%" stopColor={color} stopOpacity="0"    />
        </linearGradient>
      </defs>

      {/* When hovering: full series faded, then highlighted left portion on top */}
      {isScrubHover ? (
        <>
          <polygon points={fullFillPts} fill={`url(#${gradId})`} opacity="0.25" />
          <polyline points={fullLinePts} fill="none" stroke={color} strokeWidth="2.5"
                    strokeLinejoin="round" strokeLinecap="round" opacity="0.25" />
          {leftFillPts && <polygon points={leftFillPts} fill={`url(#${gradId})`} />}
          {leftLinePts && (
            <polyline points={leftLinePts} fill="none" stroke={color} strokeWidth="2.5"
                      strokeLinejoin="round" strokeLinecap="round" />
          )}
        </>
      ) : (
        <>
          <polygon points={fillPts} fill={`url(#${gradId})`} />
          <polyline points={linePts} fill="none" stroke={color} strokeWidth="2.5"
                    strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {showAxes && yLabels.map((v, i) => (
        <text key={i} x={PL - 4} y={py(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
          {f$(v, 0)}
        </text>
      ))}
      {showAxes && xIdxs.map((idx, i) => (
        <text key={i} x={px(times[idx])} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--muted)">
          {barLabel(series[idx].time, tf ?? 'MAX')}
        </text>
      ))}

      {/* Single-point hover scrub (only when NOT in range mode) */}
      {!inRange && scrub && (
        <>
          <line x1={scrub.svgX} y1={PT} x2={scrub.svgX} y2={H - PB}
                stroke="var(--muted)" strokeWidth="1" opacity="0.5" />
          <circle cx={scrub.svgX} cy={scrub.svgY} r="5"
                  fill={color} stroke="var(--panel)" strokeWidth="2.5" />
          <rect x={ttX} y={ttY} width="124" height="28" rx="5"
                fill="var(--panel-2)" stroke="var(--border)" strokeWidth="1" />
          <text x={ttX + 62} y={ttY + 11} textAnchor="middle"
                fontSize="10" fill="var(--muted)" fontFamily="ui-monospace,monospace">
            {barLabel(scrub.point.time, tf ?? 'MAX')}
          </text>
          <text x={ttX + 62} y={ttY + 23} textAnchor="middle"
                fontSize="12" fontWeight="700" fill="var(--text)" fontFamily="ui-monospace,monospace">
            {f$(scrub.point.value)}
          </text>
        </>
      )}

      {/* Drag-to-select range overlay */}
      {inRange && rangeFrom && rangeTo && (() => {
        const delta = rangeTo.point.value - rangeFrom.point.value;
        const pct   = rangeFrom.point.value > 0 ? (delta / rangeFrom.point.value) * 100 : 0;
        const rPos  = delta >= 0;
        const rCol  = rPos ? 'var(--rh-green)' : 'var(--rh-red)';
        const rx    = rangeFrom.svgX;
        const rw    = Math.max(rangeTo.svgX - rangeFrom.svgX, 1);

        return (
          <>
            {/* Shaded region */}
            <rect x={rx} y={PT} width={rw} height={H - PT - PB}
                  fill="rgba(255,255,255,0.07)" rx="2" />
            {/* Bracket lines */}
            <line x1={rx}      y1={PT} x2={rx}      y2={H - PB}
                  stroke={rCol} strokeWidth="1.5" opacity="0.7" strokeDasharray="3,3" />
            <line x1={rx + rw} y1={PT} x2={rx + rw} y2={H - PB}
                  stroke={rCol} strokeWidth="1.5" opacity="0.7" strokeDasharray="3,3" />
            {/* Endpoint dots */}
            <circle cx={rx}      cy={rangeFrom.svgY} r="4.5"
                    fill="var(--muted)" stroke="var(--panel)" strokeWidth="2" />
            <circle cx={rx + rw} cy={rangeTo.svgY}   r="4.5"
                    fill={rCol} stroke="var(--panel)" strokeWidth="2" />
            {/* Inline P&L stats — shown directly on chart when there's no external onRange handler */}
            {!onRange && (
              <text x={rx + rw / 2} y={PT + 18} textAnchor="middle"
                    fontSize="13" fontWeight="700" fill={rCol} fontFamily="ui-monospace,monospace"
                    style={{ paintOrder: 'stroke' } as React.CSSProperties}
                    stroke="var(--bg)" strokeWidth="4">
                {rPos ? '+' : ''}{f$(delta)} ({rPos ? '+' : ''}{pct.toFixed(2)}%)
              </text>
            )}
            {!onRange && (
              <text x={rx + rw / 2} y={PT + 18} textAnchor="middle"
                    fontSize="13" fontWeight="700" fill={rCol} fontFamily="ui-monospace,monospace">
                {rPos ? '+' : ''}{f$(delta)} ({rPos ? '+' : ''}{pct.toFixed(2)}%)
              </text>
            )}
          </>
        );
      })()}
    </svg>
  );
}

// ── portfolio value series ─────────────────────────────────────────────────
function pfValueSeries(
  historicals: Record<string, RawHistResp>,
  positions: RawPosition[],
  buyingPower: number,
  earliestOrderDate: string | null,
): Point[] {
  const qtyMap    = new Map(positions.map((p) => [p.symbol, pf(p.quantity)]));
  const priceByTs = new Map<string, Map<string, number>>();
  const cutoff    = earliestOrderDate ? earliestOrderDate.substring(0, 10) : null;

  for (const [sym, resp] of Object.entries(historicals)) {
    for (const bar of resp?.results?.[0]?.historicals ?? []) {
      if (cutoff && bar.begins_at.substring(0, 10) < cutoff) continue;
      if (!priceByTs.has(bar.begins_at)) priceByTs.set(bar.begins_at, new Map());
      priceByTs.get(bar.begins_at)!.set(sym, pf(bar.close_price));
    }
  }
  const sorted    = [...priceByTs.keys()].sort();
  const lastPrice = new Map<string, number>();
  return sorted.map((ts) => {
    priceByTs.get(ts)!.forEach((v, sym) => lastPrice.set(sym, v));
    let equity = buyingPower;
    qtyMap.forEach((qty, sym) => { equity += qty * (lastPrice.get(sym) ?? 0); });
    return { time: ts, value: equity };
  }).filter((p) => p.value > 0.01);
}

function stockSeries(historicals: Record<string, RawHistResp>, symbol: string): Point[] {
  return (historicals[symbol]?.results?.[0]?.historicals ?? [])
    .map((b) => ({ time: b.begins_at, value: pf(b.close_price) }));
}

// ── TimeframePicker ────────────────────────────────────────────────────────
function TimeframePicker({ tf, setTf }: { tf: TF; setTf: (t: TF) => void }) {
  return (
    <div className="rh-tf-row">
      {TFS.map(({ tf: t, label }) => (
        <button key={t} className={`rh-tf-btn${tf === t ? ' active' : ''}`} onClick={() => setTf(t)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Holdings with expandable per-stock charts ──────────────────────────────
function StatCell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rh-holding-stat">
      <div className="rh-holding-stat-label">{label}</div>
      <div className={`rh-holding-stat-val${cls ? ' ' + cls : ''}`}>{value}</div>
    </div>
  );
}

function HoldingsTable({ data, tf }: { data: ApiData; tf: TF }) {
  const [expanded,    setExpanded]    = useState<string | null>(null);
  const [stockRanges, setStockRanges] = useState<Record<string, { from: Point; to: Point } | null>>({});

  const positions = data.positions?.results ?? [];
  const quotes    = new Map((data.quotes?.results ?? []).map((q) => [q.symbol, q]));
  if (positions.length === 0) return <div className="rh-empty">No open positions.</div>;

  function setRange(sym: string, from: Point | null, to: Point | null) {
    setStockRanges((prev) => ({ ...prev, [sym]: from && to ? { from, to } : null }));
  }

  return (
    <div className="rh-holdings">
      {positions.map((pos) => {
        const qty       = pf(pos.quantity);
        const avgCost   = pf(pos.average_buy_price);
        const q         = quotes.get(pos.symbol);
        const price     = q ? pf(q.last_trade_price) : 0;
        const prev      = q ? pf(q.adjusted_previous_close) : 0;
        const value     = qty * price;
        const cost      = qty * avgCost;
        const pnl       = value - cost;
        const pnlPct    = cost > 0 ? (pnl / cost) * 100 : 0;
        const dayDelta  = price - prev;
        const dayPct    = prev > 0 ? (dayDelta / prev) * 100 : 0;
        const dayReturn = qty * dayDelta;
        const isOpen    = expanded === pos.symbol;
        const series    = stockSeries(data.historicals, pos.symbol);
        const qtyStr    = qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(6).replace(/0+$/, '');
        const range     = stockRanges[pos.symbol] ?? null;

        const hasPrice = price > 0 && prev > 0;

        return (
          <div key={pos.symbol} className="rh-holding">
            <div
              className="rh-holding-row"
              onClick={() => setExpanded((s) => s === pos.symbol ? null : pos.symbol)}
            >
              {/* Left: symbol + shares + expand caret */}
              <div className="rh-holding-left">
                <div className="rh-holding-sym-row">
                  <span className="rh-holding-sym">{pos.symbol}</span>
                  <span className="rh-holding-caret">{isOpen ? '▾' : '▸'}</span>
                </div>
                <span className="rh-holding-shares">{qtyStr} sh · avg {f$(avgCost)}</span>
              </div>

              {/* Right: 3×2 grid of metrics */}
              <div className="rh-holding-stats">
                <StatCell
                  label="Last Price"
                  value={hasPrice ? f$(price) : '—'}
                />
                <StatCell
                  label="Today %"
                  value={hasPrice ? fPct(dayPct) : '—'}
                  cls={hasPrice ? (dayPct >= 0 ? 'pos' : 'neg') : undefined}
                />
                <StatCell
                  label="Equity"
                  value={value > 0 ? f$(value) : '—'}
                />
                <StatCell
                  label="Today Return"
                  value={hasPrice ? `${dayReturn >= 0 ? '+' : ''}${f$(dayReturn)}` : '—'}
                  cls={hasPrice ? (dayReturn >= 0 ? 'pos' : 'neg') : undefined}
                />
                <StatCell
                  label="Total Return"
                  value={cost > 0 ? `${pnl >= 0 ? '+' : ''}${f$(pnl)}` : '—'}
                  cls={cost > 0 ? (pnl >= 0 ? 'pos' : 'neg') : undefined}
                />
                <StatCell
                  label="Total %"
                  value={cost > 0 ? fPct(pnlPct) : '—'}
                  cls={cost > 0 ? (pnlPct >= 0 ? 'pos' : 'neg') : undefined}
                />
              </div>
            </div>

            {isOpen && (
              <div className="rh-stock-expand">
                <div className="rh-stock-meta">
                  {range ? (
                    (() => {
                      const d = range.to.value - range.from.value;
                      const p = range.from.value > 0 ? (d / range.from.value) * 100 : 0;
                      return (
                        <>
                          <span className={d >= 0 ? 'pos' : 'neg'}>
                            {d >= 0 ? '+' : ''}{f$(d)} ({d >= 0 ? '+' : ''}{p.toFixed(2)}%)
                          </span>
                          <span className="muted"> selected range · click to clear</span>
                        </>
                      );
                    })()
                  ) : (
                    <span className="muted">drag to select a range</span>
                  )}
                </div>
                <div className="rh-mini-chart">
                  {series.length >= 2 ? (
                    <LineChart
                      series={series}
                      height={80}
                      showAxes={false}
                      tf={tf}
                      onRange={(from, to) => setRange(pos.symbol, from, to)}
                    />
                  ) : (
                    <div className="pf-no-chart">No data for this timeframe</div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Orders ─────────────────────────────────────────────────────────────────
const STATE_LABEL: Record<string, string> = {
  queued: 'Queued', confirmed: 'Confirmed', partially_filled: 'Partial Fill',
  filled: 'Filled', cancelled: 'Cancelled', rejected: 'Rejected',
};

function OrdersSection({ data }: { data: ApiData }) {
  const orders = data.orders?.results ?? [];
  if (orders.length === 0) return <div className="rh-empty">No recent orders.</div>;
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return (
    <div className="rh-orders">
      {orders.map((o, i) => {
        const active = ['queued', 'confirmed', 'partially_filled'].includes(o.state);
        return (
          <div key={i} className={`rh-order ${active ? 'active' : 'done'}`}>
            <span className={`rh-order-side ${o.side}`}>{o.side.toUpperCase()}</span>
            <div className="rh-order-body">
              <span className="rh-order-sym">{o.symbol}</span>
              <span className="muted"> · {pf(o.quantity)} shares</span>
              {o.price && <span className="muted"> @ {f$(pf(o.price))}</span>}
              <span className="muted"> · {o.type}</span>
            </div>
            <div className="rh-order-right">
              <span className={`rh-order-state ${o.state}`}>{STATE_LABEL[o.state] ?? o.state}</span>
              {o.created_at && <span className="muted rh-order-time">{fmt(o.created_at)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────
export default function Portfolio() {
  const [tf, setTf]               = useState<TF>('1W');
  const { data, loading, error }  = usePortfolioData(tf);
  const [scrubPt,  setScrubPt]    = useState<Point | null>(null);
  const [rangePts, setRangePts]   = useState<{ from: Point; to: Point } | null>(null);

  const pfRaw     = (data?.portfolio ?? {}) as Record<string, unknown>;
  const bp        = bpNum(pfRaw.buying_power);
  const equity    = pf(pfRaw.equity_value ?? pfRaw.equity ?? 0);
  const totalNow  = pf(pfRaw.total_value) || (equity + bp);
  const positions = data?.positions?.results ?? [];
  const series    = data
    ? pfValueSeries(data.historicals ?? {}, positions, bp, data.earliestOrderDate ?? null)
    : [];

  // Range overrides scrub; scrub overrides current value
  const hasRange     = rangePts !== null;
  const displayValue = hasRange ? rangePts.to.value : (scrubPt?.value ?? totalNow);
  const baseValue    = hasRange ? rangePts.from.value : (series[0]?.value ?? totalNow);
  const delta        = displayValue - baseValue;
  const deltaPct     = baseValue > 0 ? (delta / baseValue) * 100 : 0;
  const positive     = delta >= 0;
  const periodLabel  = hasRange ? ' selected range' : (scrubPt ? '' : ' Today');

  const fetchedAt  = data?.fetchedAt ? new Date(data.fetchedAt) : null;
  const updatedStr = fetchedAt
    ? fetchedAt.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      })
    : '';

  function handleTfChange(t: TF) {
    setScrubPt(null);
    setRangePts(null);
    setTf(t);
  }

  return (
    <div className="rh-card">
      {/* Brand strip */}
      <div className="rh-brand-strip">
        <div className="rh-brand">
          <img src="/logo.png" width={30} height={30} alt="Robinhood" style={{ borderRadius: 7, flexShrink: 0 }} />
          <span className="rh-brand-name">Robinhood Agentic Trading</span>
        </div>
        {updatedStr && <span className="rh-updated">updated {updatedStr}</span>}
      </div>

      {error && <div className="banner err" style={{ margin: '0 0 12px' }}>{error}</div>}

      {!error && loading && !data && (
        <div className="rh-empty" style={{ paddingTop: 40 }}>Connecting to Robinhood…</div>
      )}

      {data && (
        <>
          {/* Portfolio value header — updates live while scrubbing or range-selecting */}
          <div className="rh-pf-header">
            <div className="rh-pf-value">{f$(displayValue)}</div>
            <div className={`rh-pf-delta ${positive ? 'pos' : 'neg'}`}>
              {positive ? '▲' : '▼'} {f$(Math.abs(delta))} ({fPct(Math.abs(deltaPct))})
              <span className="rh-pf-period">{periodLabel}</span>
            </div>
          </div>

          {/* Portfolio chart with hover scrub + drag-to-select */}
          <div className="rh-chart-wrap">
            <LineChart
              series={series}
              height={160}
              showAxes
              tf={tf}
              onScrub={(p) => { if (!rangePts) setScrubPt(p); }}
              onRange={(from, to) => {
                setRangePts(from && to ? { from, to } : null);
                if (!from) setScrubPt(null);
              }}
            />
          </div>

          <TimeframePicker tf={tf} setTf={handleTfChange} />

          {/* Stats row */}
          <div className="rh-stats-row">
            <div className="rh-stat">
              <div className="rh-stat-label">Invested</div>
              <div className="rh-stat-val">{f$(equity)}</div>
            </div>
            <div className="rh-stat">
              <div className="rh-stat-label">Buying Power</div>
              <div className="rh-stat-val">{f$(bp)}</div>
            </div>
            <div className="rh-stat">
              <div className="rh-stat-label">Account Value</div>
              <div className="rh-stat-val">{f$(totalNow)}</div>
            </div>
          </div>

          <div className="rh-divider" />

          {/* Holdings */}
          <div className="rh-section">
            <div className="rh-section-head">
              Stocks
              <span className="rh-section-hint">tap to expand · drag chart to see range P&amp;L</span>
            </div>
            <HoldingsTable data={data} tf={tf} />
          </div>

          <div className="rh-divider" />

          {/* Orders */}
          <div className="rh-section">
            <div className="rh-section-head">Recent Orders</div>
            <OrdersSection data={data} />
          </div>
        </>
      )}
    </div>
  );
}
