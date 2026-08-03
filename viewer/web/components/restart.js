/**
 * Restarting the console from the console.
 *
 * The stale-code banner has said "restart it" since the day it was written and
 * could never do it, because the one thing a browser cannot do is relaunch a
 * process. What makes it possible is the supervisor: under launchd `KeepAlive`
 * a clean exit comes straight back within seconds, and under `./run` or the
 * desktop launcher nothing does. So the button asks the server first and says
 * which it is — pressing it where nothing is watching would not restart the
 * console, it would end it, from a page that then has no server to say so.
 *
 * Refused outright while a run is in flight, and that refusal is not overridable
 * from here: a restart aborts the child mid-phase and expires every pending
 * approval unanswerably.
 */

import { html, useState, useEffect, useCallback } from '../html.js';
import { api } from '../api.js';
import { toast } from '../store.js';

/** How long to wait before reloading. The server's own drain budget is 120s,
 *  but an idle console has nothing registered and comes back almost at once. */
const RELOAD_AFTER_MS = 4_000;

export function RestartButton({ state, className = 'btn small', verbose = false }) {
  const [readiness, setReadiness] = useState(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try { setReadiness(await api.restartReadiness()); }
    catch { /* an older server has no such route; the button stays quiet */ }
  }, []);

  useEffect(() => { void check(); }, [check]);

  if (!readiness) return null;

  if (!state?.allowRun) {
    return html`<span class="muted small">
      Restarting is a run-class action — this console was started without <code>--allow-run</code>.
    </span>`;
  }

  if (!readiness.ok) {
    return html`
      <div class="stack" style="gap:4px">
        <span class="muted small">Cannot restart from here — ${readiness.reason}</span>
        <button class="linkish small" onClick=${check}>Check again</button>
      </div>`;
  }

  return html`
    <div class="row wrap" style="gap:8px;align-items:baseline">
      <button class=${className} disabled=${busy} onClick=${async () => {
        if (!confirm('Restart the console?\n\nIt exits and its supervisor starts it again — a few seconds with no server.')) return;
        setBusy(true);
        try {
          await api.restart();
          toast('Restarting — this page reloads by itself in a moment.', 'ok');
          // Nothing here can await the server coming back: the socket this
          // request arrived on is about to close. A reload after the drain is
          // the honest way to return.
          setTimeout(() => location.reload(), RELOAD_AFTER_MS);
        } catch (error) {
          setBusy(false);
          toast(String(error.message ?? error), 'error');
        }
      }}>${busy ? 'Restarting…' : 'Restart the console'}</button>
      ${verbose ? html`<span class="muted small">${readiness.supervisor?.detail}</span>` : null}
    </div>`;
}
