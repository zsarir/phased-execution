/**
 * **Running now** — every lane in flight, worst first, and why nothing is when
 * nothing is.
 *
 * ## One subscription, not one per row
 *
 * Each row can open a tail of what its session is saying. The obvious build is
 * a `useLiveLines()` per row, and it is the wrong one: that is one `run:stream`
 * subscriber and one bounded ring per lane, on the page a phone opens first.
 * So the SECTION subscribes once, folds each event into the ring for the lane
 * it names, and hands each row a slice. `TAIL_LINES` is deliberately tiny —
 * this is a glance, and `#/plan/:slug/run` is where the console with the
 * search box, the permalinks and the replay lives.
 *
 * The tail starts empty on purpose. There is no replay here: a transcript is
 * up to 4 MB per run and hydrating one per lane to fill a collapsed panel
 * would be the most expensive thing the home page does. The panel says so
 * rather than looking broken.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { Badge, Card } from '@/components/ui';
import { fold, toLine, type ConsoleLine } from '@/features/runs/console-model';
import { onSse } from '@/lib/sse';
import { useNow } from '@/lib/clock';
import { elapsed, plural } from '@/lib/format';
import type { ForeignSession } from '@/lib/api';
import { LaneRow } from './lane-row';
import { idleReason, type NowLane } from './model';

/** How many lines of a lane's stream this page keeps. A glance, not a log. */
export const TAIL_LINES = 8;

/**
 * One `run:stream` subscription, folded per lane.
 *
 * Keyed `${runId}#${phase}` — the same key `nowLanes` mints — so a row looks
 * its tail up without the section knowing anything about rows. A run-level
 * event with no phase is dropped rather than guessed at: attributing it to the
 * lowest-numbered lane is how a subagent's line ends up under another phase.
 */
export function useLaneTails(enabled: boolean): Map<string, ConsoleLine[]> {
  const [tails, setTails] = useState<Map<string, ConsoleLine[]>>(() => new Map());
  const seq = useRef(0);

  const record = useCallback((data: Record<string, unknown>) => {
    const runId = typeof data.runId === 'string' ? data.runId : null;
    const phase = typeof data.phase === 'number' ? data.phase : null;
    if (!runId || phase == null) return;
    const line = toLine('stream', data);
    if (!line?.text) return;
    setTails((current) => {
      const key = `${runId}#${phase}`;
      const next = new Map(current);
      next.set(key, fold(current.get(key) ?? [], line, ++seq.current).slice(-TAIL_LINES));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    return onSse('run:stream', (data) => {
      if (data && typeof data === 'object') record(data as Record<string, unknown>);
    });
  }, [enabled, record]);

  return tails;
}

export interface LiveLanesProps {
  lanes: NowLane[];
  allowRun: boolean;
  signedOut: boolean;
  ready: number;
  needsYou: number;
  /** Hook-reported sessions no lane row draws — see `otherSessions`. */
  others: ForeignSession[];
  /** `?focus=lanes` landed here. */
  focused?: boolean;
}

export function LiveLanes({
  lanes,
  allowRun,
  signedOut,
  ready,
  needsYou,
  others,
  focused = false,
}: LiveLanesProps) {
  const tails = useLaneTails(lanes.length > 0);
  const queued = lanes.filter((lane) => lane.status === 'queued').length;
  const stalled = lanes.filter((lane) => lane.liveness?.stall).length;
  const idle = useMemo(
    () => idleReason({ allowRun, signedOut, ready, queued, needsYou }),
    [allowRun, signedOut, ready, queued, needsYou],
  );

  return (
    <section
      aria-label="Running now"
      data-testid="live-lanes"
      {...(focused ? { 'data-focused': 'true' } : {})}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">Running now</h2>
        {lanes.length > 0 && (
          <span className="text-2xs text-ink-faint">
            {plural(lanes.length, 'lane')}
            {queued ? ` · ${queued} queued` : ''}
            {stalled ? ` · ${stalled} not moving` : ''}
          </span>
        )}
      </div>

      {lanes.length === 0 ? (
        <Card className="state-ready px-3 py-2.5 md:px-4">
          <p className="text-md">{idle.headline}</p>
          <p className="mt-0.5 text-2xs text-ink-muted">{idle.detail}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.key}
              lane={lane}
              {...(tails.get(lane.key) ? { tail: tails.get(lane.key)! } : {})}
              allowRun={allowRun}
            />
          ))}
        </ul>
      )}

      {others.length > 0 && <OtherSessions sessions={others} />}
    </section>
  );
}

/**
 * Sessions the presence hook reported that no lane above accounts for — a
 * `claude` somebody started by hand in this repository, or one that ended in
 * the last hour.
 *
 * They belong under "running now" and nowhere else: an agent session left
 * working overnight is as much what is running as an autopilot lane, and until
 * the Pulse page was absorbed nothing but that page listed one.
 */
function OtherSessions({ sessions }: { sessions: ForeignSession[] }) {
  const now = useNow(sessions.some((s) => s.presence === 'live'));
  return (
    <div className="mt-2 rounded-lg border border-rule bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
        <Terminal size={13} className="text-ink-faint" aria-hidden />
        <span className="text-sm font-medium text-ink">Other sessions</span>
        <span className="text-2xs text-ink-faint">reported by the session-presence hook</span>
      </header>
      <ul className="flex flex-col gap-1 p-2">
        {sessions.map((session) => (
          <li
            key={session.sessionId}
            data-testid="other-session"
            className="flex items-center gap-3 rounded border-l-4 border-ink-faint/50 bg-ground-deep/40 px-3 py-2"
            title={`${session.kind} ${session.sessionId} in ${session.cwd}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">
                {session.plan
                  ? `${session.plan.slug} · P${session.plan.phase}`
                  : (session.root ?? session.cwd)}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                <Badge
                  tone={session.presence === 'live' ? 'live' : 'neutral'}
                  dot={session.presence === 'live'}
                >
                  {session.kind}
                  {session.presence === 'ended' ? ' · ended' : ''}
                </Badge>
                {session.user && (
                  <span className="font-mono">
                    {session.user}
                    {session.host ? `@${session.host}` : ''}
                  </span>
                )}
                <span className="font-mono text-ink-faint">{session.sessionId.slice(0, 8)}</span>
              </span>
            </span>
            <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">
              {session.presence === 'live'
                ? elapsed(now - Date.parse(session.startedAt))
                : session.endedAt
                  ? `ended ${elapsed(now - Date.parse(session.endedAt))} ago`
                  : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
