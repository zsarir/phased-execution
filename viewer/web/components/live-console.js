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

import { MAX_LINES, KIND_LABEL, QUIET, toLine, fold } from './console-model.js';

// Re-exported so every existing importer keeps its one import of this module.
export { toLine, fold };

export function useLiveLines() {
  const [lines, setLines] = useState([]);
  const seq = useRef(0);
  const hydrated = useRef(false);

  const push = useCallback((line) => {
    if (!line || !line.text) return;
    setLines((current) => fold(current, line, ++seq.current));
  }, []);

  /**
   * Replay a run's recorded events, once, in front of whatever is arriving live.
   *
   * Without this the window was empty until the next event happened to fire —
   * so a finished phase showed nothing at all, and a reload mid-run threw away
   * everything printed before the refresh. The events are stored raw and folded
   * through the same `toLine` the live stream uses, so a replayed run and a
   * watched one cannot drift apart in how they read.
   */
  const hydrate = useCallback((entries) => {
    if (hydrated.current || !entries?.length) return;
    hydrated.current = true;
    let replayed = [];
    for (const entry of entries) {
      const line = toLine(entry.event, entry.data ?? {});
      // Folded exactly as the live stream folds it — a replay that expanded
      // every recorded token fragment would be both unreadable and enormous.
      if (line?.text) {
        replayed = fold(replayed, { ...line, replayed: true }, ++seq.current, Date.parse(entry.at) || Date.now());
      }
    }
    if (!replayed.length) return;
    setLines((current) => [...replayed, ...current].slice(-MAX_LINES));
  }, []);

  const clear = useCallback(() => setLines([]), []);
  return { lines, push, clear, hydrate };
}

export function LiveConsole({ lines, onClear, title = 'Session console', subtitle, height = 380, footer }) {
  const box = useRef(null);
  const [follow, setFollow] = useState(true);
  const [verbose, setVerbose] = useState(false);

  const shown = verbose ? lines : lines.filter((line) => !QUIET.has(line.kind));
  const hidden = lines.length - shown.length;

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

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
          <span class="live-count">${shown.length}${lines.length === MAX_LINES ? '+' : ''} lines</span>
          ${hidden || verbose ? html`
            <button
              class="btn small"
              aria-pressed=${String(verbose)}
              title="The model's working and every hook call — useful when something is wrong, noise when it is not"
              onClick=${() => setVerbose(!verbose)}>
              ${verbose ? 'Hide detail' : `Detail${hidden ? ` (${hidden})` : ''}`}
            </button>` : null}
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
        ${shown.length ? shown.map((line) => html`
          <div key=${line.id} class=${`live-line k-${line.kind}${line.replayed ? ' is-replayed' : ''}`}>
            <span class="k">${KIND_LABEL[line.kind] ?? line.kind}</span>
            <span class="t">${line.text}</span>
            ${/* The tick is the CLI's own echo coming back. Until it arrives the
                  message has been written to a pipe and nothing more, and that
                  distinction is the whole reason `--replay-user-messages` is on. */
              line.mark && (line.kind === 'injected' || line.kind === 'steer')
                ? html`<span class="live-tick" title=${line.delivered
                    ? 'The session echoed this back — it landed'
                    : 'Written to the session; waiting for it to echo back'}>
                    ${line.delivered ? '✓' : '·'}
                  </span>`
                : null}
          </div>`) : html`
          <div class="live-idle">
            Nothing to show yet. When a phase runs, everything the session does appears here as it
            happens — tool calls, files touched, retries, and the verification that follows — and it
            is kept, so coming back to a finished run replays it rather than showing you this.
          </div>`}
      </div>

      ${footer ?? null}
    </section>`;
}
