/**
 * The route tab's top strip: what the plan is doing, what is wrong, and the
 * way back — three minimal cards above the map.
 *
 * The map answers "what is the shape of this plan"; these answer the three
 * questions an operator actually arrives with. **Autopilot** is always there
 * (a one-line account of the run and the door to its tab). **Something's
 * wrong** exists only when something is — a halt, stuck phases, a failing
 * lint — and says it in the run's own words, briefly (the header's banner
 * stays the detailed listing). **Recovery** exists only when a class fits,
 * and each button opens the launch dialog, deduplicated by target so lint
 * and a stuck phase do not mint two plan-repair buttons.
 *
 * Everything here is the existing vocabulary — `classifyRun`,
 * `classifyBoardPhase`, `RECOVERY_BLURBS`, the status tones — composed, not
 * restated.
 */

import { Bot } from 'lucide-react';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip, StatusBadge } from '@/components/ui';
import { useAuth, useConsoleState, useConverge, useRun } from '@/lib/queries';
import { money } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { looksLikeAuthFailure } from '@/lib/failures';
import { WAYS_FORWARD, classifyRun, recoveryKey } from '@/lib/recovery';
import { runStatusTitle, runUiState } from '@/lib/status-vocab';
import { PlanPulse } from '@/components/pulse';
import { RecoveryActions, type RecoveryCtx } from '@/components/recovery-actions';
import { planHref } from '@shared/routes.js';
import type { PlanDetail, RunState } from '@/lib/api';

