/**
 * Plans — the whole estate, in the order you are asking about.
 *
 * ## What the page is for
 *
 * The console has four list surfaces and they answer four different questions.
 * `#/ready` answers *what next* — one phase, promoted, with its boot prompt.
 * `#/dashboard` answers *what now* — whatever is blocked on a person this
 * minute. `#/stats` answers *over time*. This one answers **where does
 * everything stand**: every plan side by side, comparable, findable, and sorted
 * by whichever of five questions you actually have.
 *
 * The dashboard shows six plans as route strips and links here; that is a teaser
 * of the same vocabulary, not a smaller copy of this page. Six needs a per-plan
 * engine read and sixty-five does not.
 *
 * ## What is on screen and why
 *
 * - **A track per plan.** The signature, and the reason the page is worth
 *   scrolling: a plan's shape reads before its name does. See `row.tsx`.
 * - **Documents are hidden by default.** This source holds sixty-five plans and
 *   fifteen documents, and a document has no phases to run. `prefs` has said so
 *   since the first phase; until now nothing read it.
 * - **The filters say what they are hiding.** A count of dropped rows, always.
 *   A filter that silently cuts is indistinguishable from missing data.
 * - **Broken plans are named once, at the top.** A plan the engine cannot read
 *   is not a row-level detail; it means every number below it is a guess.
 */

import { useMemo, useState } from 'react';
import { FileText, Filter } from 'lucide-react';
import { useConsoleState, usePlans, useRuns } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { plural } from '@/lib/format';
import {
  Banner, Button, Card, Empty, Skeleton, StatusStack, type StatusNote,
} from '@/components/ui';
import { NewPlanButton } from '@/components/write-menu';
// The AI wizard, NOT gated on allowWrites: the claude session writes the plan,
// not the console — `allowAgent` is its capability. It never imports the pane,
// so mounting it here costs the plans chunk no xterm.
import { NewPlanWizardButton } from '../agent/wizard';
import { planHref } from '@shared/routes.js';
import type { PlanSummaryFull } from '@/lib/api';
import { Page } from '../_page';
import { Controls } from './controls';
import { PlanCard, PlanTable } from './row';
import {
  NO_FILTERS, applyFilters, groupRows, hiddenBreakdown, isSortId, repoOptions, rowTotals,
  sortRows, statusOptions, toRows, type Filters, type GroupBy, type PlanRow, type SortId,
} from './model';

