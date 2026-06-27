import { parseLogLine, labelForTag, type TradeEntry } from './parseLogs';

export interface ReasoningSection {
  title: string;
  body: string;
}

export interface RunBlock {
  id: string;
  mode: string;
  label: string;
  date: string;
  time: string;
  startTs: string;
  finishTs: string | null;
  durationSec: number | null;
  exitCode: number | null;
  status: 'running' | 'ok' | 'error';
  sections: ReasoningSection[];
  decision: string | null;
  summary: string | null;
  actions: TradeEntry[];
  sources: string[];
  rawReasoning: string;
}

export interface ReasoningDay {
  date: string;
  runs: RunBlock[];
}

const START_RE =
  /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})[^\]]*\]\s*=+\s*Starting\s+(.+?)\s+run\b[^=]*=+/g;
const FINISH_RE =
  /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})[^\]]*\]\s*=+\s*Finished\s+(.+?)\s+run\s*\(claude exit code:\s*(-?\d+)\)\s*=+/g;

interface Marker {
  kind: 'start' | 'finish';
  index: number;
  end: number;
  date: string;
  time: string;
  mode: string;
  exit?: number;
}

const cleanMd = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function prettyLabel(mode: string): string {
  // Any mode ending in "e2e" (optionally followed by digits) collapses to "E2E".
  if (/e2e\d*$/i.test(mode)) return 'E2E';
  const mapped = labelForTag(mode);
  if (mapped !== mode) return mapped; // numeric run tag → "9:30 AM" etc.
  return mode.charAt(0).toUpperCase() + mode.slice(1); // afternoon → Afternoon
}

function parseBody(body: string): {
  sections: ReasoningSection[];
  decision: string | null;
  summary: string | null;
  actions: TradeEntry[];
  sources: string[];
  rawReasoning: string;
} {
  // Pull the agent's deliberation if it wrapped one; otherwise use the whole body.
  const delib = body.match(/<deliberation>([\s\S]*?)<\/deliberation>/i);
  let text = (delib ? delib[1] : body)
    .replace(/^```.*$/gm, '') // drop code fences
    // Runner infra lines carry a timezone (EDT/UTC…); TRADE_LOG timestamps don't.
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}\][ \t]*/gm, '')
    // "MCP OK. Executing … agent …" banner — bounded at its "…" so real output survives.
    .replace(/MCP (?:auth )?OK[^\n]*?Executing[^\n]*?\.\.\.[ \t]*/gi, '');

  // Extract structured action lines (TRADE_LOG) and remove them from the prose.
  const actions: TradeEntry[] = [];
  text = text
    .split('\n')
    .filter((line) => {
      const e = parseLogLine(line.replace(/^`|`$/g, '').trim());
      if (e) {
        actions.push(e);
        return false;
      }
      return true;
    })
    .join('\n');

  // Sources: any URLs we can surface as links.
  const sources = Array.from(
    new Set((text.match(/https?:\/\/[^\s)]+/g) || []).map((u) => u.replace(/[.,]+$/, ''))),
  ).slice(0, 12);

  const decisionMatch = text.match(/(?:^|\n)\s*\*{0,2}Decision\*{0,2}\s*[:\-]\s*(.+)/i);
  const decision = decisionMatch ? cleanMd(decisionMatch[1]) : null;

  const summaryMatch = text.match(/\*\*Run summary:\*\*\s*([\s\S]+?)(?:\n\s*\[|\n{2,}|$)/i);
  const summary = summaryMatch ? cleanMd(summaryMatch[1]) : null;

  // Parse [Title] sections out of the deliberation. Leftover prose (not in any
  // section and not surfaced as decision/summary/sources) becomes rawReasoning.
  const sections: ReasoningSection[] = [];
  const intro: string[] = [];
  let cur: ReasoningSection | null = null;
  let inSummary = false;
  const push = () => {
    if (cur && cur.body.trim()) sections.push({ title: cur.title, body: cur.body.trim() });
    else if (cur && cur.title) sections.push({ title: cur.title, body: '' });
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    // Skip noise we surface elsewhere.
    if (/^\s*Sources actually fetched/i.test(line)) {
      push();
      cur = null;
      inSummary = false;
      continue;
    }
    if (/^\s*-?\s*https?:\/\//.test(line)) continue;
    if (/\*\*Run summary:\*\*/i.test(line)) {
      push();
      cur = null;
      inSummary = true;
      continue;
    }

    const h = line.match(/^\[([A-Za-z][^\]]*)\]\s*(.*)$/);
    if (h) {
      push();
      inSummary = false;
      const rawTitle = h[1];
      const title = rawTitle.split(/—|–|\s-\s|,/)[0].trim();
      const extra = rawTitle.slice(title.length).replace(/^[\s—–,\-]+/, '').trim();
      cur = { title, body: [extra, h[2]].filter(Boolean).join(' ') };
    } else if (cur) {
      cur.body += '\n' + line;
    } else if (!inSummary && line.trim()) {
      intro.push(line);
    }
  }
  push();

  return { sections, decision, summary, actions, sources, rawReasoning: intro.join('\n').trim() };
}

export function parseRuns(text: string): RunBlock[] {
  const markers: Marker[] = [];
  let m: RegExpExecArray | null;

  START_RE.lastIndex = 0;
  while ((m = START_RE.exec(text))) {
    markers.push({ kind: 'start', index: m.index, end: m.index + m[0].length, date: m[1], time: m[2], mode: m[3].trim() });
  }
  FINISH_RE.lastIndex = 0;
  while ((m = FINISH_RE.exec(text))) {
    markers.push({
      kind: 'finish',
      index: m.index,
      end: m.index + m[0].length,
      date: m[1],
      time: m[2],
      mode: m[3].trim(),
      exit: Number(m[4]),
    });
  }
  markers.sort((a, b) => a.index - b.index);

  const runs: RunBlock[] = [];
  let open: Marker | null = null;
  const makeRun = (start: Marker, finish: Marker | null, end: number) => {
    const body = text.slice(start.end, finish ? finish.index : end);
    const parsed = parseBody(body);
    const startTs = `${start.date} ${start.time}`;
    const finishTs = finish ? `${finish.date} ${finish.time}` : null;
    const durationSec = finish
      ? Math.max(0, Math.round((Date.parse(`${finish.date}T${finish.time}`) - Date.parse(`${start.date}T${start.time}`)) / 1000))
      : null;
    const status: RunBlock['status'] = !finish ? 'running' : finish.exit === 0 ? 'ok' : 'error';
    runs.push({
      id: startTs,
      mode: start.mode,
      label: prettyLabel(start.mode),
      date: start.date,
      time: start.time,
      startTs,
      finishTs,
      durationSec,
      exitCode: finish?.exit ?? null,
      status,
      ...parsed,
    });
  };

  for (const mk of markers) {
    if (mk.kind === 'start') {
      if (open) makeRun(open, null, mk.index); // previous run never closed
      open = mk;
    } else if (mk.kind === 'finish' && open) {
      makeRun(open, mk, mk.end);
      open = null;
    }
  }
  if (open) makeRun(open, null, text.length); // a run currently in progress

  // newest first
  runs.sort((a, b) => b.startTs.localeCompare(a.startTs));
  return runs;
}

export function groupRunsByDay(runs: RunBlock[]): ReasoningDay[] {
  const byDate = new Map<string, RunBlock[]>();
  for (const r of runs) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }
  const days: ReasoningDay[] = [];
  for (const [date, dayRuns] of byDate) days.push({ date, runs: dayRuns });
  days.sort((a, b) => b.date.localeCompare(a.date));
  return days;
}
