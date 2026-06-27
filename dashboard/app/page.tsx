'use client';

import { useEffect, useState } from 'react';
import PromptEditor from '@/components/PromptEditor';
import ActivityLog from '@/components/ActivityLog';
import Portfolio from '@/components/Portfolio';

type Tab = 'portfolio' | 'activity' | 'prompt';

interface Status {
  running: boolean;
  lastActivitySecondsAgo: number | null;
  error?: string;
}

function ago(secs: number | null): string {
  if (secs == null) return 'unknown';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
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
        const d = await r.json();
        if (alive) setS(d);
      } catch {
        if (alive) setS({ running: false, lastActivitySecondsAgo: null, error: 'unreachable' });
      }
    }
    poll();
    const id = setInterval(poll, 5000);
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
            : `idle · last activity ${ago(s?.lastActivitySecondsAgo ?? null)}`}
      </span>
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
        <button className={`tab ${tab === 'portfolio' ? 'active' : ''}`} onClick={() => setTab('portfolio')}>
          Portfolio
        </button>
        <button className={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          Activity
        </button>
        <button className={`tab ${tab === 'prompt' ? 'active' : ''}`} onClick={() => setTab('prompt')}>
          System Prompt
        </button>
      </div>

      {tab === 'portfolio' && <Portfolio />}
      {tab === 'activity' && <ActivityLog />}
      {tab === 'prompt' && <PromptEditor />}
    </div>
  );
}
