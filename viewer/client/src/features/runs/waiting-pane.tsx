/**
 * The second queue: phases whose turn has not come yet.
 *
 * The tab strip shows running and admission-queued lanes, so a plan whose next
 * phases were dependency-waiting looked like it would end after the current
 * ones — the queue named everything the run would do next except everything it
 * would do after that, and an operator watching phases 7 and 9 run reasonably
 * concluded 10 and 11 would never start. One aggregate tab (a wide plan would
 * drown the strip with a tab per phase), a card per waiting phase, each naming
 * exactly what it waits on and the fact that it starts by itself.
 *
 * Derived entirely from the plan detail already on the page — the board is the
 * engine's answer, and a second request for the same facts would eventually
 * disagree with it.
 */

import { Card, CardBody, CardHeader, CardTitle, Chip } from '@/components/ui';
import { elapsed } from '@/lib/format';
import type { PlanDetail, PhaseView } from '@/lib/api';

export interface WaitingRow {
  phase: number;
  title: string;
  /** The handoff reports blocked — a person, not a dependency, is the wait. */
  stuck: boolean;
  gated: boolean;
  gates?: string | undefined;
  /** Each unmet dependency with its own board state (or QA verdict). */
  deps: { phase: number; state: string }[];
  estMs?: number | undefined;
}

/** A dependency is unmet while not done — or done but held by the QA gate. */
function depState(view: PhaseView | undefined): string | null {
  if (!view) return 'unknown';
  if (view.state !== 'done') return view.state;
  const qa = view.qa?.result;
  if (qa && qa !== 'pass' && qa !== 'waived') return `QA ${qa}`;
  return null;
}

/**
 * The waiting/stuck phases of a plan, with what each one is waiting on.
 *
 * `except` is the set of phases that already have a lane tab: the plan detail
 * and the run are separate snapshots, and a phase the scheduler queued after
 * the board read would otherwise show in both places at once.
 */
export function waitingOf(detail: PlanDetail, except: ReadonlySet<number> = new Set()): WaitingRow[] {
  const byPhase = new Map<number, PhaseView>(detail.phases.map((p) => [p.phase, p]));
  const eta = detail.eta?.perPhase ?? [];
  return detail.phases
    .filter((p) => (p.state === 'waiting' || p.state === 'stuck') && !except.has(p.phase))
    .map((p) => {
      const deps = (p.analysis?.dependsOn ?? [])
        .map((dep) => ({ phase: dep, state: depState(byPhase.get(dep)) }))
        .filter((dep): dep is { phase: number; state: string } => dep.state != null);
      const est = eta.find((e) => e.phase === p.phase)?.estMs;
      return {
        phase: p.phase,
        title: p.title,
        stuck: p.state === 'stuck',
        gated: p.gated,
        gates: p.gates,
        deps,
        ...(est != null ? { estMs: est } : {}),
      };
    });
}

export function WaitingPane({ rows }: { rows: readonly WaitingRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-2xs text-ink-faint">
        The autopilot keeps going until the whole graph is done — these phases have not been skipped, their
        dependencies just are not finished yet.
      </p>
      {rows.map((row) => (
        <Card key={row.phase}>
          <CardHeader className="flex-wrap items-center">
            <CardTitle>
              Phase {row.phase}
              <span className="ml-2 font-normal text-ink-muted">{row.title}</span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={row.stuck ? 'bad' : 'neutral'}>{row.stuck ? 'stuck' : 'waiting'}</Chip>
              {row.estMs != null && (
                <span className="font-mono text-2xs text-ink-faint tabular-nums">~{elapsed(row.estMs)}</span>
              )}
            </div>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {row.deps.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-ink-faint">Waiting on</span>
                {row.deps.map((dep) => (
                  <Chip key={dep.phase} mono>
                    P{dep.phase} · {dep.state}
                  </Chip>
                ))}
              </div>
            )}
            {row.gated && (
              <p className="text-2xs text-ink-faint">
                Gated
                {row.gates ? (
                  <>
                    : <code className="font-mono">{row.gates}</code>
                  </>
                ) : null}{' '}
                — the gate is checked again right before it would start.
              </p>
            )}
            <p className="text-2xs text-ink-faint">
              {row.stuck
                ? 'Its handoff reports blocked — this one needs a person before it can move.'
                : 'Starts by itself the moment these finish — the autopilot is not stuck.'}
            </p>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
