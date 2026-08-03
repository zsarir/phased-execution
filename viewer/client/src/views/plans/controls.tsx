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
import { SORTS, type Filters, type GroupBy, type SortId } from './model';

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
  /** How many rows the filters are currently hiding — never a silent cut. */
  hidden: number;
}

const fieldClass =
  'h-9 min-w-0 rounded border border-rule bg-surface px-2 text-sm text-ink '
  + 'hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)';

export function activeFilterCount(filters: Filters): number {
  return Number(filters.showDocuments) + Number(!filters.showComplete)
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
  filters, onFilters, group, onGroup, repos, statuses, stacked,
}: Pick<ControlsProps, 'filters' | 'onFilters' | 'group' | 'onGroup' | 'repos' | 'statuses'>
  & { stacked: boolean }) {
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={filters.showDocuments ? 'action' : 'default'}
          aria-pressed={filters.showDocuments}
          onClick={() => onFilters({ showDocuments: !filters.showDocuments })}
          title="Documents and orphan handoff sets are not plans — they have no phases to run."
        >
          Documents
        </Button>
        {/* "Hide finished" rather than "Finished", so that pressed means the
            same thing on both buttons: *you have changed the default view*.
            Spelled the other way it is amber on load — and amber is the one
            colour this system rations, so a page that opens with it lit has
            spent it saying nothing. */}
        <Button
          size="sm"
          variant={!filters.showComplete ? 'action' : 'default'}
          aria-pressed={!filters.showComplete}
          onClick={() => onFilters({ showComplete: !filters.showComplete })}
        >
          Hide finished
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
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
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
          {props.hidden > 0 && <> · {props.hidden} hidden</>}
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
        {props.hidden > 0 && <> · {props.hidden} hidden by filters</>}
      </p>
    </div>
  );
}
