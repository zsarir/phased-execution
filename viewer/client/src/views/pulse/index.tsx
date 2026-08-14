/**
 * `#/pulse` — every plan's heartbeat on one page.
 *
 * The same panel the plan page shows, once per plan, live-first: what is
 * being worked on this second across the whole console, what is queued, what
 * is parked, and what just finished. The Runs page is the ledger (every run,
 * sortable, forever); this is the *now* — you glance at it from a phone to
 * answer "is anything moving, and is anything stuck waiting for me".
 *
 * Data is the runs list the fleet already keeps fresh over SSE — no new
 * endpoint, no polling of its own.
 */

import { Activity } from 'lucide-react';
import { Empty } from '@/components/ui';
import { PlanPulse, isLiveRun, pulseLanes, pulseWaits } from '@/components/pulse';
import { Page } from '../_page';
import { useConsoleState, useRuns } from '@/lib/queries';
import { isResolved } from '@/views/runs/model';
import type { RunState } from '@/lib/api';
import type { ViewProps } from '@/router';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The one run per plan this page talks about — the newest that still matters. */
export function pulseRuns(runs: readonly RunState[]): RunState[] {
  const newestPerPlan = new Map<string, RunState>();
  for (const run of runs) {
    const seen = newestPerPlan.get(run.slug);
    if (!seen || Date.parse(run.updatedAt) > Date.parse(seen.updatedAt)) {
      newestPerPlan.set(run.slug, run);
    }
  }
  const rank = (run: RunState): number => {
    if (isLiveRun(run)) return 0;
    if (!isResolved(run) && ['halted', 'interrupted', 'parked'].includes(run.status)) return 1;
    return 2;
  };
  return [...newestPerPlan.values()]
    .filter((run) => rank(run) < 2 || Date.now() - Date.parse(run.updatedAt) < DAY_MS)
    .sort((a, b) => rank(a) - rank(b)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export default function PulseView(_props: ViewProps) {
  const { data: state } = useConsoleState();
  const { data: runs } = useRuns(state?.autopilot !== false);
  const rows = pulseRuns(runs ?? []);

  const lanes = rows.reduce((n, run) => n + pulseLanes(run).length, 0);
  const waits = rows.reduce((n, run) => n + pulseWaits(run).length, 0);

  return (
    <Page
      title="Pulse"
      subtitle={lanes || waits
        ? [
          lanes ? `${lanes} ${lanes === 1 ? 'phase' : 'phases'} being worked on right now` : null,
          waits ? `${waits} waiting` : null,
        ].filter(Boolean).join(' · ')
        : 'What every plan is doing right now'}
    >
      <div className="flex w-full max-w-3xl flex-col gap-4">
        {rows.length === 0
          ? (
            <Empty
              icon={<Activity size={28} aria-hidden />}
              title="Nothing is moving"
              body="No plan has a live, queued or recently finished run. Start one from a plan's Autopilot tab and its lanes appear here."
            />
          )
          : rows.map((run) => <PlanPulse key={run.slug} slug={run.slug} run={run} linkHeader />)}
      </div>
    </Page>
  );
}
