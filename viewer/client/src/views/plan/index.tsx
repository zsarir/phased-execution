/**
 * One plan: its route, its board, its phases, handoffs and analysis.
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 * 1. **The page does not blank while it refreshes.** `usePlan` keeps the last
 *    answer on screen (`keepPreviousData`) instead of dropping to a spinner, so
 *    another session finishing a phase — or a file saved in an editor, or the
 *    watcher warming — no longer throws away the thing you were reading and your
 *    scroll position with it. The one case that *does* fall back to a skeleton
 *    is a different plan, where holding the previous one would be a lie.
 *
 * 2. **The tab strip is a real tablist.** Radix owns roving tabindex, arrow
 *    keys, Home/End and the `aria-controls` wiring; the old client's `div
 *    role=tablist` had `aria-selected` and nothing else, so arrow keys did
 *    nothing and every tab was its own tab stop.
 */

import { Banner, Button, Empty, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { usePlan } from '@/lib/queries';
import { navigate, planHref } from '@shared/routes.js';
import { Page } from '../_page';
import { PlanHeader } from './header';
import { RouteTab } from './route-tab';
import { PhasesTab } from './phases-tab';
import { PhasePanel } from './phase-panel';
import { HandoffPanel, HandoffsTab } from './handoffs';
import { AnalysisTab } from './analysis-tab';
import { OverviewTab } from './overview-tab';
import { RawTab } from './raw-tab';
import { DETAIL_TABS, TAB_IDS, isDetailRoute, resolveTab, tabLabel } from './tabs';
import type { PlanDetail } from '@/lib/api';
import type { ViewProps } from '@/router';

function PlanSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </Page>
  );
}

/** What each tab shows. Total over `PLAN_TABS` — a client test asserts it. */
function TabBody({ tab, arg, detail }: { tab: string; arg?: string; detail: PlanDetail }) {
  const slug = detail.summary.slug;
  switch (tab) {
    case 'phase': return <PhasePanel detail={detail} phase={arg} />;
    case 'handoff': return <HandoffPanel detail={detail} phase={arg} />;
    case 'phases': return <PhasesTab detail={detail} />;
    case 'handoffs': return <HandoffsTab detail={detail} />;
    case 'analysis': return <AnalysisTab detail={detail} />;
    case 'overview': return <OverviewTab detail={detail} />;
    case 'raw': return <RawTab slug={slug} />;
    case 'run':
      // Phase 4 rebuilds the run view. Saying which phase owns it is the
      // difference between "not built yet" and "broken".
      return (
        <Empty
          title="The autopilot is rebuilt in Phase 4"
          body="Starting a run, the approval queue, the live console and the phase table all live on this tab."
        />
      );
    default: return <RouteTab detail={detail} />;
  }
}

export default function PlanView({ route }: ViewProps) {
  const [, slug, segment, arg] = route.segments;
  const tabId = resolveTab(segment);
  const detailKind = isDetailRoute(segment) ? segment : null;

  const { data, error, isPending } = usePlan(slug);

  if (error) {
    return (
      <Page title={slug ?? 'Plan'}>
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  // `keepPreviousData` will happily hand over the *previous* plan while a new
  // slug loads. Showing one plan's phases under another's name is worse than a
  // skeleton, so that one case waits.
  if (isPending || !data || (slug && data.summary.slug !== slug)) {
    return <PlanSkeleton />;
  }

  return (
    <Page>
      <PlanHeader detail={data} />

      <Tabs value={tabId} onValueChange={(id) => navigate(planHref(data.summary.slug, id))}>
        <TabsList aria-label="Plan sections">
          {TAB_IDS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {tabLabel(id)}
              {id === 'phases' && <Count n={data.phases.length} />}
              {id === 'handoffs' && <Count n={data.handoffs.length} />}
            </TabsTrigger>
          ))}
        </TabsList>

        {TAB_IDS.map((id) => (
          <TabsContent key={id} value={id} className="pt-4">
            {id === tabId && (
              <>
                {detailKind && (
                  <div className="mb-3">
                    <Button asChild variant="ghost" size="sm">
                      <a href={planHref(data.summary.slug, DETAIL_TABS[detailKind])}>
                        ← All {DETAIL_TABS[detailKind]}
                      </a>
                    </Button>
                  </div>
                )}
                <TabBody tab={detailKind ?? tabId} arg={arg} detail={data} />
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}

/** The number beside a tab's name — a count, not a badge, so it never shouts. */
function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-1.5 font-mono text-2xs text-ink-faint">{n}</span>;
}
