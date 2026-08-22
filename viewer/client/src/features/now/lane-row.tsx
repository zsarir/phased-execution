/**
 * One phase being worked on right now.
 *
 * ## Why a LANE and not a run
 *
 * The strip this replaces drew one line per run with one clock on it. A run
 * can drive several disjoint-scope phases at once, so "three phases in flight,
 * one of them silent for forty minutes" was rendered as a single calm line
 * with the wrong elapsed time and no way to see the silence at all. The unit
 * on this page is the lane, because the lane is the thing that is working, the
 * thing that is spending, and the thing that stalls.
 *
 * ## What the row promises
 *
 * State, heartbeat, cost, elapsed, ETA and model — and each of them says "I
 * cannot tell you" rather than guessing when the fact is missing:
 *
 *  - the **heartbeat** stops pulsing once the silence passes the stall
 *    threshold and writes the silence out instead. A dot that keeps beating
 *    over a wedged session is the lie this console exists not to tell;
 *  - the **ETA** is the SERVER's `PhaseEta` for this phase, never arithmetic
 *    done here. The estimate is a rate reading over the plan's own history and
 *    a bucketing rule; a second implementation in the browser would disagree
 *    with the plan page the first time either changed;
 *  - the **tail** is the live stream, bounded. It is collapsed by default
 *    because a home page that prints eight lines per lane is a log viewer.
 */

import { useState } from 'react';
import { ChevronRight, Snowflake } from 'lucide-react';
import { Badge, Button, Heartbeat, StatusBadge } from '@/components/ui';
import { LivenessChip } from '@/features/runs/phase-row';
import { AskBox } from '@/features/runs/ask-box';
import type { ConsoleLine } from '@/features/runs/console-model';
import { useNow } from '@/lib/clock';
import { elapsed, money, relativeTime } from '@/lib/format';
import { phaseStatusTitle } from '@/lib/status-vocab';
import { plainText } from '@/lib/plain-text';
import { cn } from '@/lib/cn';
import { planHref } from '@shared/routes.js';
import { STALL_DEFAULTS } from '@shared/attention-model.js';
import type { NowLane } from './model';

/** The stall detector's own floor, so the dot and the runner agree on "silent". */
const SILENT_AFTER_MS: number = STALL_DEFAULTS.stallSilentMs;

export function LaneRow({
  lane,
  tail,
  allowRun,
}: {
  lane: NowLane;
  /** The last few lines of this lane's stream, newest last. */
  tail?: readonly ConsoleLine[];
  allowRun: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = lane.status === 'running' && !lane.frozen;
  const now = useNow(running);
  const started = lane.startedAt ? Date.parse(lane.startedAt) : NaN;
  const beat = lane.liveness?.lastOutputAt ? Date.parse(lane.liveness.lastOutputAt) : null;

  return (
    <li
      data-testid="lane-row"
      data-phase={lane.phase}
      data-slug={lane.slug}
      className={cn(
        'flex flex-col rounded-lg border bg-surface',
        lane.liveness?.stall ? 'border-accent/50' : 'border-rule',
      )}
    >
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <StatusBadge state={lane.status} pulse title={phaseStatusTitle(lane.status)} />
          <a
            href={planHref(lane.slug, 'run')}
            className="min-w-0 flex-1 truncate font-display text-lg leading-tight hover:text-action"
            title={plainText(lane.planTitle)}
          >
            {lane.slug}
          </a>
          {lane.frozen && (
            <Badge tone="wait">
              <Snowflake size={11} aria-hidden />
              frozen
            </Badge>
          )}
        </div>

        <p className="min-w-0 truncate text-2xs text-ink-muted">
          phase {lane.phase}
          {lane.title ? ` — ${plainText(lane.title)}` : ''}
          {lane.attempts > 1 ? ` · attempt ${lane.attempts}` : ''}
        </p>

        {/* The facts, in one wrapping row: on a phone they stack, and every one
            of them is short enough that stacking is legible rather than a list
            of orphaned numbers. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Heartbeat lastBeatAt={beat} staleAfterMs={SILENT_AFTER_MS} live={running} label="lane" />
          <LivenessChip liveness={lane.liveness} />
          {Number.isFinite(started) && (
            <Badge tone="neutral" mono title={`started ${new Date(started).toLocaleString()}`}>
              {elapsed(now - started)}
            </Badge>
          )}
          <Badge tone="neutral" mono title="what this lane has spent so far">
            {money(lane.costUsd)}
          </Badge>
          {lane.eta ? (
            <Badge
              tone="neutral"
              mono
              title={`The server's estimate for a phase this size, from a ${lane.eta.basis} rate reading. A range, never a promise.`}
            >
              {/* `PhaseEta.label` carries its own hedge — it arrives as `~45 min`.
                  Prefixing a second one printed `~~45 min` on the live page,
                  which reads as a typo rather than as an estimate. */}
              {lane.eta.label}
            </Badge>
          ) : (
            <span className="text-2xs text-ink-faint" title="No estimate: this plan has no rate reading yet.">
              no ETA
            </span>
          )}
          {lane.model && (
            <Badge tone="neutral" mono>
              {lane.model}
              {lane.effort ? ` · ${lane.effort}` : ''}
            </Badge>
          )}
        </div>

        {/* A lane that is NOT running says what it is waiting for. The three
            reasons want three different sentences, and "queued" with no
            explanation is the one an operator reads as "stuck". */}
        {lane.status === 'waiting' && lane.parkedUntil && (
          <p className="text-2xs text-waiting">
            Parked until {new Date(lane.parkedUntil).toLocaleString()}
            {lane.parkReason ? ` — ${lane.parkReason}` : ''}
            {lane.watch?.length ? ` · watching ${lane.watch.join(', ')}` : ''}
          </p>
        )}
        {lane.status === 'queued' && (
          <p className="text-2xs text-ink-muted">
            {lane.lockWaitSince
              ? `Queued behind another owner's claim since ${relativeTime(Date.parse(lane.lockWaitSince))}.`
              : 'Queued for a scope something else is holding.'}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" asChild>
            <a href={planHref(lane.slug, 'run')}>Watch</a>
          </Button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
          >
            <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
            {open ? 'Hide the tail' : 'Tail & steer'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule">
          {tail?.length ? (
            <ol
              data-testid="lane-tail"
              className="max-h-40 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-2xs leading-relaxed text-ink-muted"
            >
              {tail.map((line) => (
                <li key={line.id} className="truncate">
                  {line.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-3 py-2 text-2xs text-ink-faint">
              Nothing has come through since this page opened. The run page replays what came before.
            </p>
          )}
          {/* Ask and Steer are the same two verbs the run page offers, from the
              same component — the console has ONE way to speak to a session. */}
          <AskBox slug={lane.slug} enabled={running} allowRun={allowRun} phase={lane.phase} />
        </div>
      )}
    </li>
  );
}
