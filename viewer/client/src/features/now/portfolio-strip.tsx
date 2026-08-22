/**
 * The header strip, and the plans in flight.
 *
 * ## The strip
 *
 * Six facts on one line: which project, how many lanes are running, how many
 * things need a person, how many are queued, what today has cost against the
 * day cap, and what proportion of the portfolio is done. It is the answer to
 * "should I be looking at this at all", and it sits above everything so that
 * answer costs no scrolling.
 *
 * **Spend today is the CAP's own arithmetic**, from `GET /api/spend` —
 * settled runs plus what the ladder spent, against `ladderPerDayUsd`. It is
 * deliberately not "the sum of what the runs on screen have spent": those are
 * different numbers (measured live on the Runs page at $3,175.78 against
 * $76.17), and only this one is what the ladder refuses against. A console
 * with no cap set shows the figure without a bar, because a meter with no
 * ceiling is a bar that means nothing.
 *
 * ## The strips
 *
 * One line of track per open, unfinished plan, most recently active first —
 * the shape of the portfolio rather than a count of it. A strip needs per-phase
 * state, which is one engine read per plan, so the section takes the few most
 * active and says so; those reads are shared with the plan page's cache, which
 * is what makes opening one of these instant.
 */

import { ArrowRight } from 'lucide-react';
import { Badge, Card, CardBody, CardHeader, CardTitle, Meter, Skeleton } from '@/components/ui';
import { RouteStrip } from '@/components/charts';
import { plainText } from '@/lib/plain-text';
import { etaLabel, etaTitle, money, plural, relativeTime } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import type { PlanDetail, PlanSummaryFull, SpendView } from '@/lib/api';

export interface PortfolioStripProps {
  /** The instance's own label, and the branch it is reading. */
  project?: string;
  branch?: string;
  running: number;
  needsYou: number;
  queued: number;
  ready: number;
  spend: SpendView | undefined;
  /** Portfolio completion, as the engine already computed it. */
  percent?: number;
}

export function HeaderStrip({
  project,
  branch,
  running,
  needsYou,
  queued,
  ready,
  spend,
  percent,
}: PortfolioStripProps) {
  const today = spend?.today;
  const spent = (today?.settledUsd ?? 0) + (today?.ladderUsd ?? 0);
  const cap = today?.capUsd ?? null;

  return (
    <section
      aria-label="Right now"
      data-testid="header-strip"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-rule bg-surface px-3 py-2"
    >
      <span className="min-w-0 flex-1 basis-full truncate sm:basis-auto">
        <span className="font-display text-lg leading-none">{project ?? 'This console'}</span>
        {branch && <span className="ml-2 font-mono text-2xs text-ink-faint">{branch}</span>}
      </span>

      <Fact label="running" value={running} tone={running > 0 ? 'live' : 'neutral'} />
      <Fact label="need you" value={needsYou} tone={needsYou > 0 ? 'accent' : 'neutral'} />
      <Fact label="queued" value={queued} tone={queued > 0 ? 'wait' : 'neutral'} />
      <Fact label="ready" value={ready} tone="neutral" />

      <span className="flex min-w-40 flex-1 items-center gap-2">
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">
          {money(spent)}
          {cap != null ? ` / ${money(cap)}` : ''}
        </span>
        {cap != null && cap > 0 ? (
          // `max` is the cap itself, not a pre-divided fraction: `Meter` clamps
          // the painted share and turns `over` on its own, so the one place
          // that knows "past the ceiling" is the primitive rather than three
          // callers with three thresholds.
          <Meter
            value={spent}
            max={cap}
            label="spent today against the day cap"
            valueText={`${money(spent)} of ${money(cap)}`}
            tone={spent > cap * 0.8 ? 'waiting' : 'running'}
            className="min-w-20 flex-1"
          />
        ) : (
          <span className="text-2xs text-ink-faint" title="No ladderPerDayUsd is set on this console.">
            spent today · no cap
          </span>
        )}
      </span>

      {percent != null && (
        <span
          className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint"
          title="Of every phase of every plan, closed ones included."
        >
          {percent}% of everything
        </span>
      )}
    </section>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'live' | 'accent' | 'wait' | 'neutral';
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <Badge tone={tone} mono>
        {value}
      </Badge>
      <span className="text-2xs text-ink-faint">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Plans in flight
 * ------------------------------------------------------------------ */

export function PlansInFlight({
  plans,
  details,
  loading,
}: {
  plans: PlanSummaryFull[];
  details: Map<string, PlanDetail>;
  loading: boolean;
}) {
  return (
    <Card data-testid="plans-in-flight">
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
                      <Badge tone="state" dot mono className="state-ready hover:bg-action/12">
                        P{phase} ready
                      </Badge>
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

        {plans.length > 0 && (
          <p className="text-2xs text-ink-faint">
            The {plural(plans.length, 'most recently active plan')} — every other open plan is on{' '}
            <a href="#/plans" className="hover:text-action">
              Plans
            </a>
            .
          </p>
        )}
      </CardBody>
    </Card>
  );
}
