/**
 * How the estate is ordered, and what it leaves out.
 *
 * The mechanism — the search field, the phone sheet, the active-filter count,
 * the note underneath — is `components/toolbar.tsx`, shared with the Runs
 * fleet. What is left here is the only part that is about PLANS: which orders
 * exist, which shapes are hidden, and what pressing a toggle would bring back.
 *
 * The search box stays visible in both shapes. With sixty-five plans it is the
 * control most reached for, and burying the fastest way to find one behind a
 * button that says "Sort & filter" would be filing it under the wrong verb.
 */

import { LayoutGrid, Table2 } from 'lucide-react';
import { Button, ButtonGroup } from '@/components/ui';
import { Toolbar, ToolbarSorts, countedLabel, fieldClass, type ToolbarShape } from '@/components/toolbar';
import { cn } from '@/lib/cn';
import {
  CLOSED_ONLY,
  OPEN_ONLY,
  SORTS,
  type Filters,
  type GroupBy,
  type HiddenBreakdown,
  type SortId,
} from './model';

export interface ControlsProps {
  sortId: SortId;
  onSort: (id: SortId) => void;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  layout: 'board' | 'table';
  onLayout: (value: 'board' | 'table') => void;
  group: GroupBy;
  onGroup: (value: GroupBy) => void;
  repos: string[];
  statuses: string[];
  /** What the filters are hiding, and which filter is doing it — never a silent cut. */
  hiddenBy: HiddenBreakdown;
  /** Open every shape toggle at once, without touching the search fields. */
  onShowEverything: () => void;
}

/**
 * How many filters are away from their default.
 *
 * `showClosed` counts when it is **on**, the opposite way round from the
 * `showComplete` it replaces, because the default moved: hiding closed plans is
 * now the resting state, and showing them is the deliberate act.
 */
export function activeFilterCount(filters: Filters): number {
  return (
    Number(filters.showDocuments) +
    Number(filters.showClosed) +
    Number(Boolean(filters.repo)) +
    Number(Boolean(filters.status))
  );
}

function LayoutToggle({
  layout,
  onLayout,
}: {
  layout: 'board' | 'table';
  onLayout: (value: 'board' | 'table') => void;
}) {
  return (
    <ButtonGroup>
      <Button
        size="sm"
        aria-pressed={layout === 'board'}
        aria-label="Show plans as cards"
        title="Cards — one plan at a glance"
        onClick={() => onLayout('board')}
      >
        <LayoutGrid size={14} aria-hidden />
      </Button>
      <Button
        size="sm"
        aria-pressed={layout === 'table'}
        aria-label="Show plans as a table"
        title="Table — every plan side by side"
        onClick={() => onLayout('table')}
      >
        <Table2 size={14} aria-hidden />
      </Button>
    </ButtonGroup>
  );
}

