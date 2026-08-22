/**
 * The dashboard — the state of the board right now.
 *
 * ## What this page is, and what it deliberately is not
 *
 * There are three overview surfaces and they answer three different questions.
 * Statistics answers **over time**: velocity, size mix, which repos, which
 * skills. Ready now answers **next**: which phase to boot and with what prompt.
 * This one answers **now**: is anything running, is anything waiting on me, how
 * far along is everything, and is the console itself healthy.
 *
 * Keeping that line is the whole design. The old dashboard was four counters
 * and a list of plan names, which is a worse plans page; the temptation on
 * rebuilding it is to make it a worse statistics page instead. Every card below
 * earns its place by being about the present tense.
 *
 * ## Order
 *
 * Top to bottom is urgency, not category. Anything blocked on a person comes
 * before anything merely true. A run in flight comes before the shape of the
 * portfolio. The console's own health is last, because a console you are
 * looking at is usually fine — but when it is not, nothing above it is
 * trustworthy and there is nowhere else that says so.
 */

import { useMemo } from 'react';
import { ArrowRight, GitBranch, HardDrive, Radio, ShieldCheck, TerminalSquare } from 'lucide-react';
import {
  useApprovals,
  useAuth,
  useConsoleState,
  usePlanDetails,
  usePlans,
  useRuns,
  useSessions,
  useStats,
} from '@/lib/queries';
import { plural, weight } from '@/lib/format';
import { Banner, Card, CardBody, CardHeader, CardTitle, Chip, Skeleton, Tile } from '@/components/ui';
import { Bars, StackBar } from '@/components/charts';
import { LaunchDialog } from '@/features/run-setup/launch-dialog';
import { plainText } from '@/components/markdown';
import { isClosed } from '@/lib/closure';
import { phaseHref, planHref } from '@shared/routes.js';
import type { PlanSummaryFull } from '@/lib/api';
import { Page } from '../_page';
import { AllQuiet, AttentionRow, LiveStrip, demands } from './now';
import { useDemandActions } from './actions';
import { NewPlanCard } from './new-plan-card';
import { PlanStrips } from './plan-strips';
import { SessionsCard } from './sessions';

/** How many plans get a strip. Each one costs an engine read. */
const STRIP_LIMIT = 6;

