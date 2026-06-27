import { parseRuns, type RunBlock } from './parseRuns';
import { parseLogLine, type TradeEntry } from './parseLogs';

export interface ActivityRun extends RunBlock {
  trades: TradeEntry[];
}

export interface ActivityDay {
  date: string;
  runs: ActivityRun[];
  orphanTrades: TradeEntry[];
}

const norm = (a: string) => a.toUpperCase().replace(/\s+/g, ' ').trim();

// Combine the agent's reasoning (trade_execution.log) with the canonical trade
// lines (log.txt). Each canonical trade is assigned to the run whose time window
// contains it; the canonical list is unioned with the exec-parsed actions so no
// action is lost, and anything that matches no run is kept in an orphan bucket.
export function mergeActivity(execLog: string, tradeLog: string): { days: ActivityDay[]; live: boolean } {
  const runs = parseRuns(execLog); // newest first

  const entries: TradeEntry[] = [];
  for (const raw of tradeLog.split('\n')) {
    const e = parseLogLine(raw.replace(/^`|`$/g, '').trim());
    if (e) entries.push(e);
  }

  // Build [start, nextStart) windows from runs sorted oldest→newest.
  const asc = [...runs].sort((a, b) => a.startTs.localeCompare(b.startTs));
  const windows = asc.map((run, i) => ({
    run,
    start: run.startTs,
    end: asc[i + 1]?.startTs ?? '9999-99-99 99:99:99',
  }));

  const canonicalByRun = new Map<string, TradeEntry[]>();
  const orphans: TradeEntry[] = [];
  for (const e of entries) {
    const w = windows.find((w) => e.ts >= w.start && e.ts < w.end);
    if (w) {
      if (!canonicalByRun.has(w.run.id)) canonicalByRun.set(w.run.id, []);
      canonicalByRun.get(w.run.id)!.push(e);
    } else {
      orphans.push(e);
    }
  }

  const activityRuns: ActivityRun[] = runs.map((r) => {
    const canonical = canonicalByRun.get(r.id) ?? [];
    const seen = new Set(canonical.map((t) => norm(t.action)));
    const extra = r.actions.filter((a) => !seen.has(norm(a.action))); // exec-only actions
    const trades = [...canonical, ...extra].sort((a, b) => a.time.localeCompare(b.time));
    return { ...r, trades };
  });

  const byDate = new Map<string, ActivityRun[]>();
  for (const r of activityRuns) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }
  const orphanByDate = new Map<string, TradeEntry[]>();
  for (const e of orphans) {
    if (!orphanByDate.has(e.date)) orphanByDate.set(e.date, []);
    orphanByDate.get(e.date)!.push(e);
  }

  const dates = new Set<string>([...byDate.keys(), ...orphanByDate.keys()]);
  const days: ActivityDay[] = [...dates].map((date) => ({
    date,
    runs: byDate.get(date) ?? [],
    orphanTrades: (orphanByDate.get(date) ?? []).sort((a, b) => a.time.localeCompare(b.time)),
  }));
  days.sort((a, b) => b.date.localeCompare(a.date));

  return { days, live: runs.some((r) => r.status === 'running') };
}