function excerpt(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function RouteCards({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  const { data: detailRun } = useRun(slug, state?.autopilot !== false);
  const { data: converge } = useConverge(state?.autopilot !== false);
  const { data: auth } = useAuth(Boolean(state?.autopilot));
  const run = (detailRun?.run ?? null) as RunState | null;

  const live = ['running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting'].includes(
    run?.status ?? '',
  );
  // A stuck phase is plan progress, and progress is what closure silences — the
  // server already drops `stale-handoff` for a closed plan, so leaving the
  // banner here would reintroduce the same warning from `phases[].state`.
  // The RUN cards below are deliberately NOT gated: a halted run is a process
  // that stopped and may still want a person, and a `status:` line in a
  // markdown file must not make one disappear. Same split P2 made for
  // notifications.
  const closed = isClosed(detail.summary);
  const stuck = closed ? [] : detail.phases.filter((p) => p.state === 'stuck');
  // `--lint` already answers `LINT OK (closed)` with exit 0 on a closed plan
  // (P1), so this is false for free — no second gate needed.
  const lintFailed = Boolean(detail.lint && !detail.lint.ok);
  const authFailure = looksLikeAuthFailure(run, auth);
  const runClass = classifyRun(run, { authFailure });
  // Parked counts as troubled even when no agent class fits (an MCP park has a
  // deterministic remedy, not an agent) — the card used to vanish exactly when
  // the plan was MCP-parked.
  const parkedRun = Boolean(run && run.status === 'parked' && !run.resolved);
  const troubled = Boolean(runClass) || parkedRun || stuck.length > 0 || lintFailed;

  // Ways forward, deduplicated by target: every stuck phase (and the lint)
  // wants plan-repair, and one row per identical ask is noise, not help.
  type Offer = { key: string; target: { slug: string; phase?: number; runId?: string }; ctx: RecoveryCtx };
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const offer = (key: string, target: Offer['target'], ctx: RecoveryCtx) => {
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({ key, target, ctx });
  };
  if (run && (runClass || parkedRun)) {
    const phase = run.halt?.phase;
    const record = phase != null ? run.phases?.[String(phase)] : undefined;
    offer(
      `run:${recoveryKey({ slug, ...(phase != null ? { phase } : {}) })}`,
      {
        slug,
        ...(phase != null ? { phase } : {}),
        runId: run.id,
      },
      {
        run,
        ...(record
          ? {
              record: {
                status: record.status,
                resumable: Boolean(record.sessionId ?? record.resumeSessionId),
              },
            }
          : {}),
        ...(authFailure ? { authFailure: true } : {}),
      },
    );
  }
  for (const phase of stuck) {
    offer(
      `stuck:${recoveryKey({ slug, phase: phase.phase })}`,
      { slug, phase: phase.phase },
      { boardState: 'stuck' },
    );
  }
  if (lintFailed) offer('lint', { slug }, { planIssues: true } as RecoveryCtx);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {/* The heartbeat first: while anything is live, queued or parked, the
          route tab leads with WHICH phases, in WHAT vehicle, for HOW LONG —
          the panel renders nothing when the plan is idle. */}
      {run && (
        <PlanPulse
          className="sm:col-span-2 lg:col-span-3"
          slug={slug}
          run={run}
          converge={converge?.reports.find((report) => report.slug === slug) ?? null}
          board={detail.phases.map((p) => ({
            phase: p.phase,
            title: p.title,
            state: p.state,
            ...(p.row?.dependsOn ? { dependsOn: p.row.dependsOn } : {}),
          }))}
        />
      )}
      <Card className={!troubled ? 'sm:col-span-2 lg:col-span-3' : undefined}>
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
          {run ? (
            <StatusBadge
              state={runUiState(run.status)}
              label={run.status}
              mono
              title={runStatusTitle(run.status)}
              pulse={run.status === 'running'}
            />
          ) : (
            <Chip>not running</Chip>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">
            {run ? (
              live ? (
                <>
                  {run.activePhase != null ? `Driving phase ${run.activePhase}` : 'Between phases'}
                  {' · '}
                  {run.model}
                  {run.spentUsd ? <> · {money(run.spentUsd)} spent</> : null}
                </>
              ) : (
                (excerpt(run.finishedReason ?? run.halt?.reason) ?? 'Stopped, without a note.')
              )
            ) : (
              'Nothing has been run for this plan yet — the run tab starts one.'
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" asChild>
              <a href={planHref(slug, 'run')}>
                <Bot size={13} aria-hidden /> Open autopilot
              </a>
            </Button>
            {/* The one-press plan recovery, on the plan itself: confirm against
                the board, stand down what it settled, recover or continue what
                is real. Renders only for a stopped, unresolved run. */}
            {run && !live && <RecoveryActions target={{ slug, runId: run.id }} ctx={{ run }} max={1} />}
            {run?.gitMode === 'new-branch' && (
              <Chip title="This run works on its own branch and, unless turned off, opens a PR when the plan completes.">
                work branch{run.openPr === false ? '' : ' · PR'}
              </Chip>
            )}
          </div>
        </CardBody>
      </Card>

      {troubled && (
        <Card>
          <CardHeader>
            <CardTitle>Something's wrong</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {(runClass || parkedRun) && run && (
              <Banner severity={parkedRun ? 'warn' : 'error'}>
                Run {run.status}. {excerpt(run.halt?.reason ?? run.finishedReason) ?? ''}
              </Banner>
            )}
            {stuck.length > 0 && (
              <Banner severity="warn">
                {stuck.length === 1
                  ? `Phase ${stuck[0]!.phase} is stuck — its handoff reads blocked.`
                  : `${stuck.length} phases are stuck — their handoffs read blocked.`}{' '}
                The Autopilot tab explains each one.
              </Banner>
            )}
            {lintFailed && (
              <Banner severity="warn">{detail.lint!.summary || 'The plan fails validation.'}</Banner>
            )}
          </CardBody>
        </Card>
      )}

      {troubled && offers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{WAYS_FORWARD}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {offers.map(({ key, target, ctx }) => (
              <div key={key} className="flex flex-col gap-1">
                {target.phase != null && (
                  <span className="font-mono text-2xs text-ink-faint">P{target.phase}</span>
                )}
                <RecoveryActions target={target} ctx={ctx} max={2} />
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
