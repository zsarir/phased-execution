/**
 * The live session console.
 *
 * A phase is a `claude -p` process you cannot see. This is the window into it:
 * the tool calls it makes, the files it touches, the retries it absorbs, and
 * the verification the runner then runs against its work.
 *
 * It reads like a terminal because that is what it is showing, but it is not a
 * terminal emulator — there is no input, and there never will be. A session
 * that needs a decision raises an approval card; typing at it is not a thing
 * the design allows, so nothing here suggests you can.
 *
 * Two behaviours worth keeping: it follows the tail until you scroll up, and it
 * caps what it keeps. A long phase emits thousands of lines and the browser
 * should not be asked to hold all of them.
 */

import { html, useState, useEffect, useRef, useCallback } from '../html.js';

/** Beyond this the oldest lines are dropped; the journal has the full record. */
const MAX_LINES = 600;

const KIND_LABEL = {
  init: 'session',
  text: 'says',
  tool: 'tool',
  retry: 'retry',
  result: 'ended',
  stderr: 'stderr',
  verify: 'verify',
  phase: 'phase',
  runner: 'runner',
};

/**
 * Fold a server stream event into a console line, or null to ignore it.
 * Kept out of the component so the mapping is one readable table.
 */
export function toLine(event, data) {
  if (event === 'verify') {
    return { kind: 'verify', text: `[${data.index + 1}/${data.total}] ${data.command}` };
  }
  if (event === 'phase') {
    if (data.status === 'running') return { kind: 'phase', text: `phase ${data.phase} started on ${data.model}` };
    if (data.status === 'verifying') return { kind: 'phase', text: `phase ${data.phase} finished — verifying independently` };
    if (data.status === 'done') return { kind: 'phase', text: `phase ${data.phase} confirmed done` };
    if (data.disposition && data.disposition !== 'ok') {
      return { kind: 'runner', text: `phase ${data.phase}: ${data.disposition} — ${data.reason ?? ''}` };
    }
    return null;
  }
  if (event !== 'stream') return null;

  switch (data.kind) {
    case 'init':
      return { kind: 'init', text: `${data.model ?? 'session'} started · ${data.tools ?? '?'} tools available` };
    case 'tool':
      return { kind: 'tool', text: data.summary ? `${data.name}  ${data.summary}` : data.name };
    case 'text':
      return { kind: 'text', text: data.text };
    case 'retry':
      return { kind: 'retry', text: `absorbed by the CLI${data.category ? ` — ${data.category}` : ''}${data.detail ? `: ${data.detail}` : ''}` };
    case 'result':
      return { kind: 'result', text: `${data.subtype} · ${data.turns ?? 0} turns · $${(data.costUsd ?? 0).toFixed(3)}` };
    case 'stderr':
      return { kind: 'stderr', text: String(data.text ?? '').trimEnd() };
    default:
      return null;
  }
}

export function useLiveLines() {
  const [lines, setLines] = useState([]);
  const seq = useRef(0);

  const push = useCallback((line) => {
    if (!line || !line.text) return;
    setLines((current) => {
      const next = [...current, { ...line, id: ++seq.current, at: Date.now() }];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const clear = useCallback(() => setLines([]), []);
  return { lines, push, clear };
}

export function LiveConsole({ lines, onClear, title = 'Session console', subtitle, height = 380 }) {
  const box = useRef(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = (event) => {
    const el = event.currentTarget;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return html`
    <section class="live">
      <header class="live-head">
        <div class="live-title">
          <span class="lamp" data-live=${lines.length ? 'on' : 'off'}></span>
          <strong>${title}</strong>
          ${subtitle ? html`<span class="live-sub">${subtitle}</span>` : null}
        </div>
        <div class="live-tools">
          <span class="live-count">${lines.length}${lines.length === MAX_LINES ? '+' : ''} lines</span>
          <button
            class="btn small"
            aria-pressed=${String(follow)}
            title=${follow ? 'Following the tail — scroll up to stop' : 'Jump back to the newest line'}
            onClick=${() => {
              setFollow(true);
              if (box.current) box.current.scrollTop = box.current.scrollHeight;
            }}>${follow ? 'Following' : 'Follow'}</button>
          ${onClear ? html`<button class="btn small" onClick=${onClear}>Clear</button>` : null}
        </div>
      </header>

      <div class="live-body" ref=${box} onScroll=${onScroll} style=${`height:${height}px`}
           role="log" aria-live="polite" aria-label=${title}>
        ${lines.length ? lines.map((line) => html`
          <div key=${line.id} class=${`live-line k-${line.kind}`}>
            <span class="k">${KIND_LABEL[line.kind] ?? line.kind}</span>
            <span class="t">${line.text}</span>
          </div>`) : html`
          <div class="live-idle">
            Nothing running. When a phase starts, everything the session does appears here as it
            happens — tool calls, files touched, retries, and the verification that follows.
          </div>`}
      </div>
    </section>`;
}
