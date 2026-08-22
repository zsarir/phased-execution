/**
 * Is this plan healthy, and if not, what moves it?
 *
 * 3.0 folded four separate answers into one panel. They were spread across the
 * route tab's three cards (what the run is doing, what is wrong, the ways
 * forward) and the Analysis tab (the lint summary, the critical path, the
 * bottleneck), and the one an operator most needed — **what boarding will find
 * wrong before any money is spent** — was on neither, because nothing rendered
 * `/verify-preflight` at all.
 *
 * Four questions, in the order they are asked:
 *
 * 1. **Something's wrong** — a halt, stuck phases, a failing lint, in the run's
 *    own words (the header's banner stays the detailed listing).
 * 2. **Will a run board?** — the preflight, per open phase. This is the section
 *    that is new: a badge per phase saying which of its §Verification commands
 *    cannot run HERE, on this machine, with this PATH.
 * 3. **Where the work is** — the critical path, the bottleneck, and how the
 *    engine would batch what is left.
 * 4. **Ways forward** — each button opens the launch dialog, deduplicated by
 *    target so lint and a stuck phase do not mint two plan-repair buttons.
 *
 * Everything here is the existing vocabulary — `classifyRun`,
 * `classifyBoardPhase`, `RECOVERY_BLURBS`, the status tones — composed, not
 * restated.
 */

import { Bot, TriangleAlert } from 'lucide-react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  StatusBadge,
  Tile,
} from '@/components/ui';
import { useAuth, useConsoleState, useConverge, useRun, useVerifyPreflight } from '@/lib/queries';
import { money, plural, weight } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { looksLikeAuthFailure } from '@/lib/failures';
import { WAYS_FORWARD, classifyRun, recoveryKey } from '@/lib/recovery';
import { runStatusTitle, runUiState } from '@/lib/status-vocab';
import { PlanPulse } from '@/components/pulse';
import { RecoveryActions, type RecoveryCtx } from '@/components/recovery-actions';
import { phaseHref, planHref } from '@shared/routes.js';
import type { PlanDetail, PreflightWarning, RunState } from '@/lib/api';

