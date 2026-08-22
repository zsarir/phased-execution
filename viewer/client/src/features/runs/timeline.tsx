/**
 * The timeline: where a run's wall-clock actually went, phase by phase.
 *
 * A run's cost table answers "what did this spend". It does not answer the
 * question people actually ask of a run that took four hours — *where did the
 * four hours go* — because a phase's `durationMs` is one number covering three
 * very different things:
 *
 *   1. **working** — the session was alive and spending;
 *   2. **frozen** — the session was alive and deliberately stopped (`frozenMs`,
 *      a SIGSTOP that costs nothing and still burns the clock);
 *   3. **waiting** — the phase was parked on something outside it: a
 *      `waiting-external` park, a foreign lock, an MCP wall.
 *
 * Three segments, so the shape of the bar is the diagnosis. A run that is
 * mostly amber was not slow, it was blocked — and that is a different fix from
 * a run that is mostly ink.
 *
 * ## Every figure comes off the record
 *
 * Nothing here is modelled. `frozenMs` and `durationMs` are written by the
 * runner; the waiting slice is what the park clocks account for and is CLAMPED
 * to the duration rather than trusted — a park that outlived its phase (a
 * console restart across a park, most often) would otherwise paint a bar wider
 * than the run. Where the two disagree, the duration wins, because it is the
 * one measured end to end.
 *
 * Bars are scaled against the LONGEST phase, not against the run's total: the
 * useful comparison is phase against phase, and a total-scaled bar makes every
 * phase of a long run a hairline.
 */

import { Card, CardBody, CardHeader, CardTitle, Empty } from '@/components/ui';
import { duration } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { PhaseRecord } from '@/lib/api';

/** One phase's wall clock, split into the three things it can be spent on. */
export interface Span {
  phase: number;
  /** Total wall clock for the phase, ms. */
  totalMs: number;
  workingMs: number;
  frozenMs: number;
  waitingMs: number;
  /** Still open — the bar is drawn hatched rather than solid. */
  live: boolean;
}

/** How long a record was parked, from the clocks the runner writes. */
function waitingOf(record: PhaseRecord, now: number): number {
  // A park that has not elapsed yet is still being served: count from its
  // start. `parkedUntil` is in the FUTURE while parked, which is why it cannot
  // simply be subtracted from anything.
  if (!record.parkedUntil) return 0;
  const until = Date.parse(record.parkedUntil);
  if (!Number.isFinite(until)) return 0;
  const started = record.startedAt ? Date.parse(record.startedAt) : NaN;
  if (!Number.isFinite(started)) return 0;
  // The park's own window, bounded by now: a park still running has served
  // only up to this moment, and one that elapsed served all of it.
  return Math.max(0, Math.min(until, now) - started);
}

/**
 * The records, as spans. Exported because it is the whole of the arithmetic and
 * it is worth testing without rendering anything.
 */
export function spansOf(records: readonly PhaseRecord[], now: number): Span[] {
  return records
    .map((record) => {
      const started = record.startedAt ? Date.parse(record.startedAt) : NaN;
      const ended = record.endedAt ? Date.parse(record.endedAt) : NaN;
      const live = Number.isFinite(started) && !Number.isFinite(ended);
      // Prefer the runner's own figure; fall back to the clock for a phase
      // still open, which has no `durationMs` yet by definition.
      const totalMs = Number.isFinite(record.durationMs as number)
        ? Math.max(0, record.durationMs as number)
        : Number.isFinite(started)
          ? Math.max(0, (Number.isFinite(ended) ? ended : now) - started)
          : 0;
      const frozenMs = Math.min(totalMs, Math.max(0, record.frozenMs ?? 0));
      const waitingMs = Math.min(totalMs - frozenMs, waitingOf(record, now));
      return {
        phase: record.phase,
        totalMs,
        frozenMs,
        waitingMs,
        workingMs: Math.max(0, totalMs - frozenMs - waitingMs),
        live,
      };
    })
    .filter((span) => span.totalMs > 0)
    .sort((a, b) => a.phase - b.phase);
}

const SEGMENTS = [
  { key: 'workingMs', label: 'working', className: 'bg-progress' },
  { key: 'waitingMs', label: 'waiting', className: 'bg-accent' },
  { key: 'frozenMs', label: 'frozen', className: 'bg-ink-faint/50' },
] as const;

export function Timeline({
  phases,
  now = Date.now(),
  className,
}: {
  phases: readonly PhaseRecord[];
  /** Injectable so a test can draw a live phase without a real clock. */
  now?: number;
  className?: string;
}) {
  const spans = spansOf(phases, now);
  const longest = spans.reduce((max, span) => Math.max(max, span.totalMs), 0);

  return (
    <Card className={className}>
      <CardHeader className="flex-wrap items-baseline">
        <CardTitle>Timeline</CardTitle>
        <span className="max-w-prose text-2xs text-ink-faint">
          Wall clock per phase, split into working, waiting on something outside the phase, and frozen. Scaled
          against the longest phase.
        </span>
      </CardHeader>
      <CardBody>
        {spans.length ? (
          <>
            <ol className="flex flex-col gap-1.5">
              {spans.map((span) => (
                <li key={span.phase} className="grid grid-cols-[3rem_1fr_auto] items-center gap-2">
                  <span className="font-mono text-2xs text-ink-faint tabular-nums">p{span.phase}</span>
                  <span
                    role="img"
                    aria-label={`phase ${span.phase}: ${SEGMENTS.filter((s) => span[s.key] > 0)
                      .map((s) => `${duration(span[s.key])} ${s.label}`)
                      .join(', ')}`}
                    className="flex h-2.5 overflow-hidden rounded-full bg-surface-sunken"
                    style={{ width: `${longest ? Math.max(2, (span.totalMs / longest) * 100) : 0}%` }}
                  >
                    {SEGMENTS.map((segment) =>
                      span[segment.key] > 0 ? (
                        <span
                          key={segment.key}
                          className={cn(segment.className, span.live && 'animate-pulse')}
                          style={{ width: `${(span[segment.key] / span.totalMs) * 100}%` }}
                        />
                      ) : null,
                    )}
                  </span>
                  <span className="font-mono text-2xs text-ink-faint tabular-nums">
                    {duration(span.totalMs)}
                  </span>
                </li>
              ))}
            </ol>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-faint">
              {SEGMENTS.map((segment) => (
                <li key={segment.key} className="flex items-center gap-1.5">
                  <span className={cn('size-2 rounded-full', segment.className)} aria-hidden="true" />
                  {segment.label}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty
            title="Nothing has taken any time yet"
            body="A phase appears here once it has started. The bar splits its wall clock into working, waiting and frozen, so a slow run and a blocked one do not look alike."
          />
        )}
      </CardBody>
    </Card>
  );
}

export default Timeline;
