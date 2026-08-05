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
import {
  Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip,
} from '@/components/ui';
import { useAuth, useConsoleState, useRun, useSessions } from '@/lib/queries';
import { money } from '@/lib/format';
import { looksLikeAuthFailure } from '@/lib/failures';
import {
  classifyBoardPhase, classifyRun, liveRecovery, recoveryKey, type RecoveryClass,
} from '@/lib/recovery';
import { RUN_STATUS_TONE, runStatusTitle } from '@/lib/status-vocab';
import { RecoveryButton } from '@/views/run/status';
import { planHref } from '@shared/routes.js';
import type { PlanDetail, RunState } from '@/lib/api';

function excerpt(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One recovery offer: a class and the target its dialog opens on. */
type Offer = { kind: RecoveryClass; target: { slug: string; phase?: number; runId?: string } };

export function RouteCards({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  const { data: detailRun } = useRun(slug, state?.autopilot !== false);
  const { data: auth } = useAuth(Boolean(state?.autopilot));
  const sessions = useSessions(state);
  const run = (detailRun?.run ?? null) as RunState | null;

  const live = ['running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting']
    .includes(run?.status ?? '');
  const stuck = detail.phases.filter((p) => p.state === 'stuck');
  const lintFailed = Boolean(detail.lint && !detail.lint.ok);
  const authFailure = looksLikeAuthFailure(run, auth);
  const runClass = classifyRun(run, { authFailure });
  const troubled = Boolean(runClass) || stuck.length > 0 || lintFailed;

  // Recovery offers, deduplicated by target: every stuck phase (and the lint)
  // wants plan-repair, and one button per identical ask is noise, not help.
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const offer = (kind: RecoveryClass | undefined, target: Offer['target']) => {
    if (!kind) return;
    const key = `${kind}:${recoveryKey({ slug: target.slug, ...(target.phase != null ? { phase: target.phase } : {}) })}`;
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({ kind, target });
  };
  if (runClass && run) {
    offer(runClass, {
      slug,
      ...(run.halt?.phase != null ? { phase: run.halt.phase } : {}),
      runId: run.id,
    });
  }
  for (const phase of stuck) offer(classifyBoardPhase(phase.state), { slug, phase: phase.phase });
  if (lintFailed) offer('plan-repair', { slug });

  const tone = RUN_STATUS_TONE[(run?.status ?? '') as keyof typeof RUN_STATUS_TONE];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card className={!troubled ? 'sm:col-span-2 lg:col-span-3' : undefined}>
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
          {run
            ? <Chip tone={tone} title={runStatusTitle(run.status)}>{run.status}</Chip>
            : <Chip>not running</Chip>}
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">
            {run
              ? live
                ? <>
                    {run.activePhase != null ? `Driving phase ${run.activePhase}` : 'Between phases'}
                    {' · '}{run.model}{run.spentUsd ? <> · {money(run.spentUsd)} spent</> : null}
                  </>
                : excerpt(run.finishedReason ?? run.halt?.reason)
                  ?? 'Stopped, without a note.'
              : 'Nothing has been run for this plan yet — the run tab starts one.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" asChild>
              <a href={planHref(slug, 'run')}><Bot size={13} aria-hidden /> Open autopilot</a>
            </Button>
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
          <CardHeader><CardTitle>Something's wrong</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-2">
            {runClass && run && (
              <Banner severity="error">
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
          <CardHeader><CardTitle>Recovery</CardTitle></CardHeader>
          <CardBody className="flex flex-wrap items-start gap-1.5">
            {offers.map(({ kind, target }) => {
              const running = liveRecovery(sessions.data?.sessions, {
                slug: target.slug,
                ...(target.phase != null ? { phase: target.phase } : {}),
              });
              return (
                <RecoveryButton
                  key={`${kind}:${target.phase ?? 'plan'}`}
                  kind={kind}
                  allowAgent={Boolean(state?.allowAgent)}
                  {...(running ? { runningSessionId: running.id } : {})}
                  target={target}
                />
              );
            })}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
