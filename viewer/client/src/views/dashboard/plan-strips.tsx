/**
 * Every open plan as one line of track.
 *
 * ## Why this and not another chart
 *
 * The statistics page already counts things: how many phases are done, how many
 * this week, which repos. What no page showed is the *shape* of the portfolio —
 * that one plan is a solid run of green with an amber notch near the end and
 * another is half grey because it is waiting on a dependency it will not get
 * this month. That is what an operator actually navigates by, and it is a
 * picture rather than a number.
 *
 * Each row is one plan: title, a `RouteStrip` of its phases in plan order
 * painted by state, and the ready phases as their own tap targets. The strip
 * itself links to the route map, where the full graph and the 44px targets are.
 *
 * ## Why only the first few
 *
 * A strip needs per-phase state, which lives in the plan detail — one engine
 * read per plan. Sixty-five of those to fill a screen nobody scrolls is a bad
 * trade, so the section takes the most recently active plans and says so. The
 * reads are shared with the plan view's cache, so opening one of these is then
 * instant.
 */

import { ArrowRight } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle, Chip, Skeleton } from '@/components/ui';
import { RouteStrip } from '@/components/charts';
import { plainText } from '@/components/markdown';
import { etaLabel, etaTitle, relativeTime } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import type { PlanDetail, PlanSummaryFull } from '@/lib/api';

export function PlanStrips({
  plans,
  details,
  loading,
}: {
  plans: PlanSummaryFull[];
  details: Map<string, PlanDetail>;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitle>Plans in flight</CardTitle>
        <a
          href="#/plans"
          className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint hover:text-action"
        >
          every plan <ArrowRight size={11} aria-hidden />
        </a>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {plans.length === 0 && (
          <p className="text-sm text-ink-faint">
            {loading ? 'Reading the plans…' : 'No plan has unfinished phases.'}
          </p>
        )}

        {plans.map((plan) => {
          const detail = details.get(plan.slug);
          const nodes = detail?.route?.nodes ?? [];
          const ready = plan.ready ?? [];

          return (
            <div key={plan.slug} className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <a
                  href={planHref(plan.slug)}
                  className="min-w-0 flex-1 truncate text-md hover:text-action"
                  title={plainText(plan.title || plan.slug)}
                >
                  {plainText(plan.title || plan.slug)}
                </a>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
                  {plan.done}/{plan.phases} · {plan.percent}%
                  {plan.eta && (
                    <span title={etaTitle(plan.eta)}>
                      {' · '}
                      {etaLabel(plan.eta.lowMs, plan.eta.highMs, plan.eta.basis)}
                    </span>
                  )}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                {nodes.length > 0 ? (
                  <a href={planHref(plan.slug)} className="min-w-0 flex-1" title="Open the route map">
                    <RouteStrip phases={[...nodes].sort((a, b) => a.phase - b.phase)} />
                  </a>
                ) : (
                  <Skeleton className="h-3 flex-1" />
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {ready.length > 0 ? (
                  ready.map((phase) => (
                    <a key={phase} href={phaseHref(plan.slug, phase)} className="rounded-sm">
                      <Chip tone="state" dot mono className="state-ready hover:bg-action/12">
                        P{phase} ready
                      </Chip>
                    </a>
                  ))
                ) : (
                  <span className="text-2xs text-ink-faint">
                    {plan.inProgress?.length
                      ? `phase ${plan.inProgress.join(', ')} in progress`
                      : 'nothing ready — every remaining phase is waiting on another'}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-2xs text-ink-faint">
                  {relativeTime(plan.activity)}
                </span>
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