function FilterFields({
  filters,
  onFilters,
  group,
  onGroup,
  repos,
  statuses,
  hiddenBy,
  stacked,
}: Pick<ControlsProps, 'filters' | 'onFilters' | 'group' | 'onGroup' | 'repos' | 'statuses' | 'hiddenBy'> & {
  stacked: boolean;
}) {
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <div className="flex flex-wrap gap-1.5">
        {/* Each toggle carries what turning it on would BRING BACK. A button
            labelled only "Show closed" beside a list of one, on a source where
            seventy-one are closed, is asking the operator to guess whether the
            page is filtered or broken — and on this machine they guessed
            broken. The number is the whole difference. */}
        <Button
          size="sm"
          variant={filters.showDocuments ? 'action' : 'default'}
          aria-pressed={filters.showDocuments}
          // The count is in the accessible name, not just the pixels: "how many
          // come back" is the entire reason to press this, and a screen reader
          // that only hears "Documents" has been told the least useful half.
          aria-label={countedLabel('Documents', filters.showDocuments ? 0 : hiddenBy.documents)}
          onClick={() => onFilters({ showDocuments: !filters.showDocuments })}
          title="Documents and orphan handoff sets are not plans — they have no phases to run."
        >
          Documents
          {!filters.showDocuments && hiddenBy.documents > 0 && (
            <span aria-hidden className="font-mono tabular-nums text-ink-faint">
              +{hiddenBy.documents}
            </span>
          )}
        </Button>
        {/* "Show closed" rather than "Hide closed", so pressed still means the
            same thing on both buttons: *you have changed the default view*.
            The label had to turn round with the default — spelled the old way
            it would be amber on load, and amber is the one colour this system
            rations, so a page that opens with it lit has spent it saying
            nothing. "Closed" not "finished": abandoned and superseded plans are
            hidden by the same toggle and neither of them finished. */}
        <Button
          size="sm"
          variant={filters.showClosed ? 'action' : 'default'}
          aria-pressed={filters.showClosed}
          aria-label={countedLabel('Show closed', filters.showClosed ? 0 : hiddenBy.closed)}
          onClick={() => onFilters({ showClosed: !filters.showClosed })}
          title="Complete, abandoned and superseded plans. They report no work, so the list leaves them out until you ask."
        >
          Show closed
          {!filters.showClosed && hiddenBy.closed > 0 && (
            <span aria-hidden className="font-mono tabular-nums text-ink-faint">
              +{hiddenBy.closed}
            </span>
          )}
        </Button>
      </div>

      <div className={cn('flex gap-2', stacked && 'flex-col')}>
        {repos.length > 1 && (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Repo</span>
            <select
              className={cn(fieldClass, stacked ? 'flex-1' : 'max-w-40')}
              value={filters.repo}
              onChange={(e) => onFilters({ repo: e.target.value })}
            >
              <option value="">every repo</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </label>
        )}
        {statuses.length > 1 && (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Status</span>
            <select
              className={cn(fieldClass, stacked ? 'flex-1' : 'max-w-40')}
              value={filters.status}
              onChange={(e) => onFilters({ status: e.target.value })}
            >
              <option value="">every status</option>
              {/* "Closed" is three statuses, so no single option says it and
                  picking `complete` answers a third of the question. Grouped
                  apart because these two are not statuses — they are the
                  question the statuses are usually a proxy for. */}
              <optgroup label="by whether it is closed">
                <option value={OPEN_ONLY}>open only</option>
                <option value={CLOSED_ONLY}>closed only</option>
              </optgroup>
              <optgroup label="by status">
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        )}
        <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
          <span className="shrink-0 uppercase tracking-wide">Group</span>
          <select
            className={cn(fieldClass, stacked ? 'flex-1' : 'max-w-40')}
            value={group}
            onChange={(e) => onGroup(e.target.value as GroupBy)}
          >
            <option value="none">one list</option>
            <option value="status">by status</option>
            <option value="repo">by repo</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function Controls(props: ControlsProps) {
  const sort = SORTS.find((s) => s.id === props.sortId) ?? SORTS[0];

  const body = (shape: ToolbarShape) =>
    shape === 'sheet' ? (
      <>
        <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="sheet" />
        <p className="mt-2 text-sm text-ink-muted">{sort.blurb}</p>
        <hr className="my-3 border-rule" />
        <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Show</p>
        <FilterFields {...props} stacked />
      </>
    ) : (
      <>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="inline" />
        <FilterFields {...props} stacked={false} />
      </>
    );

  return (
    <Toolbar
      search={{
        value: props.filters.query,
        onChange: (query) => props.onFilters({ query }),
        placeholder: 'Find a plan',
        label: 'Find a plan by name or slug',
      }}
      activeCount={activeFilterCount(props.filters)}
      sheetTitle="Sort and filter the plans"
      trailing={<LayoutToggle layout={props.layout} onLayout={props.onLayout} />}
      note={
        <>
          {sort.blurb}
          {props.hiddenBy.total > 0 && (
            <>
              {' '}
              · <HiddenNote hiddenBy={props.hiddenBy} onShowEverything={props.onShowEverything} />
            </>
          )}
        </>
      }
    >
      {body}
    </Toolbar>
  );
}

/**
 * What is being left out, as something you can press.
 *
 * It used to be grey text reading "82 hidden by filters", which is accurate and
 * does nothing: it names a problem and leaves the operator to work out which of
 * five controls fixes it. When the hidden rows are hidden by the two STICKY
 * toggles — the ones set in a previous session, possibly by a previous
 * version's default — the fix is one press, so it should be one press.
 */
function HiddenNote({
  hiddenBy,
  onShowEverything,
}: {
  hiddenBy: HiddenBreakdown;
  onShowEverything: () => void;
}) {
  const parts: string[] = [];
  if (hiddenBy.closed) parts.push(`${hiddenBy.closed} closed`);
  if (hiddenBy.documents)
    parts.push(`${hiddenBy.documents} ${hiddenBy.documents === 1 ? 'document' : 'documents'}`);
  if (hiddenBy.search) parts.push(`${hiddenBy.search} by the search`);

  return (
    <>
      {parts.join(', ') || `${hiddenBy.total} hidden`} hidden
      {(hiddenBy.closed > 0 || hiddenBy.documents > 0) && (
        <>
          {' · '}
          <button
            type="button"
            onClick={onShowEverything}
            className="underline underline-offset-2 hover:text-action"
          >
            show everything
          </button>
        </>
      )}
    </>
  );
}
