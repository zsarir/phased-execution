/**
 * The live session console: what the phase is saying, as it says it.
 *
 * A phase is a `claude -p` process you cannot see. This is the window into it —
 * the tool calls it makes, the files it touches, the retries it absorbs, and the
 * verification the runner then runs against its work.
 *
 * It reads like a terminal because that is what it is showing, but it is not a
 * terminal emulator: there is no input, and there never will be. A session that
 * needs a decision raises an approval card. (Phase 6's terminal page is a
 * different thing entirely — a real pty, deliberately not this.)
 *
 * ## Why the firehose does not go through the cache
 *
 * `run:stream` arrives many times a second while a phase is talking. Routing it
 * through TanStack Query would refetch the whole run object per line, so it is
 * marked `streamOnly` in `EVENT_EFFECTS` and subscribed to **directly** here.
 * The rest of the tab still refreshes from the cache off `run:phase` and
 * `run:state`, which arrive a few times a minute.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { onSse } from '@/lib/sse';
import { cn } from '@/lib/cn';
import {
  KIND_LABEL, MAX_LINES, NO_ACTIVITY, QUIET, activity, fold, toLine,
  type Activity, type ConsoleLine,
} from './console-model';
import type { TranscriptEntry } from '@/lib/api';

/**
 * One stream of events, two readings of it.
 *
 * Callers used to map an event to a line themselves, which quietly made the
 * console the only thing an event could become. The panels need the *raw* event
 * — a task list is an array, not a sentence — so the mapping lives in here and
 * every subscriber hands over what the server actually sent.
 */
export function useLiveLines() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [panels, setPanels] = useState<Activity>(NO_ACTIVITY);
  const seq = useRef(0);
  const hydrated = useRef(false);

  const record = useCallback((event: string, data: Record<string, unknown>) => {
    const line = toLine(event, data);
    if (line?.text) setLines((current) => fold(current, line, ++seq.current));
    // `activity` returns the same object when an event changes nothing, and
    // most stream events change nothing. Passing that reference straight to
    // `setPanels` is what makes React bail out instead of re-rendering three
    // panels per token — do not "helpfully" spread it.
    setPanels((current) => activity(current, event, data));
  }, []);

  /**
   * Replay a run's recorded events, once, in front of whatever is arriving live.
   *
   * Without this the window is empty until the next event happens to fire —
   * which, on a run that already finished, is never. The events are stored raw
   * and folded through the same `toLine`/`activity` the live stream uses, so a
   * replayed run and a watched one cannot drift apart in how they read.
   */
  const hydrate = useCallback((entries: TranscriptEntry[] | undefined) => {
    if (hydrated.current || !entries?.length) return;
    hydrated.current = true;
    let replayed: ConsoleLine[] = [];
    let state = NO_ACTIVITY;
    for (const entry of entries) {
      const at = Date.parse(entry.at) || Date.now();
      const data = entry.data ?? {};
      const line = toLine(entry.event, data);
      if (line?.text) replayed = fold(replayed, { ...line, replayed: true }, ++seq.current, at);
      state = activity(state, entry.event, data, at);
    }
    if (state !== NO_ACTIVITY) setPanels(state);
    if (!replayed.length) return;
    setLines((current) => [...replayed, ...current].slice(-MAX_LINES));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setPanels(NO_ACTIVITY);
  }, []);

  return { lines, activity: panels, record, clear, hydrate };
}

/**
 * Subscribe the console to the three event kinds it renders.
 *
 * `run:stream` is the firehose; `run:phase` and `run:verify` are the runner's own
 * narration of what it is doing between sessions. All three are read here for
 * the console *in addition to* whatever the cache does with them — a phase event
 * both prints a line and invalidates the run, and neither is a substitute.
 */
export function useRunStream(
  record: (event: string, data: Record<string, unknown>) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const as = (name: 'stream' | 'phase' | 'verify') => (data: unknown) => {
      if (data && typeof data === 'object') record(name, data as Record<string, unknown>);
    };
    const offs = [
      onSse('run:stream', as('stream')),
      onSse('run:phase', as('phase')),
      onSse('run:verify', as('verify')),
    ];
    return () => { for (const off of offs) off(); };
  }, [record, enabled]);
}

/** Which session's events a pane wants: one run, optionally one of its lanes. */
export interface SessionFilter {
  runId: string;
  /** Omitted on the aggregate pane: every lane of the run, as before. */
  phase?: number | undefined;
  /**
   * Run-level pane: keep the runner's own narration (`phase`, `verify`) and
   * drop the session firehose. An unfiltered stream is two sessions' sentences
   * spliced into one paragraph the moment a second lane opens — the lanes own
   * their text; the run pane owns what the RUNNER did between them.
   */
  omitStream?: boolean | undefined;
}

/**
 * The same three subscriptions, narrowed to ONE session.
 *
 * `useRunStream` was written when there was one runner and therefore one session:
 * every `run:stream` on the wire belonged to the only thing running, so appending
 * all of them was right. With a runner pool and per-phase lanes it stopped being
 * right in the way that is hardest to notice — nothing errors, the console simply
 * shows two sessions' sentences spliced into one paragraph, and the reader has no
 * way to tell which half is which.
 *
 * Every payload has carried `{runId, slug}` since before the pool, and the three
 * events read here also carry `phase` (`runner.ts` `emit()` stamps the first two
 * on everything; `stream`/`phase`/`verify` pass the third). So the fix is a
 * predicate, not a protocol: the events were always separable.
 *
 * **The phase filter is also what keeps the panels honest.** `activity()` clears
 * the task list on `phase`+`running` — a new phase is a new session with a new
 * list. Unfiltered, phase 7 starting wipes phase 6's panel while phase 6 is still
 * working in the tab next door. Filtering here means the reset can only be fired
 * by the pane's own phase, so `console-model.js` needs no notion of lanes at all.
 */
