/**
 * **Now** — the home page.
 *
 * ## One question per band, in the order it costs to ignore
 *
 * Does anything need me → is anything running and is it healthy → what is next
 * → what shape is the portfolio in. That order is the whole design: anything
 * blocked on a person comes before anything merely true, and a run in flight
 * comes before the shape of the work. On a phone the bands simply stack, which
 * is why the inbox is first — a home page whose first screenful is counters is
 * a home page that answers a question nobody was asking.
 *
 * ## What this page replaced
 *
 * Four routes: the dashboard (`#/`), the Pulse (`#/pulse`), Ready now
 * (`#/ready`) and the notifications inbox (`#/notifications`). They overlapped
 * badly enough to disagree — the dashboard's "the board's next move is…" line
 * and the Ready board's top row are one decision, and for a fortnight they
 * named different phases. Each of those addresses still resolves; three of
 * them now land here with `?focus=` set (see `app/routes.ts`).
 *
 * ## First paint reads the shell's own queries and nothing more
 *
 * `/api/state`, `/api/plans`, `/api/inbox`, `/api/runs`, `/api/spend` — the
 * first two the shell is already holding, so opening Now costs three requests.
 * The per-plan details, which are one ENGINE INVOCATION each, are fetched in a
 * second pass for the few plans that actually have something in flight or
 * something ready, and every row upgrades in place as they land. Fanning out
 * sixty-five engine reads to fill a screen nobody scrolls is the trade this
 * page exists to refuse.
 */

import { useMemo } from 'react';
import {
  useApprovals,
  useAttentionInbox,
  useAuth,
  useConsoleState,
  useConverge,
  usePlanDetails,
  usePlans,
  useRuns,
  useSessionRegistry,
  useSpend,
  useStats,
} from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { Banner } from '@/components/ui';
import { ApiError, type PlanSummaryFull } from '@/lib/api';
import { Page } from '@/views/_page';
import type { ViewProps } from '@/app/router';
import { FOCUS_KEYS, focusOf } from '@/app/routes';
import { NeedsYou } from './needs-you';
import { LiveLanes } from './live-lanes';
import { NextUp } from './next-up';
import { HeaderStrip, PlansInFlight } from './portfolio-strip';
import { needsYouCount, nowLanes, otherSessions, plansInFlight, toDepartures } from './model';

/** How many plans get a strip. Each one costs an engine read. */
const STRIP_LIMIT = 6;

export default function NowView({ route }: ViewProps) {
  const [prefs, setPrefs] = usePrefs();
  const focus = focusOf(route);

  const { data: state } = useConsoleState();
  const { data: plans, isPending, error } = usePlans();

  // The same stale-server guard every run-reading surface uses: `/api/state`
  // has to have answered before the run endpoints are asked for, or a console
  // whose server predates the autopilot fills the browser log with 404s.
  const stale = state != null && state.autopilot === false;
  const runsEnabled = state != null && !stale;

  const showAcked = Boolean(prefs.nowShowAcked);
  const inbox = useAttentionInbox(showAcked, state != null);
  const { data: runs } = useRuns(runsEnabled);
  const { data: approvals } = useApprovals(runsEnabled);
  const { data: spend } = useSpend(runsEnabled);
  const { data: converge } = useConverge(runsEnabled);
  const { data: auth } = useAuth(runsEnabled);
  const { data: registry } = useSessionRegistry();
  const { data: stats } = useStats();

  // Memoised: a fresh `[]` per render would re-run every memo below on every render.
  const summaries = useMemo(() => (plans ?? []) as unknown as PlanSummaryFull[], [plans]);

  // The SECOND pass, and the only place this page fans out: the plans with a
  // strip, plus any plan with a live run, plus any plan with ready work. One
  // engine read each, shared with the plan page's cache under the same keys.
  const stripPlans = useMemo(() => plansInFlight(summaries, STRIP_LIMIT), [summaries]);
  const detailSlugs = useMemo(() => {
    const wanted = new Set(stripPlans.map((p) => p.slug));
    for (const run of runs ?? []) wanted.add(run.slug);
    for (const plan of summaries) if ((plan.ready?.length ?? 0) > 0) wanted.add(plan.slug);
    return [...wanted];
  }, [stripPlans, runs, summaries]);
  const { bySlug, loading: detailsLoading } = usePlanDetails(detailSlugs, detailSlugs.length > 0);

  const lanes = useMemo(() => nowLanes(runs ?? [], bySlug), [runs, bySlug]);
  const departures = useMemo(() => toDepartures(summaries, bySlug), [summaries, bySlug]);
  const others = useMemo(() => otherSessions(registry?.sessions, lanes), [registry, lanes]);

  const items = inbox.data?.items;
  // A 404 is a server too old for the endpoint, and it is a different fact from
  // "nothing is waiting on you". Any other failure is a real error and says so.
  const missing = inbox.error instanceof ApiError && inbox.error.status === 404;

  if (error) {
    return (
      <Page title="Now">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  const needsYou = needsYouCount(items) || (approvals ?? []).filter((a) => a.status === 'pending').length;
  const queued = lanes.filter((lane) => lane.status === 'queued').length;
  const ready = departures.length;

  return (
    // The `h1` stays even though the strip below names the project: it is the
    // default route's only heading, and a page whose heading hierarchy starts
    // at `h2` is a page a screen reader enters in the middle of.
    <Page title="Now" className="pb-6">
      <div className="flex flex-col gap-4">
        <HeaderStrip
          {...(state?.instance?.name || state?.root?.label
            ? { project: state?.instance?.name || state?.root?.label }
            : {})}
          {...(state?.repo?.branch ? { branch: state.repo.branch } : {})}
          running={lanes.filter((lane) => lane.status === 'running').length}
          needsYou={needsYou}
          queued={queued}
          ready={ready}
          spend={spend}
          {...(stats?.totals?.percent != null ? { percent: stats.totals.percent } : {})}
        />

        {stale && (
          <Banner severity="warn">
            This server predates the autopilot, so the run, inbox and spend endpoints are missing.
          </Banner>
        )}

        <NeedsYou
          items={items}
          loading={inbox.isPending}
          unavailable={missing}
          {...(converge ? { converge } : {})}
          showAcked={showAcked}
          onShowAcked={(next) => setPrefs({ nowShowAcked: next })}
          autoFocus={focus === FOCUS_KEYS.inbox}
        />

        <LiveLanes
          lanes={lanes}
          allowRun={Boolean(state?.allowRun)}
          signedOut={auth?.loggedIn === false}
          ready={ready}
          needsYou={needsYou}
          others={others}
          focused={focus === FOCUS_KEYS.lanes}
        />

        <NextUp
          departures={departures}
          plans={summaries}
          allowRun={Boolean(state?.allowRun)}
          loading={isPending || detailsLoading}
          focused={focus === FOCUS_KEYS.next}
        />

        <PlansInFlight plans={stripPlans} details={bySlug} loading={detailsLoading || isPending} />
      </div>
    </Page>
  );
}