export default function DashboardView() {
  const { data: state } = useConsoleState();
  const { data: plans, isPending, error } = usePlans();

  // The same stale-server guard the runs view uses: `/api/state` has to have
  // answered before the run endpoints are asked for, or a console whose server
  // predates the autopilot fills the browser log with 404s.
  const stale = state != null && state.autopilot === false;
  const runsEnabled = state != null && !stale;
  const { data: runs } = useRuns(runsEnabled);
  const { data: approvals } = useApprovals(runsEnabled);
  const { data: stats } = useStats();

  // Memoised: a fresh `[]` per render would re-run every memo below on every render.
  const summaries = useMemo(() => (plans ?? []) as unknown as PlanSummaryFull[], [plans]);

  // "Unfinished" is not the same question as "still being worked on". `done <
  // phases` is true of every abandoned plan ever written, and this list drives
  // both the "In flight" hint and the six route strips — so without the closure
  // gate the dashboard opens on a wall of plans nobody is coming back to.
  const active = useMemo(
    () =>
      summaries
        .filter((p) => p.kind === 'plan' && !isClosed(p) && (p.done ?? 0) < (p.phases ?? 0))
        .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0)),
    [summaries],
  );
  const stripPlans = active.slice(0, STRIP_LIMIT);
  const stripSlugs = useMemo(() => stripPlans.map((p) => p.slug), [stripPlans]);
  const { bySlug, loading: stripsLoading } = usePlanDetails(stripSlugs, stripSlugs.length > 0);

  // Every count below reads only the open plans — the same split the server
  // makes in `portfolio()`. `stale-lock` is one of the progress issue kinds
  // closure silences server-side, so a lapsed claim on an abandoned plan must
  // not come back as a "Waiting on you" card by another route.
  const open = useMemo(() => summaries.filter((p) => !isClosed(p)), [summaries]);

  const expiredLocks = useMemo(
    () =>
      open.flatMap((p) =>
        (p.locks ?? [])
          .filter((l) => l.expired && l.phase != null)
          .map((l) => ({ slug: p.slug, phase: l.phase! })),
      ),
    [open],
  );

  // A LIVE claim is the exception, and stays counted across every plan: it means
  // a session is holding that phase *right now*. A stale `status:` line must not
  // make a running session invisible — the same argument P2 used to keep
  // `approval`/`needs-you`/`halted` notifications firing on a closed plan.
  const claimed = summaries.reduce((n, p) => n + (p.locks ?? []).filter((l) => !l.expired).length, 0);
  const readyCount = open.reduce((n, p) => n + (p.ready?.length ?? 0), 0);
  const inFlight = open.reduce((n, p) => n + (p.inProgress?.length ?? 0), 0);
  // The issues themselves, not a count of them: the plan-error card names the
  // real ones now instead of rendering one hard-coded sentence for all of them.
  const { data: auth } = useAuth(runsEnabled);
  const { data: terminals } = useSessions(state);
  const pending = (approvals ?? []).filter((a) => a.status === 'pending').length;
  const attention = demands({
    approvals: pending,
    runs: runs ?? [],
    allowRun: Boolean(state?.allowRun),
    allowAgent: Boolean(state?.allowAgent),
    signedOut: auth?.loggedIn === false,
    // So a card whose recovery is already running says so instead of offering
    // to start a second one. Same query the sessions card below reads.
    sessions: terminals?.sessions,
  });
  const { onAction, busy, launch, clearLaunch } = useDemandActions(runs ?? []);

  // The board's own recommendation, in one line — the same rule the ready view
  // leads with, so the two pages cannot suggest different things.
  const next = useMemo(() => {
    let best: { slug: string; phase: number; unblocks: number } | undefined;
    // `open`, not `summaries`: this line becomes "Start phase N" with a button
    // beside it, so recommending a closed plan's phase is the same defect as the
    // ready board offering one — and the two pages have to agree.
    for (const plan of open) {
      for (const phase of plan.ready ?? []) {
        if ((plan.locks ?? []).some((l) => l.phase === phase && !l.expired)) continue;
        const unblocks = plan.nextBest?.phase === phase ? plan.nextBest.unblocks : 0;
        if (!best || unblocks > best.unblocks) best = { slug: plan.slug, phase, unblocks };
      }
    }
    return best;
  }, [open]);

  if (error) {
    return (
      <Page title="Now">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  const root = state?.root;
  const totals = stats?.totals;

  return (
    <Page
      title="Now"
      // `root.planCount` counts every document in `docs/plans`, which is not the
      // number the rail shows; a header that disagrees with the nav beside it
      // reads as a bug in both.
      subtitle={
        root?.label
          ? `${root.label} · ${plural(summaries.filter((p) => p.kind === 'plan').length, 'plan')}` +
            `${state?.repo?.branch ? ` · ${state.repo.branch}` : ''}`
          : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {attention.length > 0 && (
          <section aria-label="Waiting on you">
            <h2 className="mb-2 text-2xs font-medium uppercase tracking-[0.14em] text-action">
              Waiting on you
            </h2>
            <AttentionRow items={attention} onAction={onAction} busy={busy} />
          </section>
        )}

        {launch && <LaunchDialog request={launch} onClose={clearLaunch} />}

        <section aria-label="Running now" className="flex flex-col gap-4">
          {isPending ? (
            <Skeleton className="h-16" />
          ) : (runs ?? []).some((r) =>
              ['running', 'waiting', 'pausing', 'stopping', 'frozen', 'halting'].includes(r.status),
            ) ? (
            <LiveStrip runs={runs ?? []} />
          ) : (
            <AllQuiet
              next={nextWithTitle(next, bySlug)}
              allowRun={Boolean(state?.allowRun)}
              allowAgent={state?.allowAgent === true}
            />
          )}
          {/* Directly under the run, because it answers the same question: an
              agent session left working overnight is as much "what is running
              now" as an autopilot phase, and nothing else on the console lists
              one. Renders nothing when there are no sessions at all. */}
          <SessionsCard state={state} />
        </section>

        {/* ---- the counters ---- */}
        <section aria-label="Totals">
          {isPending ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile
                label="Ready now"
                value={readyCount}
                state={readyCount > 0 ? 'state-ready' : undefined}
                hint={
                  <a href="#/ready" className="hover:text-action">
                    open the board
                  </a>
                }
              />
              <Tile
                label="In flight"
                value={inFlight}
                state={inFlight > 0 ? 'state-in-progress' : undefined}
                hint={`${plural(active.length, 'plan')} unfinished`}
              />
              {/* Painted only when something *is* held. A red 0 says "something
                  is wrong with this number", which is the opposite of true. */}
              <Tile
                label="Claimed"
                value={claimed}
                hint={
                  expiredLocks.length
                    ? `${plural(expiredLocks.length, 'lease')} expired`
                    : 'phases a session is holding'
                }
                state={claimed > 0 ? 'state-in-progress' : undefined}
              />
              <Tile
                label="Work left"
                value={totals ? weight(totals.remainingWeight) : '—'}
                hint={totals ? `≈ ${plural(totals.remainingSessions, 'session')}` : 'reading plans'}
              />
            </div>
          )}
        </section>

        {/* ---- the portfolio, in one bar ---- */}
        {totals && (
          <Card>
            <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
              <CardTitle>All {totals.phases} phases</CardTitle>
              <span className="text-2xs text-ink-faint">{totals.percent}% of everything is done</span>
            </CardHeader>
            <CardBody>
              <StackBar
                segments={[
                  { label: 'done', value: totals.done, tone: 'done' },
                  { label: 'running', value: totals.inProgress, tone: 'running' },
                  { label: 'next up', value: totals.ready, tone: 'queued' },
                  { label: 'needs you', value: totals.stuck, tone: 'needs-you' },
                  { label: 'waiting', value: totals.waiting, tone: 'waiting' },
                ]}
              />
            </CardBody>
          </Card>
        )}

        {/* ---- the shape of the work ---- */}
        <PlanStrips plans={stripPlans} details={bySlug} loading={stripsLoading || isPending} />

        <div className="grid gap-4 lg:grid-cols-2">
          {stats && (
            <Card>
              <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
                <CardTitle>Recent weeks</CardTitle>
                <a
                  href="#/stats"
                  className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint hover:text-action"
                >
                  all statistics <ArrowRight size={11} aria-hidden />
                </a>
              </CardHeader>
              <CardBody className="flex flex-col gap-2">
                <Bars data={stats.velocity.slice(-14)} label="phases" />
                <p className="text-2xs text-ink-faint">
                  phases completed per week
                  {stats.medianCycleDays != null && (
                    <>
                      {' '}
                      · median gap {stats.medianCycleDays === 0 ? 'same day' : `${stats.medianCycleDays}d`}
                    </>
                  )}
                </p>
                <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-rule pt-2">
                  {velocityFacts(stats.velocity).map((fact) => (
                    <div key={fact.label}>
                      <dt className="text-2xs uppercase tracking-wide text-ink-faint">{fact.label}</dt>
                      <dd className="font-mono text-md tabular-nums text-ink">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          )}

          {/* Beside the console's own card, because both answer "what can this
              machine do for me" rather than "what is this plan doing". */}
          <NewPlanCard allowAgent={state?.allowAgent === true} />

          <ConsoleCard state={state} stale={stale} stalled={stats?.stalled ?? []} />
        </div>
      </div>
    </Page>
  );
}

/**
 * Three readings a bar chart cannot give you.
 *
 * A sparkline says "roughly this shape"; it cannot say whether this week is
 * ahead of the last one, and that comparison is the only reason to look at
 * velocity on a dashboard rather than on the statistics page.
 */
function velocityFacts(velocity: { week: string; count: number }[]) {
  const recent = velocity.slice(-14);
  const total = recent.reduce((n, w) => n + w.count, 0);
  const best = recent.reduce((max, w) => Math.max(max, w.count), 0);
  const current = recent.at(-1)?.count ?? 0;
  return [
    { label: 'This week', value: current },
    { label: 'Best week', value: best },
    { label: '14 weeks', value: total },
  ];
}

/** The recommendation, with its real title once that plan's detail has landed. */
function nextWithTitle(
  next: { slug: string; phase: number } | undefined,
  details: Map<string, { phases?: { phase: number; title?: string }[] }>,
) {
  if (!next) return undefined;
  const title = details.get(next.slug)?.phases?.find((p) => p.phase === next.phase)?.title;
  return { ...next, title: title ? plainText(title) : undefined };
}

/* ------------------------------------------------------------------ *
 * The console itself
 * ------------------------------------------------------------------ */

/**
 * What this console can do, and what is wrong with it.
 *
 * Capabilities are on the dashboard rather than only in Settings because they
 * change what every other page *means*: a read-only console shows a write menu
 * that would 403, and a console without `--allow-run` shows a Start button that
 * cannot start anything. Seeing "writes on, runs on, terminal off" at a glance
 * is what stops that being a surprise three clicks later.
 */
function ConsoleCard({
  state,
  stale,
  stalled,
}: {
  state: ReturnType<typeof useConsoleState>['data'];
  stale: boolean;
  stalled: { slug: string; days: number; ready: number[] }[];
}) {
  const repo = state?.repo;
  const caps = [
    {
      id: 'writes',
      label: 'Writes',
      on: Boolean(state?.allowWrites),
      icon: <ShieldCheck size={12} aria-hidden />,
    },
    { id: 'run', label: 'Autopilot', on: Boolean(state?.allowRun), icon: <Radio size={12} aria-hidden /> },
    {
      id: 'terminal',
      label: 'Terminal',
      on: Boolean(state?.allowTerminal),
      icon: <TerminalSquare size={12} aria-hidden />,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitle>This console</CardTitle>
        <a
          href="#/settings"
          className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint hover:text-action"
        >
          settings <ArrowRight size={11} aria-hidden />
        </a>
      </CardHeader>
      <CardBody className="flex flex-col gap-2.5">
        {state?.serverStale && (
          <Banner severity="warn">
            The server on disk is newer than the one answering this page. Restart it from Settings to pick the
            change up.
          </Banner>
        )}
        {stale && (
          <Banner severity="warn">
            This server predates the autopilot, so the run and approval endpoints are missing.
          </Banner>
        )}
        {/* The environment doctor: PATH rot and broken push delivery, with the
            errand named. The live plist carried a different user's home and six
            dead directories for weeks with no surface at all. */}
        {(state?.environment?.issues ?? []).map((issue, index) => (
          <Banner key={`${issue.kind}-${index}`} severity="warn">
            <div className="min-w-0">
              <strong>{issue.detail}</strong> <span className="text-ink-muted">{issue.fix}</span>
            </div>
          </Banner>
        ))}

        <div className="flex flex-wrap gap-1.5">
          {caps.map((cap) => (
            // One text node, not `{label} {on ? …}` — a chip split around its
            // icon reads as two fragments to a screen reader and to a test.
            <Chip key={cap.id} tone={cap.on ? 'ok' : 'neutral'} className="gap-1">
              {cap.icon}
              {`${cap.label} ${cap.on ? 'on' : 'off'}`}
            </Chip>
          ))}
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
          <dt className="flex items-center gap-1 text-ink-faint">
            <HardDrive size={11} aria-hidden /> Source
          </dt>
          <dd className="truncate font-mono text-ink-muted" title={state?.root?.path}>
            {state?.root?.path ?? '—'}
          </dd>
          {repo?.available && (
            <>
              <dt className="flex items-center gap-1 text-ink-faint">
                <GitBranch size={11} aria-hidden /> Branch
              </dt>
              <dd className="flex flex-wrap items-center gap-1.5 font-mono text-ink-muted">
                {repo.branch}
                {repo.ahead ? (
                  <Chip mono tone="warn">
                    {repo.ahead} ahead
                  </Chip>
                ) : null}
                {repo.behind ? (
                  <Chip mono tone="warn">
                    {repo.behind} behind
                  </Chip>
                ) : null}
                {repo.dirty?.length ? (
                  <Chip mono tone="warn">
                    {plural(repo.dirty.length, 'file')} changed
                  </Chip>
                ) : null}
              </dd>
            </>
          )}
          {state?.supervisor?.detail && (
            <>
              <dt className="text-ink-faint">Supervisor</dt>
              <dd className="truncate text-ink-muted" title={state.supervisor.detail}>
                {state.supervisor.detail}
              </dd>
            </>
          )}
        </dl>

        {stalled.length > 0 && (
          <div>
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
              Ready work nobody has touched
            </p>
            <ul className="flex flex-col gap-0.5">
              {stalled.slice(0, 4).map((item) => (
                <li key={item.slug} className="flex flex-wrap items-baseline justify-between gap-2">
                  <a
                    href={item.ready.length ? phaseHref(item.slug, item.ready[0]) : planHref(item.slug)}
                    className="min-w-0 truncate font-mono text-2xs text-ink hover:text-action"
                  >
                    {item.slug}
                  </a>
                  <span className="shrink-0 text-2xs text-ink-faint">
                    P{item.ready.join(', P')} · idle {plural(item.days, 'day')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
