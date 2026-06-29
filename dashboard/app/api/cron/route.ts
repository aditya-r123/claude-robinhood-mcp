import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '@/lib/config';
import { sshExec, scpUpload } from '@/lib/ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── types ──────────────────────────────────────────────────────────────────

export interface CronEntry {
  hour:     number; // 0–23, in ET
  min:      number; // 0–59
  weekdays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
}

// ── cron parsing ───────────────────────────────────────────────────────────

function parseWeekdays(spec: string): number[] {
  if (spec === '*') return [0, 1, 2, 3, 4, 5, 6];
  const result: number[] = [];
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) result.push(i);
    } else {
      result.push(parseInt(part, 10));
    }
  }
  return [...new Set(result)].sort();
}

function weekdaysToSpec(weekdays: number[]): string {
  const s = [...weekdays].sort();
  if (s.length === 7) return '*';
  // Try to build range strings
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return parts.join(',');
}

function parseCronEntries(content: string): CronEntry[] {
  const entries: CronEntry[] = [];
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#') || /^[A-Z_]+=/.test(l)) continue;
    const parts = l.split(/\s+/);
    if (parts.length < 6) continue;
    const min  = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);
    if (isNaN(min) || isNaN(hour)) continue;
    entries.push({ min, hour, weekdays: parseWeekdays(parts[4]) });
  }
  return entries;
}

// Extract everything except schedule lines (preserve comments, env vars, blanks)
function extractHeader(content: string): string {
  const lines = content.split('\n').filter(l => {
    const t = l.trim();
    if (!t || t.startsWith('#') || /^[A-Z_]+=/.test(t)) return true;
    const parts = t.split(/\s+/);
    return !(parts.length >= 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]));
  });
  return lines.join('\n').trimEnd() + '\n';
}

function buildCrontab(header: string, entries: CronEntry[]): string {
  const script = `${config.remoteDir}/scripts/run_trading.sh`;
  const sorted = [...entries].sort((a, b) => a.hour * 60 + a.min - (b.hour * 60 + b.min));
  const lines  = sorted.map(e => {
    const label = `${String(e.hour).padStart(2, '0')}${String(e.min).padStart(2, '0')}`;
    return `${e.min} ${e.hour} * * ${weekdaysToSpec(e.weekdays)} ${script} ${label}`;
  });
  return header.trimEnd() + '\n\n' + lines.join('\n') + '\n';
}

// ── next-run computation ───────────────────────────────────────────────────

function etToUTC(year: number, month0: number, day: number, hour: number, min: number): Date {
  for (const offsetH of [4, 5]) {
    const c = new Date(Date.UTC(year, month0, day, hour + offsetH, min));
    const etH = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(c),
    ) % 24;
    if (etH === hour) return c;
  }
  return new Date(Date.UTC(year, month0, day, hour + 5, min));
}

function computeNextRun(entries: CronEntry[]): Date | null {
  if (entries.length === 0) return null;
  const now = new Date();
  const wmap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  for (let d = 0; d <= 7; d++) {
    const check = new Date(now.getTime() + d * 86_400_000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
      }).formatToParts(check).map(p => [p.type, p.value]),
    );
    const wd = wmap[parts.weekday] ?? -1;
    const candidates: Date[] = [];
    for (const e of entries) {
      if (!e.weekdays.includes(wd)) continue;
      const c = etToUTC(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day), e.hour, e.min);
      if (c > now) candidates.push(c);
    }
    if (candidates.length) return candidates.reduce((a, b) => (a < b ? a : b));
  }
  return null;
}

// ── in-process cache ───────────────────────────────────────────────────────

interface Cache { entries: CronEntry[]; nextRun: string | null; rawHeader: string; at: number }
let cache: Cache | null = null;

async function fetchFresh(): Promise<Cache> {
  const raw    = await sshExec('crontab -l 2>/dev/null || true');
  const entries = parseCronEntries(raw);
  return {
    entries,
    nextRun:   computeNextRun(entries)?.toISOString() ?? null,
    rawHeader: extractHeader(raw),
    at:        Date.now(),
  };
}

// ── route handlers ─────────────────────────────────────────────────────────

const templatePath = path.resolve(process.cwd(), '..', 'templates', 'crontab.template');

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > 60_000) cache = await fetchFresh();
    return NextResponse.json({ entries: cache.entries, nextRun: cache.nextRun });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: { entries?: CronEntry[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const entries = body.entries;
  if (!Array.isArray(entries)) {
    return NextResponse.json({ error: 'entries must be an array' }, { status: 400 });
  }

  // Get the current raw header (preserves OAuth token, comments, etc.)
  if (!cache) cache = await fetchFresh();
  const fullCrontab = buildCrontab(cache.rawHeader, entries);

  // Install on EC2 via temp file (avoids all shell-escaping headaches)
  const tmp = path.join(os.tmpdir(), `.crontab_${Date.now()}.txt`);
  await fs.writeFile(tmp, fullCrontab, 'utf8');
  try {
    await scpUpload(tmp, '/tmp/.crontab_update');
    await sshExec('crontab /tmp/.crontab_update && rm -f /tmp/.crontab_update');
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }

  // Save sanitized local template (token redacted)
  const sanitized = fullCrontab.replace(
    /^(CLAUDE_CODE_OAUTH_TOKEN\s*=\s*).+$/m,
    '$1REPLACE_WITH_YOUR_OAUTH_TOKEN',
  );
  await fs.writeFile(templatePath, sanitized, 'utf8');

  // Update cache
  const nextRun = computeNextRun(entries)?.toISOString() ?? null;
  cache = { entries, nextRun, rawHeader: cache.rawHeader, at: Date.now() };

  return NextResponse.json({ ok: true, nextRun });
}