export default function PlansView() {
  const { data: plans, isPending, error } = usePlans();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  // A repo or status filter is per-visit, like the search: it hides rows, and a
  // hidden row that survives a reload is how a plan goes missing for a week.
  // `showDocuments` and `showClosed` persist because they are shape, not
  // search — and because their toggles are on screen the whole time.
  const [local, setLocal] = useState({ query: '', repo: '', status: '' });

  // The same gate the runs page uses: a console whose server predates the
  // autopilot has no `/api/runs`, and `enabled` waits for `/api/state` to
  // *answer* rather than assuming — gating on `!stale` alone fires the request
  // once before learning the endpoint is not there.
  const runsEnabled = state != null && state.autopilot !== false;
  const { data: runs } = useRuns(runsEnabled);

  const summaries = (plans ?? []) as unknown as PlanSummaryFull[];
  const all = useMemo(() => toRows(summaries, runs ?? []), [summaries, runs]);

  const filters: Filters = useMemo(
    () => ({ ...local, showDocuments: prefs.showDocuments, showClosed: prefs.showClosed }),
    [local, prefs.showDocuments, prefs.showClosed],
  );

  const sortId: SortId = isSortId(prefs.sort) ? prefs.sort : 'activity';
  const layout = prefs.plansLayout === 'table' ? 'table' : 'board';
  const group = (prefs.plansGroup ?? 'none') as GroupBy;

  const visible = useMemo(
    () => sortRows(applyFilters(all, filters), sortId),
    [all, filters, sortId],
  );
  const groups = useMemo(() => groupRows(visible, group), [visible, group]);
  const totals = rowTotals(visible);
  const repos = useMemo(() => repoOptions(all), [all]);
  const statuses = useMemo(() => statusOptions(all), [all]);
  const hiddenBy = useMemo(() => hiddenBreakdown(all, filters), [all, filters]);

  const onFilters = (patch: Partial<Filters>) => {
    const { showDocuments, showClosed, ...rest } = patch;
    if (showDocuments !== undefined) setPrefs({ showDocuments });
    if (showClosed !== undefined) setPrefs({ showClosed });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  const clearFilters = () => {
    setLocal({ query: '', repo: '', status: '' });
    setPrefs({ showDocuments: NO_FILTERS.showDocuments, showClosed: NO_FILTERS.showClosed });
  };

  // Deliberately NOT `clearFilters`. Clearing restores the DEFAULTS, and both
  // defaults hide — so on this estate "Clear the filters" makes the list
  // smaller, which is the opposite of what someone pressing it wants. Widening
  // is its own verb, and it leaves the search fields alone: whatever you typed
  // is not what you are trying to undo.
  const showEverything = () => setPrefs({ showDocuments: true, showClosed: true });

  const newPlan = (
    <div className="flex items-center gap-2">
      <NewPlanWizardButton allowAgent={state?.allowAgent === true} />
      <NewPlanButton allowWrites={Boolean(state?.allowWrites)} />
    </div>
  );

  if (error) {
    return (
      <Page title="Plans">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  if (isPending) {
    return (
      <Page title="Plans" subtitle="Reading the source">
        <Skeleton className="h-20" />
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </Page>
    );
  }

  if (!all.length) {
    return (
      <Page title="Plans" actions={newPlan}>
        <Empty
          icon={<FileText size={22} />}
          title="No plans here"
          body="This source has no docs/plans/*.md yet. A plan is a markdown file with a phase table; the skill can scaffold one for you."
          action={newPlan}
        />
      </Page>
    );
  }

  const controls = (
    <Controls
      sortId={sortId}
      onSort={(id) => setPrefs({ sort: id })}
      filters={filters}
      onFilters={onFilters}
      layout={layout}
      onLayout={(value) => setPrefs({ plansLayout: value })}
      group={group}
      onGroup={(value) => setPrefs({ plansGroup: value })}
      repos={repos}
      statuses={statuses}
      hiddenBy={hiddenBy}
      onShowEverything={showEverything}
    />
  );

  if (!visible.length) {
    // Clearing the filters restores the DEFAULTS, and hiding closed plans is now
    // one of them — so on a source where every plan is closed, "Clear the
    // filters" would leave the page exactly as empty as it found it. Name the
    // real cause and offer the control that actually fixes it.
    const allClosed = all.every((row) => row.isClosed);
    return (
      <Page title="Plans" subtitle={`${plural(all.length, 'plan')} in this source`} actions={newPlan}>
        <Card className="mb-3 p-3">{controls}</Card>
        <Empty
          icon={<Filter size={22} />}
          title={allClosed ? 'Every plan here is closed' : 'Every plan is filtered out'}
          body={allClosed
            ? `All ${plural(all.length, 'plan')} in this source are complete, abandoned or superseded, so the list leaves them out. Nothing is wrong — there is just no open work.`
            : `${plural(all.length, 'plan')} are in this source. Widen the filters to see them.`}
          action={allClosed
            ? <Button onClick={() => onFilters({ showClosed: true })}>Show the closed plans</Button>
            : <Button onClick={clearFilters}>Clear the filters</Button>}
        />
      </Page>
    );
  }

  return (
    <Page title="Plans" subtitle={subtitle(totals, all.length, hiddenBy)} actions={newPlan}>
      <Card className="mb-3 p-3">{controls}</Card>

      <HiddenBand hiddenBy={hiddenBy} shown={visible.length} onShowEverything={showEverything} />
      <AttentionBand rows={visible} />

      {groups.map((section) => (
        <section key={section.key} className={group === 'none' ? undefined : 'mb-5'}>
          {group !== 'none' && (
            <h2 className="mb-2 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
              {section.label}
              <span className="font-mono tabular-nums">{section.rows.length}</span>
            </h2>
          )}
          {layout === 'table'
            ? <PlanTable rows={section.rows} sortId={sortId} onSort={(id) => setPrefs({ sort: id })} />
            : (
              <div className="grid gap-2 lg:grid-cols-2">
                {section.rows.map((row, i) => <PlanCard key={row.slug} row={row} index={i} />)}
              </div>
            )}
        </section>
      ))}
    </Page>
  );
}

/**
 * What is on screen, counted the way the list beside it counts.
 *
 * The plan count says `4 of 87` whenever the filters are dropping anything.
 * Bare, it read `4 plans` on a source holding eighty-seven of them — a true
 * sentence about the list and a false one about the source, and the page's own
 * heading is the last place that should need a caveat.
 */
function subtitle(
  totals: ReturnType<typeof rowTotals>,
  total: number,
  hiddenBy: ReturnType<typeof hiddenBreakdown>,
): string {
  const shown = totals.plans + totals.documents;
  const parts = [hiddenBy.total > 0 ? `${shown} of ${plural(total, 'row')}` : plural(totals.plans, 'plan')];
  if (hiddenBy.total === 0 && totals.documents) parts.push(plural(totals.documents, 'document'));
  // Only worth saying when they are on screen — with the filter at its default
  // the count is always zero, and a permanent "0 closed" is noise.
  if (totals.closed) parts.push(`${totals.closed} closed`);
  if (totals.ready) parts.push(`${totals.ready} ready`);
  if (totals.sessions) parts.push(`${plural(totals.sessions, 'session')} of work left`);
  if (totals.running) parts.push(`${totals.running} running`);
  return parts.join(' · ');
}

/**
 * Say what the list is leaving out, when leaving it out is most of the estate.
 *
 * The `#/ready` page has said this for phases since the closure work landed —
 * *"N phases in closed plans are not counted — reopen a plan to put its work
 * back on the board"* — and this page, which is the one whose whole job is
 * "where does everything stand", said nothing but a grey count. On the source
 * this was written against that meant showing 1 row of 87 with no explanation
 * a person would find, which reads as data loss.
 *
 * Deliberately NOT a change to the default. Hiding closed plans is the
 * operator's own decision and the list should still open on the work; what was
 * wrong was doing it quietly. The threshold is proportional rather than a count:
 * hiding 71 of 72 needs saying, hiding 3 of 90 does not.
 */
function HiddenBand({
  hiddenBy,
  shown,
  onShowEverything,
}: {
  hiddenBy: ReturnType<typeof hiddenBreakdown>;
  shown: number;
  onShowEverything: () => void;
}) {
  const byShape = hiddenBy.closed + hiddenBy.documents;
  if (!byShape) return null;
  // Most of the source is missing, and the operator did not do it this session.
  if (byShape <= shown * 2) return null;

  const parts: string[] = [];
  if (hiddenBy.closed) parts.push(`${plural(hiddenBy.closed, 'closed plan')}`);
  if (hiddenBy.documents) parts.push(`${plural(hiddenBy.documents, 'document')}`);

  return (
    <Banner severity="info" className="mb-3">
      <span>
        {parts.join(' and ')} {byShape === 1 ? 'is' : 'are'} not listed. Closed plans report no
        work, so this page leaves them out until you ask — nothing is missing from the source.
      </span>
      <Button size="sm" className="ml-2 shrink-0" onClick={onShowEverything}>Show everything</Button>
    </Banner>
  );
}

/**
 * Plans the engine could not read, named once.
 *
 * These are not a row-level detail. A plan whose phase table failed to parse
 * reports zero ready phases and zero remaining sessions — numbers that look like
 * "finished" and mean "unknown". Saying so at the top is the difference between
 * a quiet list and a lie.
 *
 * Closed plans are left out even when they carry an `engineError`. This band is
 * an error-severity call to action, and the server demotes a closed plan's
 * structural issues to `info` for exactly this reason — the plan still shows the
 * damage on its own row and its own page, it just stops interrupting.
 */
function AttentionBand({ rows }: { rows: PlanRow[] }) {
  const broken = rows.filter((row) => row.errors > 0 && !row.isClosed);
  if (!broken.length) return null;

  const notes: StatusNote[] = broken.map((row) => ({
    id: row.slug,
    severity: 'error',
    title: <a href={planHref(row.slug)} className="font-medium hover:text-action">{row.title}</a>,
    body: row.firstIssue ?? plural(row.errors, 'error'),
  }));

  return <StatusStack notes={notes} max={3} className="mb-3" />;
}
