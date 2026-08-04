/**
 * What the run is doing right now, above everything that explains it.
 *
 * The line this replaces said "started 20 minutes ago" and then went on saying
 * it for the next forty, because nothing in the client had an interval in it:
 * every figure moved only when the server spoke. On a phase that thinks quietly
 * for four minutes that is indistinguishable from a page that has died — the
 * single most common reason someone reloads a console that was working
 * perfectly. So there are two clocks and they tick: how long this run has been
 * going, and how long the phase running *now* has been going.
 *
 * The exception is `frozen`. The child is stopped, so counting on would claim
 * work that is not happening; the clock holds where it stood and says so.
 */

import { Chip, Tile } from '@/components/ui';
import { elapsed, money, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import type { EtaEstimate, PhaseRecord, RunState, RunStatus } from '@/lib/api';

/**
 * `pausing` reads as a state the operator asked for and is waiting on. Neutral
 * grey made an armed pause look identical to an idle run, which is half the
 * reason pressing Pause felt like nothing had happened.
 */
export const RUN_TONE: Record<RunStatus, 'ok' | 'busy' | 'bad' | 'warn' | undefined> = {
  running: 'busy',
  finished: 'ok',
  halted: 'bad',
  waiting: 'warn',
  // Not `bad`: parked is not a failure, it is a queue of questions. The run did
  // everything it could without someone.
  parked: 'warn',
  paused: undefined,
  pausing: 'warn',
  stopping: 'warn',
  interrupted: 'warn',
  frozen: 'warn',
  // Not `warn`: nothing is wrong and nobody is being asked for anything. The run
  // is in a line behind another plan's scope and will start itself.
  queued: 'busy',
};

/**
 * The phases this run holds a live session on, lowest first.
 *
 * `children` is the pool's own record and the answer whenever it is there.
 * `child` is a mirror of one lane kept for every reader written before lanes
 * existed — including a run recorded by an older console, which is why it is the
 * fallback rather than dead weight.
 */
export function livePhases(run: RunState): number[] {
  const lanes = run.children ? Object.values(run.children) : [];
  const phases = lanes.length ? lanes.map((lane) => lane.phase) : run.child ? [run.child.phase] : [];
  return [...new Set(phases)].sort((a, b) => a - b);
}

export function RunHeader({
  run,
  live,
  eta,
}: {
  run: RunState;
  live: boolean;
  eta: EtaEstimate | null;
}) {
  const ticking = live && run.status !== 'frozen';
  const now = useNow(ticking);

  const runMs = ticking
    ? now - Date.parse(run.createdAt)
    : Date.parse(run.updatedAt) - Date.parse(run.createdAt);

  const startedAt = run.child?.startedAt ? Date.parse(run.child.startedAt) : null;
  const frozenAt = run.freeze?.at ? Date.parse(run.freeze.at) : null;
  const phaseMs = startedAt == null
    ? null
    : (frozenAt ?? (ticking ? now : Date.parse(run.updatedAt))) - startedAt;

  // Which phases this run holds a session on right now. `children` is the full
  // set; `child` is the mirror of the lowest-numbered one, and the fallback for a
  // run recorded before the pool existed.
  const lanes = livePhases(run);

  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={RUN_TONE[run.status]}>{run.status}</Chip>
        {lanes.length > 1 ? (
          <>
            <span className="font-display text-sm">phases {lanes.join(', ')}</span>
            <Chip tone="busy" title="This run is driving several phases whose scopes do not overlap">
              {lanes.length} sessions
            </Chip>
          </>
        ) : (
          run.activePhase != null && (
            <span className="font-display text-sm">phase {run.activePhase}</span>
          )
        )}
        {phaseMs != null && (
          <span
            className={cn('font-mono text-sm tabular-nums', frozenAt ? 'text-ink-faint' : 'text-ink')}
            title={frozenAt
              ? 'The session is stopped where it stood, so this clock is stopped too.'
              : lanes.length > 1
                // The mirror is the lowest-numbered lane, so with several running
                // this is the oldest of them — saying "the phase" would be a
                // claim about whichever one the reader happens to be watching.
                ? `How long phase ${lanes[0]}, the earliest of ${lanes.length} running, has been going`
                : 'How long the phase running now has been going'}
          >
            {elapsed(phaseMs)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
        <span>
          run <code className="font-mono">{run.id}</code>
        </span>
        <span title={`started ${new Date(run.createdAt).toLocaleString()}`}>
          {ticking ? 'running for' : 'ran for'} {elapsed(Math.max(0, runMs))}
        </span>
        {/* Suppressed entirely until a phase of this plan has finished, and a
            range rather than a countdown even then. The thing being predicted is
            a model's throughput on work nobody has looked at yet. */}
        {eta && (
          <span
            title={`Estimated from ${eta.samples} finished phase(s) of this plan and `
              + `${Math.round(eta.remainingWeight / 1000)}K of remaining weight. `
              + 'Weight-normalised, recency-weighted, and deliberately coarse.'}
          >
            {eta.label} <em>(estimate)</em>
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * The four figures worth having above the fold.
 *
 * The usage window replaces "Updated" when the account has reported one, because
 * a window nearly spent is the fact most likely to change what you do next; with
 * no window reported there is nothing to say and the slot goes back to being a
 * freshness stamp.
 */
export function RunTiles({ run, phases }: { run: RunState; phases: PhaseRecord[] }) {
  const done = phases.filter((p) => p.status === 'done').length;
  const limits = run.limits;

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile
        label="Spent"
        value={money(run.spentUsd)}
        hint={run.runBudgetUsd ? `of $${run.runBudgetUsd}` : 'no run budget set'}
      />
      <Tile
        label="Phases done"
        value={
          <>
            {done}
            <span className="text-lg text-ink-faint"> / {phases.length || '—'}</span>
          </>
        }
      />
      <Tile
        label="Model"
        value={run.model}
        hint={`${run.effort ?? 'default'} effort · ${run.autonomy}`}
      />
      {limits?.utilization != null ? (
        <Tile
          label={`${(limits.window ?? 'usage').replace(/_/g, ' ')} window`}
          value={`${Math.round(limits.utilization * 100)}%`}
          hint={limits.resetsAt
            ? `used · resets ${new Date(limits.resetsAt * 1000).toLocaleString()}`
            : 'used'}
        />
      ) : (
        <Tile label="Updated" value={relativeTime(Date.parse(run.updatedAt))} />
      )}
    </div>
  );
}