export function useSessionStream(
  record: (event: string, data: Record<string, unknown>) => void,
  enabled: boolean,
  filter: SessionFilter,
): void {
  const { runId, phase, omitStream } = filter;
  useEffect(() => {
    if (!enabled || !runId) return undefined;
    const as = (name: 'stream' | 'phase' | 'verify') => (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const payload = data as Record<string, unknown>;
      if (payload.runId !== runId) return;
      // `!= null`, not truthy: phase 0 is a legitimate phase number, and `phase`
      // being absent from a payload is not the same as it being another lane's.
      if (phase != null && payload.phase !== phase) return;
      record(name, payload);
    };
    const offs = [
      // Not subscribed at all rather than filtered out: the firehose is the
      // heaviest event on the wire, and a pane that drops every frame should
      // not be paying to receive them.
      ...(omitStream ? [] : [onSse('run:stream', as('stream'))]),
      onSse('run:phase', as('phase')),
      onSse('run:verify', as('verify')),
    ];
    return () => { for (const off of offs) off(); };
  }, [record, enabled, runId, phase, omitStream]);
}

/**
 * A recorded run's events, narrowed to one lane before they are replayed.
 *
 * The transcript endpoint is per-run, and deliberately stays that way: it is one
 * append-only file per run, and splitting it per phase would mean a fetch per tab
 * of a payload that is already up to 4 MB. Filtering the replay here costs one
 * pass over an array the client has anyway.
 *
 * Entries with no `phase` at all — the run-level narration — are kept, because
 * dropping them would leave a lane's replay starting mid-sentence.
 */
export function forPhase(
  entries: TranscriptEntry[] | undefined,
  phase: number | undefined,
): TranscriptEntry[] | undefined {
  if (!entries || phase == null) return entries;
  return entries.filter((entry) => {
    const at = entry.data?.phase;
    return at == null || at === phase;
  });
}

/** How close to the bottom still counts as "following the tail". */
const FOLLOW_SLACK = 40;

export function LiveConsole({
  lines,
  onClear,
  title = 'Session console',
  subtitle,
  footer,
  actions,
}: {
  lines: readonly ConsoleLine[];
  onClear?: () => void;
  title?: string;
  subtitle?: string;
  footer?: React.ReactNode;
  /** Session controls (freeze/stop) rendered in the toolbar, before Detail. */
  actions?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [verbose, setVerbose] = useState(false);

  const shown = verbose ? lines : lines.filter((line) => !QUIET.has(line.kind));
  const hidden = lines.length - shown.length;

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <section className="rounded-lg border border-rule bg-surface-raised">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'size-2 shrink-0 rounded-full',
              lines.length ? 'bg-progress shadow-[0_0_6px_currentColor] text-progress' : 'bg-ink-faint/40',
            )}
          />
          <strong className="truncate text-sm">{title}</strong>
          {subtitle && <span className="truncate font-mono text-2xs text-ink-faint">{subtitle}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <span className="font-mono text-2xs text-ink-faint tabular-nums">
            {shown.length}
            {lines.length === MAX_LINES ? '+' : ''} lines
          </span>
          {(hidden > 0 || verbose) && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={verbose}
              title="The model's working and every hook call — useful when something is wrong, noise when it is not"
              onClick={() => setVerbose(!verbose)}
            >
              {verbose ? 'Hide detail' : `Detail${hidden ? ` (${hidden})` : ''}`}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={follow}
            title={follow ? 'Following the tail — scroll up to stop' : 'Jump back to the newest line'}
            onClick={() => {
              setFollow(true);
              if (box.current) box.current.scrollTop = box.current.scrollHeight;
            }}
          >
            {follow ? 'Following' : 'Follow'}
          </Button>
          {onClear && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </header>

      <div
        ref={box}
        role="log"
        aria-live="polite"
        aria-label={title}
        className="live-body h-[min(380px,50dvh)] overflow-y-auto px-3 py-2 font-mono text-2xs leading-relaxed"
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK);
        }}
      >
        {shown.length ? (
          shown.map((line) => (
            <div key={line.id} className={cn('live-line', `k-${line.kind}`, line.replayed && 'is-replayed')}>
              <span className="live-k">{KIND_LABEL[line.kind] ?? line.kind}</span>
              <span className="live-t">{line.text}</span>
              {/* The tick is the CLI's own echo coming back. Until it arrives the
                  message has been written to a pipe and nothing more, and that
                  distinction is the whole reason `--replay-user-messages` is on. */}
              {line.mark && (line.kind === 'injected' || line.kind === 'steer') && (
                <span
                  className={cn('live-tick', line.delivered && 'is-delivered')}
                  title={line.delivered
                    ? 'The session echoed this back — it landed'
                    : 'Written to the session; waiting for it to echo back'}
                >
                  {line.delivered ? '✓' : '·'}
                </span>
              )}
            </div>
          ))
        ) : (
          <p className="max-w-prose py-6 text-ink-faint">
            Nothing to show yet. When a phase runs, everything the session does appears here as it
            happens — tool calls, files touched, retries, and the verification that follows — and it
            is kept, so coming back to a finished run replays it rather than showing you this.
          </p>
        )}
      </div>

      {footer}
    </section>
  );
}
