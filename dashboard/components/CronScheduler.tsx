'use client';

import { useEffect, useState } from 'react';

interface Entry {
  id:       string; // client-side key only, never sent to API
  hour:     number; // 0–23 ET
  min:      number; // 0–59
  weekdays: number[]; // 0=Sun … 6=Sat, sorted
}

// Mon→Fri first, then Sat, Sun — mirrors how traders think about weekdays
const DAYS = [
  { label: 'M',  idx: 1 },
  { label: 'Tu', idx: 2 },
  { label: 'W',  idx: 3 },
  { label: 'Th', idx: 4 },
  { label: 'F',  idx: 5 },
  { label: 'Sa', idx: 6 },
  { label: 'Su', idx: 0 },
];

let _eid = 0;
const uid = () => `e${++_eid}`;

function fromApi(raw: { hour: number; min: number; weekdays: number[] }[]): Entry[] {
  return raw.map(e => ({ id: uid(), hour: e.hour, min: e.min, weekdays: [...e.weekdays] }));
}

function toApi(entries: Entry[]) {
  return entries.map(({ hour, min, weekdays }) => ({ hour, min, weekdays }));
}

function fingerprint(entries: Entry[]) {
  return JSON.stringify(toApi(entries));
}

function formatNextRun(isoStr: string | null): string {
  if (!isoStr) return 'none scheduled';
  const next  = new Date(isoStr);
  const diffM = Math.max(0, Math.round((next.getTime() - Date.now()) / 60_000));
  const time  = next.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const day   = next.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  });
  const rel   = diffM < 60 ? `${diffM}m`
    : `${Math.floor(diffM / 60)}h${diffM % 60 ? ` ${diffM % 60}m` : ''}`;
  return `${day} at ${time} ET · in ${rel}`;
}

export default function CronScheduler() {
  const [entries,  setEntries]  = useState<Entry[]>([]);
  const [baseline, setBaseline] = useState(''); // fingerprint of last-saved state
  const [nextRun,  setNextRun]  = useState<string | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [banner,   setBanner]   = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const dirty = fingerprint(entries) !== baseline;

  async function load() {
    setLoading(true);
    setBanner(null);
    try {
      const r = await fetch('/api/cron', { cache: 'no-store' });
      const d: { entries?: { hour: number; min: number; weekdays: number[] }[]; nextRun?: string | null; error?: string } = await r.json();
      if (d.error) throw new Error(d.error);
      const loaded = fromApi(d.entries ?? []);
      setEntries(loaded);
      setBaseline(fingerprint(loaded));
      setNextRun(d.nextRun ?? null);
    } catch (e: any) {
      setBanner({ kind: 'err', msg: `Load failed: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      const r = await fetch('/api/cron', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entries: toApi(entries) }),
      });
      const d: { ok?: boolean; nextRun?: string | null; error?: string } = await r.json();
      if (d.error) throw new Error(d.error);
      setBaseline(fingerprint(entries));
      setNextRun(d.nextRun ?? null);
      setBanner({ kind: 'ok', msg: 'Schedule saved · crontab installed on EC2' });
    } catch (e: any) {
      setBanner({ kind: 'err', msg: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  }

  function addEntry() {
    setEntries(prev => [...prev, { id: uid(), hour: 9, min: 30, weekdays: [1, 2, 3, 4, 5] }]);
  }

  function removeEntry(id: string) {
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  function setTime(id: string, val: string) {
    const [h, m] = val.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, hour: h, min: m } : e));
    }
  }

  function toggleDay(id: string, dayIdx: number) {
    setEntries(prev => prev.map(e => {
      if (e.id !== id) return e;
      const wds = e.weekdays.includes(dayIdx)
        ? e.weekdays.filter(d => d !== dayIdx)
        : [...e.weekdays, dayIdx].sort((a, b) => a - b);
      return { ...e, weekdays: wds };
    }));
  }

  return (
    <div className="card">
      {/* Header */}
      <div className="row" style={{ marginBottom: 4 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Schedule</div>
          <div className="meta" style={{ marginTop: 3 }}>
            {loading
              ? 'Loading…'
              : <>next run: <span style={{ color: 'var(--accent)' }}>{formatNextRun(nextRun)}</span></>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn ghost" onClick={load} disabled={loading || saving}>Reload</button>
          <button className="btn ghost" onClick={addEntry} disabled={loading}>+ Add Run</button>
          <button className="btn" onClick={save} disabled={!dirty || saving || loading}>
            {saving ? 'Saving…' : dirty ? 'Save → EC2' : 'Saved'}
          </button>
        </div>
      </div>

      {banner && <div className={`banner ${banner.kind}`} style={{ marginBottom: 14 }}>{banner.msg}</div>}

      {/* Column headers */}
      {!loading && entries.length > 0 && (
        <div className="cron-col-heads">
          <span>Time (ET)</span>
          <span>Days</span>
        </div>
      )}

      {/* Entry rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map(entry => (
          <div key={entry.id} className="cron-row">
            <input
              type="time"
              className="cron-time"
              value={`${String(entry.hour).padStart(2, '0')}:${String(entry.min).padStart(2, '0')}`}
              onChange={e => setTime(entry.id, e.target.value)}
            />
            <div className="cron-days">
              {DAYS.map(d => (
                <button
                  key={d.idx}
                  onClick={() => toggleDay(entry.id, d.idx)}
                  className={`cron-day${entry.weekdays.includes(d.idx) ? ' on' : ''}`}
                  title={['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.idx]}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <button className="cron-remove" onClick={() => removeEntry(entry.id)} title="Remove">×</button>
          </div>
        ))}
      </div>

      {!loading && entries.length === 0 && (
        <div className="meta" style={{ padding: '20px 0', textAlign: 'center' }}>
          No scheduled runs — click "+ Add Run" to create one
        </div>
      )}
    </div>
  );
}
