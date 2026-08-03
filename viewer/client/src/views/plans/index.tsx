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
import { planHref } from '@shared/routes.js';
import type { PlanSummaryFull } from '@/lib/api';
import { Page } from '../_page';
import { Controls } from './controls';
import { PlanCard, PlanTable } from './row';
import {
  NO_FILTERS, applyFilters, groupRows, isSortId, repoOptions, rowTotals, sortRows,
  statusOptions, toRows, type Filters, type GroupBy, type PlanRow, type SortId,
} from './model';

export default function PlansView() {
  const { data: plans, isPending, error } = usePlans();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  // A repo or status filter is per-visit, like the search: it hides rows, and a
  // hidden row that survives a reload is how a plan goes missing for a week.
  // `showDocuments` and `showComplete` persist because they are shape, not
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
    () => ({ ...local, showDocuments: prefs.showDocuments, showComplete: prefs.showComplete }),
    [local, prefs.showDocuments, prefs.showComplete],
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

  const onFilters = (patch: Partial<Filters>) => {
    const { showDocuments, showComplete, ...rest } = patch;
    if (showDocuments !== undefined) setPrefs({ showDocuments });
    if (showComplete !== undefined) setPrefs({ showComplete });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  const clearFilters = () => {
    setLocal({ query: '', repo: '', status: '' });
    setPrefs({ showDocuments: NO_FILTERS.showDocuments, showComplete: NO_FILTERS.showComplete });
  };

  const newPlan = <NewPlanButton allowWrites={Boolean(state?.allowWrites)} />;

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
      hidden={all.length - visible.length}
    />
  );

  if (!visible.length) {
    return (
      <Page title="Plans" subtitle={`${plural(all.length, 'plan')} in this source`} actions={newPlan}>
        <Card className="mb-3 p-3">{controls}</Card>
        <Empty
          icon={<Filter size={22} />}
          title="Every plan is filtered out"
          body={`${plural(all.length, 'plan')} are in this source. Widen the filters to see them.`}
          action={<Button onClick={clearFilters}>Clear the filters</Button>}
        />
      </Page>
    );
  }

  return (
    <Page title="Plans" subtitle={subtitle(totals)} actions={newPlan}>
      <Card className="mb-3 p-3">{controls}</Card>

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

/** What is on screen, counted the way the list beside it counts. */
function subtitle(totals: ReturnType<typeof rowTotals>): string {
  const parts = [plural(totals.plans, 'plan')];
  if (totals.documents) parts.push(plural(totals.documents, 'document'));
  if (totals.ready) parts.push(`${totals.ready} ready`);
  if (totals.sessions) parts.push(`${plural(totals.sessions, 'session')} of work left`);
  if (totals.running) parts.push(`${totals.running} running`);
  return parts.join(' · ');
}

/**
 * Plans the engine could not read, named once.
 *
 * These are not a row-level detail. A plan whose phase table failed to parse
 * reports zero ready phases and zero remaining sessions — numbers that look like
 * "finished" and mean "unknown". Saying so at the top is the difference between
 * a quiet list and a lie.
 */
function AttentionBand({ rows }: { rows: PlanRow[] }) {
  const broken = rows.filter((row) => row.errors > 0);
  if (!broken.length) return null;

  const notes: StatusNote[] = broken.map((row) => ({
    id: row.slug,
    severity: 'error',
    title: <a href={planHref(row.slug)} className="font-medium hover:text-action">{row.title}</a>,
    body: row.firstIssue ?? plural(row.errors, 'error'),
  }));

  return <StatusStack notes={notes} max={3} className="mb-3" />;
}
