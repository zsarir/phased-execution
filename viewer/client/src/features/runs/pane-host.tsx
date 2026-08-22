/**
 * What one lane renders — the three bodies a lane can have, behind one prop set.
 *
 * A lane is in exactly one of three states, and each wants a different pane:
 *
 *   - **queued** — admitted to nothing yet, waiting on a scope another plan is
 *     holding. There is no session, so there is no console; what there IS, and
 *     the only thing worth showing, is *who is holding it and what overlaps*.
 *   - **live** — a real session, so a console, a task list, a tool log, an ask
 *     box and the per-lane freeze/stop.
 *   - **waiting** — not a lane at all in the runner's sense: a phase whose
 *     dependencies are unfinished. Rendered as one aggregate pane by
 *     `waiting-pane.tsx`, never per phase, because "phase 9 is waiting on 7"
 *     nine times over is a list, not nine windows.
 *
 * ## Why this is its own module
 *
 * Phase 10's Sessions page shows the same bodies for the same lanes, reached
 * from a list rather than a tab strip. Splitting the STRIP (`lanes.tsx`) from
 * the BODY (here) is what lets both surfaces render a lane the same way — and
 * the alternative, a Sessions page that reimplements the queued pane, is how
 * two surfaces end up disagreeing about what "queued" means.
 *
 * ## Force-mounting is the caller's job, not this module's
 *
 * A pane that unmounts drops its SSE subscription, so glancing at another lane
 * would silently cost every line the first one printed while you were away —
 * and the replay endpoint cannot fill that gap, because it is fetched once and
 * those lines are newer than it. `lanes.tsx` keeps every panel mounted and
 * hides them with `hidden`; this module simply renders what it is given.
 */

import type { PhaseEta, QueueEntry, RunState } from '@/lib/api';
import { LaneControls, laneFrozen } from './lane-controls';
import { QueuedPane, SessionPanes, queueEntryFor, type Lane } from './session-panes';

export interface LanePaneProps {
  slug: string;
  run: RunState;
  lane: Lane;
  live: boolean;
  allowRun: boolean;
  /** False on a stale server — the pane renders, the stream is never opened. */
  enabled: boolean;
  /** The admission queue, for the queued rendering's "waiting on" line. */
  entries?: QueueEntry[] | undefined;
  /** Per-phase scope, so a queued pane can say what it would collide with. */
  scopes?: { phase: number; scope: string[]; conflicts: string[] }[] | undefined;
  /** The one-line vitals under the pane title. Built by the caller — see `lanes.tsx`. */
  subtitle?: string;
  phaseEta?: PhaseEta[] | undefined;
}

export function LanePane({
  slug,
  run,
  lane,
  live,
  allowRun,
  enabled,
  entries,
  scopes,
  subtitle,
}: LanePaneProps) {
  if (lane.queued) {
    return (
      <QueuedPane
        phase={lane.phase}
        entry={queueEntryFor(entries, slug, lane.phase)}
        scope={scopes?.find((s) => s.phase === lane.phase)?.scope}
        control={
          <LaneControls slug={slug} phase={lane.phase} live={live} allowRun={allowRun} frozen={null} queued />
        }
      />
    );
  }

  return (
    <SessionPanes
      slug={slug}
      runId={run.id}
      phase={lane.phase}
      live={live}
      allowRun={allowRun}
      enabled={enabled}
      {...(subtitle ? { subtitle } : {})}
      control={
        <LaneControls
          slug={slug}
          phase={lane.phase}
          // The lane's OWN status, not the run's: a run with three lanes is
          // `running` while one of them has already finished, and offering
          // Freeze on a lane with no process is a button that answers 404.
          live={live && lane.status === 'running'}
          allowRun={allowRun}
          frozen={laneFrozen(run, lane.phase)}
        />
      }
    />
  );
}

export default LanePane;
