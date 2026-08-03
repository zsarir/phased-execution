import { useEffect, useState } from 'react';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import { getState, savePrefs } from './lib/api.ts';
import { openStream, type SseStatus } from './lib/sse.ts';

// Phase 1 placeholder shell. It exists to prove the foundation end to end:
//   • the @shared alias resolves the Node-importable SSOT (ROUTE_HEADS);
//   • a GET reaches the console API through the dev proxy;
//   • the SSE stream connects and names its events;
//   • a POST is accepted (proving the dev-proxy Origin rewrite past CSRF).
// Phase 2 replaces all of this with the real design system, shell and data plane.

export function App() {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [status, setStatus] = useState<SseStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<string>('—');
  const [postResult, setPostResult] = useState<string>('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    getState().then(setState).catch((e) => setStateError(String(e)));
    return openStream({
      onStatus: setStatus,
      onEvent: (name) => setLastEvent(name),
    });
  }, []);

  async function provePost() {
    setPosting(true);
    setPostResult('');
    try {
      // A no-op prefs write: echoes prefs back. Success ⇒ CSRF passed ⇒ the dev
      // proxy rewrote Host + Origin correctly.
      await savePrefs({});
      setPostResult('POST /api/prefs accepted — Origin rewrite works ✓');
    } catch (e) {
      setPostResult(String(e));
    } finally {
      setPosting(false);
    }
  }

  const root = (state?.root as { label?: string } | undefined)?.label;

  return (
    <div className="boot">
      <h1>Phase Console</h1>
      <p className="sub">React client — Phase 1 foundation shell</p>

      <div className="card">
        <h2>API (GET /api/state)</h2>
        {stateError ? (
          <p className="bad">{stateError}</p>
        ) : state ? (
          <p>
            generation <code>{String(state.generation ?? '?')}</code>
            {root ? <> · source <code>{root}</code></> : <> · <span className="ink-muted">no source open</span></>}
            {' '}<span className="ok">✓</span>
          </p>
        ) : (
          <p className="sub">loading…</p>
        )}
      </div>

      <div className="card">
        <h2>Live stream (/events)</h2>
        <p><span className={`dot ${status}`} />{status} · last event <code>{lastEvent}</code></p>
      </div>

      <div className="card">
        <h2>CSRF / dev-proxy Origin rewrite</h2>
        <button onClick={provePost} disabled={posting}>
          {posting ? 'posting…' : 'POST a no-op pref'}
        </button>
        {postResult && <p className={postResult.includes('✓') ? 'ok' : 'bad'} style={{ marginBottom: 0 }}>{postResult}</p>}
      </div>

      <div className="card">
        <h2>Shared route SSOT ({ROUTE_HEADS.length} heads)</h2>
        <div className="heads">
          {ROUTE_HEADS.map((h) => <span key={h}>{h}</span>)}
        </div>
      </div>
    </div>
  );
}
