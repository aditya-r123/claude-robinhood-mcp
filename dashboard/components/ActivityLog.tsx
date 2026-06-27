'use client';

import { useEffect, useRef, useState } from 'react';
import type { ActivityDay, ActivityRun } from '@/lib/mergeActivity';
import type { TradeEntry } from '@/lib/parseLogs';
import { formatTs, formatDuration } from '@/lib/formatTime';

function actionClass(action: string): string {
  const a = action.toUpperCase();
  if (a.startsWith('BUY') || a.includes('ADD')) return 'buy';
  if (a.startsWith('SELL') || a.includes('TRIM')) return 'sell';
  return 'hold';
}

function vetoPill(veto: string) {
  if (!veto) return null;
  const pass = /pass/i.test(veto);
  const fail = /fail|veto|reject/i.test(veto);
  if (!pass && !fail) return <span className="pill">{veto}</span>;
  return <span className={`pill ${pass ? 'pass' : 'fail'}`}>{veto}</span>;
}

function ActionRow({ e }: { e: TradeEntry }) {
  return (
    <div className="entry">
      <span className="t">{formatTs(e.date, e.time)}</span>
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`action ${actionClass(e.action)}`}>{e.action}</span>
          {vetoPill(e.veto)}
        </div>
        {e.catalyst && <div className="cat">{e.catalyst}</div>}
      </div>
    </div>
  );
}

function StatusBadge({ run }: { run: ActivityRun }) {
  if (run.status === 'running') return <span className="rbadge live">● running</span>;
  if (run.status === 'ok') return <span className="rbadge ok">exit 0</span>;
  return <span className="rbadge err">exit {run.exitCode}</span>;
}

function RunCard({ run, defaultOpen }: { run: ActivityRun; defaultOpen: boolean }) {
  const hasReasoning = run.sections.length > 0 || run.rawReasoning.length > 0;
  return (
    <div className={`runcard ${run.status === 'running' ? 'islive' : ''}`}>
      <div className="runcard-head">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="run-head" style={{ margin: 0 }}>{run.label}</span>
          <StatusBadge run={run} />
          <span className="t">
            {formatTs(run.date, run.time)}
            {run.durationSec != null ? ` · ${formatDuration(run.durationSec)}` : ''}
          </span>
        </div>
      </div>

      {run.trades.length > 0 && (
        <div className="runsection">
          <div className="section-label">Trades</div>
          {run.trades.map((e, i) => <ActionRow e={e} key={i} />)}
        </div>
      )}

      {run.decision && (
        <div className="decision">
          <span className="decision-label">Decision</span>
          {run.decision}
        </div>
      )}

      {hasReasoning && (
        <details className="reasoning" open={defaultOpen}>
          <summary>Reasoning{run.sections.length ? ` · ${run.sections.length} stages` : ''}</summary>
          {run.sections.length > 0 ? (
            run.sections.map((s, i) => (
              <div className="stage" key={i}>
                <div className="stage-title">{s.title}</div>
                {s.body && <div className="stage-body">{s.body}</div>}
              </div>
            ))
          ) : (
            <div className="stage-body raw">{run.rawReasoning}</div>
          )}
        </details>
      )}

      {run.summary && (
        <div className="runsummary">
          <span className="decision-label">Summary</span>
          {run.summary}
        </div>
      )}

      {run.sources.length > 0 && (
        <details className="sources">
          <summary>{run.sources.length} source{run.sources.length === 1 ? '' : 's'}</summary>
          <ul>
            {run.sources.map((u, i) => (
              <li key={i}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Upsert a run into the days state keyed by run.id — prevents duplicates across polls.
function addRun(prev: ActivityDay[], date: string, run: ActivityRun): ActivityDay[] {
  const map = new Map(prev.map((d) => [d.date, { ...d, runs: [...d.runs] }]));
  if (!map.has(date)) map.set(date, { date, runs: [], orphanTrades: [] });
  const runs = map.get(date)!.runs;
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run; else runs.push(run);
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function addOrphans(prev: ActivityDay[], date: string, trades: TradeEntry[]): ActivityDay[] {
  // Replace (not append) so repeated polls don't accumulate orphan entries.
  const found = prev.some((d) => d.date === date);
  if (found) return prev.map((d) => d.date === date ? { ...d, orphanTrades: trades } : d);
  return [...prev, { date, runs: [], orphanTrades: trades }].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
}

export default function ActivityLog() {
  const [days, setDays] = useState<ActivityDay[]>([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);
  liveRef.current = live;

  async function load(showSpinner = false) {
    // Cancel any in-flight stream before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    if (showSpinner) {
      setLoading(true);
      setDays([]);
    }
    setError('');

    try {
      const resp = await fetch('/api/activity', {
        cache: 'no-store',
        signal: ac.signal,
      });

      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ac.signal.aborted) return;

        buf += dec.decode(value, { stream: true });

        // SSE blocks are separated by \n\n
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';

        for (const block of blocks) {
          if (ac.signal.aborted) return;
          let evt = 'message';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) evt = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (!dataStr) continue;

          const data = JSON.parse(dataStr);
          if (evt === 'meta') {
            setLive(data.live);
            liveRef.current = data.live;
            if (showSpinner) setLoading(false);
          } else if (evt === 'run') {
            setDays((prev) => addRun(prev, data.date, data.run));
            if (showSpinner) setLoading(false); // first card = spinner done
          } else if (evt === 'orphans') {
            setDays((prev) => addOrphans(prev, data.date, data.trades));
          } else if (evt === 'error') {
            setError(data.error ?? 'Load failed');
          }
          // 'done' event: nothing to do; reader closes naturally
        }
      }
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
      }, liveRef.current ? 4000 : 30000);
    }

    (async () => {
      await load(true);
      schedule();
    })();

    return () => {
      stopped = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalRuns = days.reduce((n, d) => n + d.runs.length, 0);

  return (
    <div className="card">
      <div className="row">
        <span className="meta">
          {loading && days.length === 0
            ? 'Loading…'
            : live
              ? '● agent running'
              : `${totalRuns} run${totalRuns === 1 ? '' : 's'}`}
          {days.length > 0 && ' · trades + reasoning'}
        </span>
        <button className="btn ghost" onClick={() => load(true)} disabled={loading && days.length === 0}>
          {loading && days.length === 0 ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}
      {!error && !loading && days.length === 0 && (
        <div className="empty">No activity recorded yet.</div>
      )}

      {days.map((day) => (
        <div className="day" key={day.date}>
          <div className="day-head">{day.date}</div>
          {day.runs.map((run, i) => (
            <RunCard run={run} key={run.id} defaultOpen={run.status === 'running' || i === 0} />
          ))}
          {day.orphanTrades.length > 0 && (
            <div className="runcard">
              <div className="runcard-head">
                <span className="run-head" style={{ margin: 0 }}>Other logged trades</span>
              </div>
              <div className="runsection">
                {day.orphanTrades.map((e, i) => <ActionRow e={e} key={i} />)}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
