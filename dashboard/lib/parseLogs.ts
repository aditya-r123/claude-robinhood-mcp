export interface TradeEntry {
  ts: string;
  date: string;
  time: string;
  runTag: string;
  action: string;
  catalyst: string;
  veto: string;
  raw: string;
}

export interface RunGroup {
  runTag: string;
  label: string;
  entries: TradeEntry[];
}

export interface DayGroup {
  date: string;
  runs: RunGroup[];
}

const RUN_LABELS: Record<string, string> = {
  '0930': '9:30 AM',
  '1200': '12:00 PM',
  '1330': '1:30 PM',
  '1515': '3:15 PM',
};

export const labelForTag = (tag: string) => RUN_LABELS[tag] || tag;

// [2026-06-26 20:41:56] TRADE_LOG | e2e2 | SELL ACHR | CATALYST: ... | VETO_STATUS: ...
const LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]\s+\w+_LOG\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/;

export function parseLogLine(line: string): TradeEntry | null {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, date, time, runTag, action, rest] = m;
  const catalyst = rest.match(/CATALYST:\s*(.*?)\s*(?:\|\s*VETO_STATUS:|$)/i)?.[1]?.trim() ?? '';
  const veto =
    rest.match(/VETO_STATUS:\s*(.*)$/i)?.[1]?.trim() ??
    rest.match(/STATUS:\s*(.*)$/i)?.[1]?.trim() ??
    rest.match(/NOTE:\s*(.*)$/i)?.[1]?.trim() ??
    '';
  return { ts: `${date} ${time}`, date, time, runTag: runTag.trim(), action: action.trim(), catalyst, veto, raw: line };
}

export function parseLog(text: string): DayGroup[] {
  const byDate = new Map<string, Map<string, TradeEntry[]>>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^`|`$/g, '').trim(); // some lines are backtick-wrapped
    if (!line) continue;
    const e = parseLogLine(line);
    if (!e) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, new Map());
    const runs = byDate.get(e.date)!;
    if (!runs.has(e.runTag)) runs.set(e.runTag, []);
    runs.get(e.runTag)!.push(e);
  }
  const days: DayGroup[] = [];
  for (const [date, runs] of byDate) {
    const runGroups: RunGroup[] = [];
    for (const [runTag, entries] of runs) runGroups.push({ runTag, label: labelForTag(runTag), entries });
    runGroups.sort((a, b) => a.entries[0].time.localeCompare(b.entries[0].time));
    days.push({ date, runs: runGroups });
  }
  days.sort((a, b) => b.date.localeCompare(a.date));
  return days;
}
