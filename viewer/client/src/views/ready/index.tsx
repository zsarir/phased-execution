/**
 * Ready now — the departures board.
 *
 * Every phase in the source that could be started this minute, ordered by a
 * rule you choose, with the boot prompt for any of them one click away.
 *
 * ## Why it looks like a board
 *
 * The design system has committed to a transit reading since the first phase:
 * plans are lines, phases are stations, `STATE_BOARD` spells the states
 * Departed / Boarding / On track / Held, and `pad2` exists because "a phase
 * number as a departures board writes it" is `07`. Nothing had ever actually
 * built the board. This is it — and the metaphor earns its place by doing work
 * the previous list could not: a departures board's whole job is ranking things
 * that are all equally *possible* by which one you should take.
 *
 * ## What is on screen and why
 *
 * - **One recommendation, promoted.** Thirteen equal rows is not advice. The
 *   top of the current ranking gets the space to say why it is the top, and
 *   carries the action the page exists for.
 * - **Leverage before size.** The default order is by how many phases each one
 *   frees, because the cost of picking wrong is not a slow session, it is a
 *   week of the board staying narrow.
 * - **A claim is a blocker.** A phase another session holds sinks to the bottom
 *   of every order and never appears as the recommendation. The old view did
 *   not show locks at all, so the board's most dangerous row looked like its
 *   best one.
 * - **Load, not weight.** `40K` means nothing on its own; `40 % of a session`
 *   is the same fact expressed as the decision it feeds.
 */

import { useMemo, useState } from 'react';
import { CircleCheck, Filter } from 'lucide-react';
import { useConsoleState, usePlanDetails, usePlans } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { plural } from '@/lib/format';
import { Banner, Button, Card, Empty, Skeleton } from '@/components/ui';
import { plainText } from '@/components/markdown';
import { RouteStrip } from '@/components/charts';
import { isClosed } from '@/lib/closure';
import { planHref } from '@shared/routes.js';
import type { PlanSummaryFull } from '@/lib/api';
import { Page } from '../_page';
import { Controls } from './controls';
import { DepartureRow, NextDeparture } from './departure';
import {
  NO_FILTERS, applyFilters, queueTotals, rank, repoOptions, toDepartures,
  type Departure, type Filters, type RankId,
} from './model';