function excerpt(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function HealthPanel({ detail }: { detail: PlanDetail }) {
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

  // Advisory, and asked for on every visit to the route tab: it is a read of
  // the plan file plus a PATH lookup per lead, and it answers the question the
  // run page could only answer AFTER the run had been created and parked.
  // A console whose server predates the endpoint simply gets nothing.
  const { data: preflight } = useVerifyPreflight(slug);

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

      <PreflightCard slug={slug} phases={preflight?.phases ?? []} />
      <WorkLeft detail={detail} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Will a run board?
 * ------------------------------------------------------------------ */

/**
 * How loudly each finding reads.
 *
 * Only `nothing-runnable` is certain: a phase with no executable §Verification
 * WILL park at boarding. The other three are predictions about this machine —
 * a lead that is not on this PATH, a check only a person can answer, commands
 * that will run at the repository root. Painting all four the same red is how a
 * panel gets ignored.
 */
const PREFLIGHT_TONE: Record<PreflightWarning['kind'], 'bad' | 'warn' | 'neutral'> = {
  'nothing-runnable': 'bad',
  'missing-lead': 'warn',
  'human-check': 'neutral',
  'cwd-unpinned': 'neutral',
};

const PREFLIGHT_LABEL: Record<PreflightWarning['kind'], string> = {
  'nothing-runnable': 'will park',
  'missing-lead': 'missing lead',
  'human-check': 'needs a person',
  'cwd-unpinned': 'no Verify in',
};

/**
 * What boarding will find, per open phase — the section that is genuinely new.
 *
 * The server has computed this since Phase 4 and written it to the journal as
 * prose, where it predicted the dominant halt class forty-four times and was
 * rendered by nothing. A run had to be created, boarded and parked before an
 * operator saw a defect that was readable off the plan file the whole time.
 *
 * Renders NOTHING when the endpoint answered with no findings *and* nothing
 * when it did not answer at all — an empty panel and a missing one look the
 * same, and both are honest: this console cannot tell you the plan is clean, it
 * can only tell you what it found.
 */
function PreflightCard({
  slug,
  phases,
}: {
  slug: string;
  phases: { phase: number; warnings: PreflightWarning[] }[];
}) {
  if (!phases.length) return null;
  const willPark = phases.filter((p) => p.warnings.some((w) => w.kind === 'nothing-runnable')).length;

  return (
    <Card className="sm:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>Before it boards</CardTitle>
        <span className="text-xs text-ink-faint">
          {willPark > 0
            ? `${plural(willPark, 'phase')} will park at boarding`
            : `${plural(phases.length, 'phase')} with something to know`}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        {phases.map(({ phase, warnings }) => (
          <div key={phase} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
            <a
              href={phaseHref(slug, phase)}
              className="shrink-0 rounded-sm border border-rule px-1.5 py-0.5 font-mono text-2xs text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              P{phase}
            </a>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {warnings.map((warning, i) => (
                <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <Chip tone={PREFLIGHT_TONE[warning.kind]}>{PREFLIGHT_LABEL[warning.kind]}</Chip>
                  {/* `break-words` is load-bearing, not tidiness. A `human-check`
                      message quotes the held-back command verbatim, and a
                      `bash -c '! grep -rnE "A|B|C" path/'` has no space in it
                      for eighty characters — so `min-w-0` alone leaves nothing
                      to wrap at, the card sets the track width, and the whole
                      PAGE scrolls sideways on a phone. Measured: 458/390 before
                      this line. */}
                  <span className="min-w-0 break-words text-ink-muted">{warning.message}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-2xs text-ink-faint">
          <TriangleAlert size={11} className="mr-1 inline align-[-1px]" aria-hidden />
          Advisory — computed with the extractor boarding uses, against THIS machine&rsquo;s PATH. A skipped
          command is recorded, never failed.
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Where the work is
 * ------------------------------------------------------------------ */

/**
 * The critical path, the bottleneck, and how the engine would batch the rest.
 *
 * These four numbers were the Analysis tab's top strip and the suggested-session
 * chips were a card of their own under the map. Neither is a subject: they are
 * the shape of what is LEFT, which is the same question the rest of this panel
 * answers, so they read here and nowhere else. (The estate-wide versions —
 * velocity, completions, spend over time — are Insights' subject; see the
 * handoff.)
 */
function WorkLeft({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const closed = isClosed(s);
  const groups = detail.batches?.groups ?? [];
  // Every one of these is optional on the wire for the same reason `detail.eta`
  // is: the server is whatever Node loaded at startup, the client is read from
  // disk per request, and upgrading the skill under a running console leaves a
  // new UI talking to an old API. A missing field must read as "not said",
  // never as a crash on a page whose whole job is to be readable.
  const criticalPath = s.criticalPath ?? [];
  const ready = s.ready ?? [];

  // A finished plan has no work left to describe, and a closed one has stopped
  // claiming it does — the engine answers `--session-plan` with "No sessions to
  // plan" for exactly that reason.
  if (closed || (!s.remainingWeight && !criticalPath.length && !groups.length)) return null;

  return (
    <Card className="sm:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>What is left</CardTitle>
        {groups.length > 0 && (
          <span className="text-xs text-ink-faint">
            batched at {weight(s.budget)} — <code className="font-mono">--session-plan</code>
          </span>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Tile
            label="Work left"
            value={weight(s.remainingWeight)}
            hint={`≈ ${plural(s.remainingSessions, 'session')} at ${weight(s.budget)}`}
          />
          <Tile
            label="Critical path"
            value={String(criticalPath.length)}
            hint={
              criticalPath.length
                ? `P${criticalPath.join(' → P')} · min ${plural(s.minimumSessions, 'session')}`
                : 'nothing left'
            }
          />
          <Tile
            label="Bottleneck"
            value={s.bottleneck ? `P${s.bottleneck.phase}` : '—'}
            hint={s.bottleneck ? `holds up ${plural(s.bottleneck.blocks, 'phase')}` : 'nothing is blocking'}
          />
          <Tile
            label="Ready now"
            value={String(ready.length)}
            state={ready.length > 0 ? 'state-ready' : undefined}
            hint={s.nextBest ? `best next: P${s.nextBest.phase} (unblocks ${s.nextBest.unblocks})` : 'none'}
          />
        </div>

        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((group) => (
              <Chip key={group.index} title={group.note ?? ''}>
                <b>S{group.index}</b>&nbsp;{group.phases.map((p) => `P${p}`).join(' + ')}
                &nbsp;<span className="text-ink-faint">{group.weight}</span>
                {group.gated ? ' · gated' : ''}
              </Chip>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
