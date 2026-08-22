/**
 * The lane strip: one tab per session, and one for the run itself.
 *
 * The run page had a single console because a run had a single session. It now
 * drives up to `maxParallel` phases whose scopes do not overlap, and the honest
 * rendering of that is one window each — a phase's console, task list and tool
 * log are about that phase, and merging two of them produces a page that is
 * wrong in a way nothing on it can show.
 *
 * The **Run** tab is deliberately kept and deliberately first: it is the whole
 * run's narration, unfiltered, which is what a deep link lands on and the right
 * view when the question is "what is this run doing" rather than "what is phase
 * 6 doing".
 *
 * Tab state is in the component, not the route. `#/plan/:slug/run` addresses
 * the RUN; a lane is a thing that exists for twenty minutes, and a URL that
 * outlived its tab would be a link to a pane that is not there.
 *
 * ## Phase 10 reuses `pane-host`
 *
 * What each tab actually renders — queued, live, or waiting — is
 * `pane-host.tsx`, split out because the Sessions page shows the same three
 * bodies against the same lane shape. This module is only the STRIP: which
 * tabs exist, which one is showing, and why panes are force-mounted.
 */

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import type { PhaseEta, PlanDetail, QueueEntry, RunState } from '@/lib/api';
import { useNow } from '@/lib/clock';
import { elapsed } from '@/lib/format';
import { LanePane } from './pane-host';
import { SessionPanes, laneId, lanesOf, resolveTab, type Lane } from './session-panes';
import { WaitingPane, waitingOf } from './waiting-pane';

/**
 * One tab per session, and one for the run itself.
 *
 * The page used to have a single console because a run had a single session. It
 * now drives up to `maxParallel` phases whose scopes do not overlap, and the
 * honest rendering of that is one window each: a phase's console, task list and
 * tool log are about that phase, and merging two of them produces a page that is
 * wrong in a way nothing on it can show.
 *
 * The **Run** tab is deliberately kept and deliberately first. It is the whole
 * run's narration — every lane, unfiltered — which is what this page showed
 * before, what a deep link lands on, and the right view when the question is
 * "what is this run doing" rather than "what is phase 6 doing".
 *
 * Tab state is in the page, not the route: `#/plan/:slug/run` addresses the run,
 * and a lane is a thing that exists for twenty minutes. A URL that outlived its
 * tab would be a link to a pane that is not there.
 */
export function SessionTabs({
  slug,
  run,
  live,
  allowRun,
  enabled,
  entries,
  scopes,
  phaseEta,
  detail,
}: {
  slug: string;
  run: RunState;
  live: boolean;
  allowRun: boolean;
  enabled: boolean;
  entries?: QueueEntry[] | undefined;
  scopes?: { phase: number; scope: string[]; conflicts: string[] }[] | undefined;
  phaseEta?: PhaseEta[] | undefined;
  detail: PlanDetail;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const lanes = lanesOf(run);
  // One clock for every lane subtitle — ticking only while something runs.
  const now = useNow(live && lanes.some((lane) => !lane.queued));

  // The second queue: dependency-waiting phases, one aggregate tab. Only while
  // the run is live — a finished run's leftovers belong to the phase table —
  // and never a phase that already has a lane tab (the two snapshots can skew).
  const waiting = live ? waitingOf(detail, new Set(lanes.map((lane) => lane.phase))) : [];

  // Explicit pick while it exists → the sole live lane → Run. See resolveTab.
  const value = picked === 'waiting' && waiting.length ? 'waiting' : resolveTab(picked, lanes);

  return (
    <Tabs value={value} onValueChange={setPicked}>
      <TabsList>
        <TabsTrigger value="run">
          Run
          {lanes.length > 1 && (
            <span className="ml-1.5 font-mono text-2xs text-ink-faint tabular-nums">{lanes.length}</span>
          )}
        </TabsTrigger>
        {lanes.map((lane) => (
          <TabsTrigger key={laneId(lane)} value={laneId(lane)}>
            Phase {lane.phase}
            {lane.queued && <span className="ml-1.5 text-2xs text-ink-faint">queued</span>}
          </TabsTrigger>
        ))}
        {waiting.length > 0 && (
          <TabsTrigger value="waiting">
            Waiting
            <span className="ml-1.5 font-mono text-2xs text-ink-faint tabular-nums">{waiting.length}</span>
          </TabsTrigger>
        )}
      </TabsList>

      {/* `forceMount` on every panel, with the hiding done here.
          A pane that unmounts drops its SSE subscription, so glancing at another
          lane would silently cost every line the first one printed while you
          were away — and the replay endpoint cannot fill that gap, because it is
          fetched once and those lines are newer than it. */}
      <TabsContent value="run" forceMount hidden={value !== 'run'}>
        <SessionPanes
          slug={slug}
          runId={run.id}
          live={live}
          allowRun={allowRun}
          enabled={enabled}
          runLevel
          title="Run console"
          subtitle={run.activePhase != null ? `phase ${run.activePhase} · ${run.model}` : run.status}
          askPhase={run.activePhase}
        />
      </TabsContent>

      {lanes.map((lane) => (
        <TabsContent key={laneId(lane)} value={laneId(lane)} forceMount hidden={value !== laneId(lane)}>
          <LanePane
            slug={slug}
            run={run}
            lane={lane}
            live={live}
            allowRun={allowRun}
            enabled={enabled}
            entries={entries}
            scopes={scopes}
            {...(lane.queued ? {} : { subtitle: laneSubtitle(lane, run, now, phaseEta) })}
          />
        </TabsContent>
      ))}

      {waiting.length > 0 && (
        <TabsContent value="waiting">
          <WaitingPane rows={waiting} />
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * A lane pane's one-line vitals: status · model · elapsed / ~estimate.
 *
 * The same facts the phases table shows, repeated where the operator is
 * actually looking while a session runs — the pane header — so "how long has
 * this been going and is that normal" never needs a scroll.
 */
function laneSubtitle(lane: Lane, run: RunState, now: number, phaseEta?: PhaseEta[]): string {
  const record = run.phases[String(lane.phase)];
  const started = record?.startedAt ? Date.parse(record.startedAt) : null;
  const eta = phaseEta?.find((estimate) => estimate.phase === lane.phase);
  const clock = started != null ? elapsed(Math.max(0, now - started)) : null;
  const withEta = clock && eta ? `${clock} / ~${elapsed(eta.estMs)}` : clock;
  return [lane.status, run.model, withEta].filter(Boolean).join(' · ');
}
