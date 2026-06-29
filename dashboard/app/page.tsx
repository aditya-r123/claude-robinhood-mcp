'use client';

import { useEffect, useState } from 'react';
import PromptEditor    from '@/components/PromptEditor';
import ActivityLog     from '@/components/ActivityLog';
import Portfolio       from '@/components/Portfolio';
import CronScheduler   from '@/components/CronScheduler';

type Tab = 'portfolio' | 'activity' | 'prompt' | 'schedule';

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

function nextRunIn(isoStr: string): string {
  const diffMs  = new Date(isoStr).getTime() - Date.now();
  const diffMin = Math.max(0, Math.round(diffMs / 60_000));
  if (diffMin === 0) return 'now';
  const time = new Date(isoStr).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  if (diffMin < 60) return `${time} ET · in ${diffMin}m`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  return `${time} ET · in ${h}h${m ? ` ${m}m` : ''}`;
}

function StatusBar() {
  const [s,       setS]       = useState<Status | null>(null);
  const [nextRun, setNextRun] = useState<string | null>(null);

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

  useEffect(() => {
    let alive = true;
    async function pollCron() {
      try {
        const r = await fetch('/api/cron', { cache: 'no-store' });
        const d = await r.json();
        if (alive && d.nextRun) setNextRun(d.nextRun);
      } catch {}
    }
    pollCron();
    const id = setInterval(pollCron, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const running = s?.running;
  return (
    <div className="status">
      <span className={`dot ${running ? 'live' : 'idle'}`} />
      <span>
        {s?.error
          ? `EC2 ${s.error}`
          : running
            ? 'agent running'
            : `idle · last ${ago(s?.lastActivitySecondsAgo ?? null)}`}
      </span>
      {nextRun && (
        <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
          · next {nextRunIn(nextRun)}
        </span>
      )}
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState<Tab>('portfolio');

  return (
    <div className="shell">
      <div className="header">
        <div className="brand">
          <h1>Quant Pod</h1>
          <span className="sub">trading bot control</span>
        </div>
        <StatusBar />
      </div>

      <div className="tabs">
        {(['portfolio', 'activity', 'prompt', 'schedule'] as Tab[]).map(t => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'portfolio' ? 'Portfolio'
             : t === 'activity' ? 'Activity'
             : t === 'prompt'   ? 'System Prompt'
             :                    'Schedule'}
          </button>
        ))}
      </div>

      {tab === 'portfolio' && <Portfolio />}
      {tab === 'activity'  && <ActivityLog />}
      {tab === 'prompt'    && <PromptEditor />}
      {tab === 'schedule'  && <CronScheduler />}
    </div>
  );
}
