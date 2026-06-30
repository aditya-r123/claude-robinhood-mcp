'use client';

import { useEffect, useRef, useState } from 'react';
import PromptEditor  from '@/components/PromptEditor';
import ActivityLog   from '@/components/ActivityLog';
import Portfolio     from '@/components/Portfolio';
import CronScheduler from '@/components/CronScheduler';

type Tab = 'portfolio' | 'activity' | 'prompt' | 'schedule';

const DEFAULT_ORDER: Tab[] = ['portfolio', 'activity', 'prompt', 'schedule'];
const TAB_LABELS: Record<Tab, string> = {
  portfolio: 'Portfolio',
  activity:  'Activity',
  prompt:    'System Prompt',
  schedule:  'Scheduler',
};

function loadOrder(): Tab[] {
  try {
    const s = localStorage.getItem('quant-tab-order');
    if (s) {
      const p = JSON.parse(s) as string[];
      if (
        p.length === DEFAULT_ORDER.length &&
        DEFAULT_ORDER.every(t => p.includes(t))
      ) return p as Tab[];
    }
  } catch {}
  return DEFAULT_ORDER;
}

function saveOrder(o: Tab[]) {
  try { localStorage.setItem('quant-tab-order', JSON.stringify(o)); } catch {}
}

// Reorder array: remove element at `from`, re-insert before `insertBefore` (0-indexed insertion point).
// insertBefore 0 = before first, insertBefore N = after last.
function reorder(arr: Tab[], from: number, insertBefore: number): Tab[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  const at = insertBefore > from ? insertBefore - 1 : insertBefore;
  next.splice(at, 0, item);
  return next;
}

// ── status bar ─────────────────────────────────────────────────────────────

interface Status {
  running: boolean;
  lastActivitySecondsAgo: number | null;
  error?: string;
}

function ago(secs: number | null): string {
  if (secs == null) return 'unknown';
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function StatusBar() {
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch('/api/status', { cache: 'no-store' });
        if (alive) setS(await r.json());
      } catch {
        if (alive) setS({ running: false, lastActivitySecondsAgo: null, error: 'unreachable' });
      }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const running = s?.running;
  return (
    <div className={`status ${running ? '' : 'inactive'}`}>
      <span className={`dot ${running ? 'live' : 'down'}`} />
      <span>
        {s?.error
          ? `EC2 ${s.error}`
          : running
            ? 'agent running'
            : `last active ${ago(s?.lastActivitySecondsAgo ?? null)}`}
      </span>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function Page() {
  const [tab,      setTab]      = useState<Tab>('portfolio');
  // Always start from DEFAULT_ORDER so SSR and the first client render match,
  // then apply any saved order after mount (avoids a hydration mismatch).
  const [order,    setOrder]    = useState<Tab[]>(DEFAULT_ORDER);
  useEffect(() => { setOrder(loadOrder()); }, []);
  const [dropIdx,  setDropIdx]  = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const dragSrc = useRef<number | null>(null);

  function onDragStart(e: React.DragEvent, i: number) {
    dragSrc.current = i;
    setDragging(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for Firefox
  }

  function onDragOver(e: React.DragEvent, i: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropIdx(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const from = dragSrc.current;
    const to   = dropIdx;
    if (from !== null && to !== null) {
      const next = reorder(order, from, to);
      setOrder(next);
      saveOrder(next);
    }
    cleanup();
  }

  function cleanup() {
    dragSrc.current = null;
    setDragging(null);
    setDropIdx(null);
  }

  // Is the given dropIdx a no-op for the current drag source?
  const isNoop = (di: number) =>
    dragging !== null && (di === dragging || di === dragging + 1);

  return (
    <div className="shell">
      <div className="header">
        <div className="brand">
          <h1>Robinhood Agentic Trading</h1>
          <img src="/logo.png" width={30} height={30} alt="Robinhood" style={{ borderRadius: 7, flexShrink: 0 }} />
          <span className="sub"></span>
        </div>
        <StatusBar />
      </div>

      <div
        className="tabs"
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIdx(null);
        }}
      >
        {order.map((t, i) => {
          const showLeft  = dropIdx === i     && !isNoop(i);
          const showRight = dropIdx === i + 1 && !isNoop(i + 1);
          return (
            <button
              key={t}
              draggable
              className={[
                'tab',
                tab === t       ? 'active'       : '',
                dragging === i  ? 'tab-dragging'  : '',
                showLeft        ? 'tab-drop-left'  : '',
                showRight       ? 'tab-drop-right' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setTab(t)}
              onDragStart={(e) => onDragStart(e, i)}
              onDragOver={(e)  => onDragOver(e, i)}
              onDrop={onDrop}
              onDragEnd={cleanup}
            >
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </div>

      {tab === 'portfolio' && <Portfolio />}
      {tab === 'activity'  && <ActivityLog />}
      {tab === 'prompt'    && <PromptEditor />}
      {tab === 'schedule'  && <CronScheduler />}
    </div>
  );
}
