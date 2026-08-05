/**
 * How the estate is ordered, and what it leaves out.
 *
 * One component, two shapes — the same split `views/ready/controls.tsx` makes,
 * for the same reason: on a wide screen seeing "Closest to done" beside "Needs
 * attention" is what tells you the other orders exist, and on a phone a hundred
 * and forty pixels of toggles has pushed the thing they control off the screen.
 *
 * The search box is the exception and stays visible in both. With sixty-five
 * plans it is the control most reached for, and burying the fastest way to find
 * one behind a button that says "Sort & filter" would be filing it under the
 * wrong verb.
 */

import { LayoutGrid, Search, SlidersHorizontal, Table2, X } from 'lucide-react';
import { Button, ButtonGroup, Chip, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import {
  CLOSED_ONLY, OPEN_ONLY, SORTS,
  type Filters, type GroupBy, type HiddenBreakdown, type SortId,
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

const fieldClass =
  'h-9 min-w-0 rounded border border-rule bg-surface px-2 text-sm text-ink '
  + 'hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)';

/**
 * How many filters are away from their default.
 *
 * `showClosed` counts when it is **on**, the opposite way round from the
 * `showComplete` it replaces, because the default moved: hiding closed plans is
 * now the resting state, and showing them is the deliberate act.
 */
/** `Show closed` → `Show closed — 71 more`, and plain again when there is nothing to add. */
function countedLabel(label: string, count: number): string {
  return count > 0 ? `${label} — ${count} more` : label;
}

export function activeFilterCount(filters: Filters): number {
  return Number(filters.showDocuments) + Number(filters.showClosed)
    + Number(Boolean(filters.repo)) + Number(Boolean(filters.status));
}

/* ------------------------------------------------------------------ *
 * The search box
 * ------------------------------------------------------------------ */

function SearchBox({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('relative flex min-w-0 items-center', className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-faint" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Find a plan"
        aria-label="Find a plan by name or slug"
        // `pr-8` leaves the clear button its own room; without it the text runs
        // under a control that then cannot be pressed.
        className={cn(fieldClass, 'w-full pl-8 pr-8 [&::-webkit-search-cancel-button]:appearance-none')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear the search"
          className="absolute right-1 grid size-7 place-items-center rounded text-ink-faint hover:text-ink"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The pieces, shared by both shapes
 * ------------------------------------------------------------------ */

function SortRow({ sortId, onSort, wrap }: { sortId: SortId; onSort: (id: SortId) => void; wrap: boolean }) {
  // A joined segmented control cannot wrap without its borders coming apart, so
  // the phone sheet uses separate pressable buttons of the same vocabulary.
  if (wrap) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={sortId === s.id ? 'action' : 'default'}
            aria-pressed={sortId === s.id}
            onClick={() => onSort(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <ButtonGroup>
      {SORTS.map((s) => (
        <Button
          key={s.id}
          size="sm"
          aria-pressed={sortId === s.id}
          onClick={() => onSort(s.id)}
          title={s.blurb}
        >
          {s.label}
        </Button>
      ))}
    </ButtonGroup>
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
  filters, onFilters, group, onGroup, repos, statuses, hiddenBy, stacked,
}: Pick<ControlsProps, 'filters' | 'onFilters' | 'group' | 'onGroup' | 'repos' | 'statuses' | 'hiddenBy'>
  & { stacked: boolean }) {
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
            <span aria-hidden className="font-mono tabular-nums text-ink-faint">+{hiddenBy.documents}</span>
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
            <span aria-hidden className="font-mono tabular-nums text-ink-faint">+{hiddenBy.closed}</span>
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
              {repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
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
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
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

/* ------------------------------------------------------------------ *
 * The two shapes
 * ------------------------------------------------------------------ */

export function Controls(props: ControlsProps) {
  const phone = usePhone();
  const sort = SORTS.find((s) => s.id === props.sortId) ?? SORTS[0];
  const active = activeFilterCount(props.filters);

  if (phone) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SearchBox
            value={props.filters.query}
            onChange={(query) => props.onFilters({ query })}
            className="flex-1"
          />
          <Sheet>
            <SheetTrigger asChild>
              <Button size="sm" className="shrink-0">
                <SlidersHorizontal size={14} aria-hidden />
                Sort
                {active > 0 && <Chip tone="warn">{active}</Chip>}
              </Button>
            </SheetTrigger>
            <SheetContent title="Sort and filter the plans">
              <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
              <SortRow sortId={props.sortId} onSort={props.onSort} wrap />
              <p className="mt-2 text-sm text-ink-muted">{sort.blurb}</p>
              <hr className="my-3 border-rule" />
              <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Show</p>
              <FilterFields {...props} stacked />
              <hr className="my-3 border-rule" />
              <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">As</p>
              <LayoutToggle layout={props.layout} onLayout={props.onLayout} />
            </SheetContent>
          </Sheet>
        </div>
        <p className="min-w-0 text-2xs text-ink-faint">
          <span className="text-ink-muted">{sort.label}</span> — {sort.hint}
          {props.hiddenBy.total > 0 && <> · <HiddenNote hiddenBy={props.hiddenBy} onShowEverything={props.onShowEverything} /></>}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SearchBox
          value={props.filters.query}
          onChange={(query) => props.onFilters({ query })}
          className="w-52"
        />
        <SortRow sortId={props.sortId} onSort={props.onSort} wrap={false} />
        <FilterFields {...props} stacked={false} />
        <div className="ml-auto">
          <LayoutToggle layout={props.layout} onLayout={props.onLayout} />
        </div>
      </div>
      <p className="text-2xs text-ink-faint">
        {sort.blurb}
        {props.hiddenBy.total > 0 && <> · <HiddenNote hiddenBy={props.hiddenBy} onShowEverything={props.onShowEverything} /></>}
      </p>
    </div>
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
  if (hiddenBy.documents) parts.push(`${hiddenBy.documents} ${hiddenBy.documents === 1 ? 'document' : 'documents'}`);
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
