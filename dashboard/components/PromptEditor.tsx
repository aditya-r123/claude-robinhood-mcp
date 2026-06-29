'use client';

import { useEffect, useState } from 'react';

interface PromptResp {
  content: string;
  path: string;
  md5: string;
  bytes: number;
}
interface SaveResp {
  ok: boolean;
  localMd5: string;
  remoteMd5: string;
  synced: boolean;
  syncError?: string;
}

export default function PromptEditor() {
  const [original, setOriginal] = useState('');
  const [draft, setDraft] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const dirty = draft !== original;

  async function load() {
    setLoading(true);
    setBanner(null);
    try {
      const r = await fetch('/api/prompt', { cache: 'no-store' });
      const d: PromptResp & { error?: string } = await r.json();
      if (d.error) throw new Error(d.error);
      setOriginal(d.content);
      setDraft(d.content);
      setPath(d.path);
    } catch (e: any) {
      setBanner({ kind: 'err', msg: `Load failed: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      const r = await fetch('/api/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const d: SaveResp & { error?: string } = await r.json();
      if (d.error) throw new Error(d.error);
      setOriginal(draft);
      if (d.synced) {
        setBanner({ kind: 'ok', msg: `Saved locally + synced to AWS · md5 ${d.localMd5.slice(0, 10)}` });
      } else {
        setBanner({ kind: 'err', msg: `Saved locally, but AWS sync FAILED: ${d.syncError || 'unknown'}` });
      }
    } catch (e: any) {
      setBanner({ kind: 'err', msg: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  }

  // Claude token estimate: ~4 chars/token for English prose/code (BPE approximation).
  // Word-weighted refinement: words × 1.3 to account for punctuation and subword splits.
  const chars  = draft.length;
  const words  = draft.split(/\s+/).filter(Boolean).length;
  const tokens = Math.round(Math.max(chars / 4, words * 1.3));

  return (
    <div className="card">
      <div className="row">
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={load} disabled={loading || saving}>
            Reload
          </button>
          <button className="btn" onClick={save} disabled={!dirty || saving || loading}>
            {saving ? 'Saving…' : dirty ? 'Save → local + AWS' : 'Saved'}
          </button>
        </div>
      </div>

      {banner && <div className={`banner ${banner.kind}`} style={{ marginBottom: 12 }}>{banner.msg}</div>}

      <textarea
        className="editor"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={loading ? 'Loading…' : ''}
      />
      <div className="meta" style={{ marginTop: 8 }}>
        {chars.toLocaleString()} chars / {tokens.toLocaleString()} input tokens
        {dirty ? ' · unsaved changes' : ''}
      </div>
    </div>
  );
}