export default function ReadyView() {
  const { data: plans, isPending, error } = usePlans();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const summaries = (plans ?? []) as unknown as PlanSummaryFull[];

  // Only plans that actually have something ready are worth an engine run — and
  // a closed plan's ready phases are never going to board, so fetching its
  // detail is a per-plan `phase-graph.sh` run spent on a row that gets dropped.
  const slugs = useMemo(
    () => summaries.filter((p) => !isClosed(p) && (p.ready?.length ?? 0) > 0).map((p) => p.slug),
    [summaries],
  );
  const { bySlug } = usePlanDetails(slugs, slugs.length > 0);

  const all = useMemo(() => toDepartures(summaries, bySlug), [summaries, bySlug]);
  const rankId = (prefs.readyRank ?? 'leverage') as RankId;
  const visible = useMemo(() => rank(applyFilters(all, filters), rankId), [all, filters, rankId]);

  const totals = queueTotals(visible, summaries);
  const repos = useMemo(() => repoOptions(all), [all]);
  const planOptions = useMemo(() => {
    const seen = new Map<string, string>();
    // Plan titles are markdown on disk; a `<select>` renders text, not markup.
    for (const d of all) if (!seen.has(d.slug)) seen.set(d.slug, plainText(d.planTitle));
    return [...seen].map(([slug, title]) => ({ slug, title }));
  }, [all]);

  if (error) {
    return (
      <Page title="Ready now">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  if (isPending) {
    return (
      <Page title="Ready now" subtitle="Reading the board">
        <Skeleton className="h-44" />
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </Page>
    );
  }

  if (!all.length) {
    // How many phases closure took off the board. Without this the empty state
    // claims every phase is "done, running or waiting" while an abandoned plan
    // sits there with five ready ones — true only if you already knew the rule.
    const withheld = summaries
      .filter((p) => isClosed(p))
      .reduce((n, p) => n + (p.ready?.length ?? 0), 0);
    return (
      <Page title="Ready now">
        <Empty
          icon={<CircleCheck size={22} />}
          title="Nothing is ready"
          body={'Every phase is done, already running, or waiting on a dependency that has not landed. Finish something in flight and the board refills itself.'
            + (withheld
              ? ` ${plural(withheld, 'phase')} in closed plans are not counted — reopen a plan to put its work back on the board.`
              : '')}
          action={<Button asChild><a href="#/plans">Open the plans</a></Button>}
        />
      </Page>
    );
  }

  const controls = (
    <Controls
      rankId={rankId}
      onRank={(id) => setPrefs({ readyRank: id })}
      filters={filters}
      onFilters={(patch) => setFilters((f) => ({ ...f, ...patch }))}
      grouped={Boolean(prefs.readyGroup)}
      onGrouped={(value) => setPrefs({ readyGroup: value })}
      repos={repos}
      plans={planOptions}
      hidden={all.length - visible.length}
    />
  );

  if (!visible.length) {
    return (
      <Page title="Ready now" subtitle={subtitle(all.length, summaries)}>
        <Card className="mb-3 p-3">{controls}</Card>
        <Empty
          icon={<Filter size={22} />}
          title="Every ready phase is filtered out"
          body={`${plural(all.length, 'phase')} could start. Widen the filters to see them.`}
          action={<Button onClick={() => setFilters(NO_FILTERS)}>Clear the filters</Button>}
        />
      </Page>
    );
  }

  const [top, ...rest] = visible;
  const grouped = Boolean(prefs.readyGroup);

  return (
    <Page
      title="Ready now"
      subtitle={`${plural(totals.phases, 'phase')} can start now, across ${plural(totals.plans, 'plan')}`
        + (totals.claimed ? ` · ${totals.claimed} already claimed` : '')
        + (totals.gated ? ` · ${totals.gated} behind a gate` : '')}
    >
      <Card className="mb-3 p-3">{controls}</Card>

      {grouped
        ? <Grouped departures={visible} summaries={summaries} details={bySlug} />
        : (
          <>
            <NextDeparture d={top} allowRun={Boolean(state?.allowRun)} />
            {rest.length > 0 && (
              <>
                <h2 className="mt-5 mb-2 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                  Also boarding · {rest.length}
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {rest.map((d, i) => <DepartureRow key={d.key} d={d} index={i} />)}
                </ul>
              </>
            )}
          </>
        )}
    </Page>
  );
}

function subtitle(count: number, summaries: PlanSummaryFull[]): string {
  const slugs = new Set(
    summaries.filter((p) => !isClosed(p) && (p.ready?.length ?? 0) > 0).map((p) => p.slug),
  );
  return `${plural(count, 'phase')} across ${plural(slugs.size, 'plan')}`;
}

/* ------------------------------------------------------------------ *
 * Grouped by plan
 *
 * The flat board answers "what next"; grouped answers "where is my work". The
 * plan heading carries the strip, so a group is legible as a position in a plan
 * rather than a bag of phases that happen to share a slug.
 * ------------------------------------------------------------------ */

function Grouped({
  departures,
  summaries,
  details,
}: {
  departures: Departure[];
  summaries: PlanSummaryFull[];
  details: Map<string, { route?: { nodes?: { phase: number; state: string; title?: string }[] } }>;
}) {
  const groups = new Map<string, Departure[]>();
  for (const d of departures) {
    const list = groups.get(d.slug);
    if (list) list.push(d);
    else groups.set(d.slug, [d]);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([slug, list]) => {
        const summary = summaries.find((p) => p.slug === slug);
        const nodes = details.get(slug)?.route?.nodes ?? [];
        return (
          <section key={slug}>
            <div className="mb-2 min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <a href={planHref(slug)} className="min-w-0 truncate font-display text-lg hover:text-action">
                  {plainText(list[0].planTitle)}
                </a>
                {summary && (
                  <span className="shrink-0 font-mono text-2xs text-ink-faint">
                    {summary.done}/{summary.phases} done · {summary.percent}%
                  </span>
                )}
              </div>
              {/* The slug, always. Two plans can share a title prefix —
                  `liquid-glass-website` and `liquid-glass-design-system` do —
                  and a heading that truncates before they diverge is two
                  identical headings. */}
              <a
                href={planHref(slug)}
                className="block truncate font-mono text-2xs text-ink-faint hover:text-action"
              >
                {slug}
              </a>
            </div>
            {nodes.length > 0 && (
              <a href={planHref(slug)} className="mb-2 block" title="Open the route map">
                <RouteStrip phases={[...nodes].sort((a, b) => a.phase - b.phase)} />
              </a>
            )}
            <ul className="flex flex-col gap-1.5">
              {list.map((d, i) => <DepartureRow key={d.key} d={d} index={i} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
