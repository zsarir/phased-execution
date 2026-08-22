/**
 * How the fleet is filtered, and what it is not showing you.
 *
 * The outcome chips stay visible in both shapes — unlike the plans page, where
 * the filters hide behind a button on a phone. They carry their own counts, so
 * the row is simultaneously the filter and the only summary of the fleet's
 * shape: five numbers that say two hundred finished, one halted, nothing
 * running. Folding that into a sheet would hide the answer inside the control.
 */

import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button, ButtonGroup, Chip, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import type { UiState } from '@/lib/status-vocab';
import { FLEET_STATES, SORTS, type Filters, type SortId } from './model';

export interface ControlsProps {
  sortId: SortId;
  onSort: (id: SortId) => void;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  grouped: boolean;
  onGrouped: (value: boolean) => void;
  counts: Record<UiState, number>;
  plans: { slug: string; runs: number }[];
  /** How many runs the filters are currently hiding — never a silent cut. */
  hidden: number;
}

const fieldClass =
  'h-9 min-w-0 rounded border border-rule bg-surface px-2 text-sm text-ink ' +
  'hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)';

/** A state with no runs in it is not a filter, it is a dead button. */
function OutcomeChips({
  counts,
  value,
  onChange,
}: {
  counts: Record<UiState, number>;
  value: string;
  onChange: (value: string) => void;
}) {
  const live = FLEET_STATES.filter((o) => counts[o.id] > 0);
  if (live.length < 2) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {/* Never amber, even when it is the one selected: showing everything is
          the resting state, and amber is reserved for a view you have
          narrowed. `aria-pressed` still carries the state for anyone who
          cannot see which chips are lit. */}
      <Button size="sm" aria-pressed={value === ''} onClick={() => onChange('')}>
        Everything
      </Button>
      {live.map((outcome) => (
        <Button
          key={outcome.id}
          size="sm"
          variant={value === outcome.id ? 'action' : 'default'}
          aria-pressed={value === outcome.id}
          onClick={() => onChange(value === outcome.id ? '' : outcome.id)}
          title={outcome.hint}
          // Spelled out rather than left to the text nodes: the label and the
          // count are separate elements, so the computed name would run them
          // together as "Halted1" and read as a different word.
          aria-label={`${outcome.label}, ${counts[outcome.id]} run${counts[outcome.id] === 1 ? '' : 's'}`}
        >
          {outcome.label}
          <span className="font-mono text-2xs tabular-nums opacity-70">{counts[outcome.id]}</span>
        </Button>
      ))}
    </div>
  );
}

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
        placeholder="Plan or run id"
        aria-label="Find a run by plan or run id"
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

function SortAndGroup({
  sortId,
  onSort,
  grouped,
  onGrouped,
  filters,
  onFilters,
  plans,
  wrap,
}: Pick<ControlsProps, 'sortId' | 'onSort' | 'grouped' | 'onGrouped' | 'filters' | 'onFilters' | 'plans'> & {
  wrap: boolean;
}) {
  const sortButtons = SORTS.map((s) => (
    <Button
      key={s.id}
      size="sm"
      variant={wrap && sortId === s.id ? 'action' : 'default'}
      aria-pressed={sortId === s.id}
      onClick={() => onSort(s.id)}
      title={s.hint}
    >
      {s.label}
    </Button>
  ));

  return (
    <div className={cn('flex gap-2', wrap ? 'flex-col' : 'flex-wrap items-center')}>
      {wrap ? (
        <div className="flex flex-wrap gap-1.5">{sortButtons}</div>
      ) : (
        <ButtonGroup>{sortButtons}</ButtonGroup>
      )}
      <Button
        size="sm"
        variant={grouped ? 'action' : 'default'}
        aria-pressed={grouped}
        onClick={() => onGrouped(!grouped)}
        className={wrap ? 'self-start' : undefined}
      >
        Group by plan
      </Button>
      {plans.length > 1 && (
        <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
          <span className="shrink-0 uppercase tracking-wide">Plan</span>
          <select
            className={cn(fieldClass, wrap ? 'flex-1' : 'max-w-44')}
            value={filters.plan}
            onChange={(e) => onFilters({ plan: e.target.value })}
          >
            <option value="">every plan</option>
            {plans.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug} ({p.runs})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function Controls(props: ControlsProps) {
  const phone = usePhone();
  const active = Number(Boolean(props.filters.plan)) + Number(Boolean(props.filters.query));

  return (
    <div className="flex flex-col gap-2">
      <OutcomeChips
        counts={props.counts}
        value={props.filters.outcome}
        onChange={(outcome) => props.onFilters({ outcome })}
      />

      {phone ? (
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
            <SheetContent title="Sort and filter the fleet">
              <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
              <SortAndGroup {...props} wrap />
            </SheetContent>
          </Sheet>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SearchBox
            value={props.filters.query}
            onChange={(query) => props.onFilters({ query })}
            className="w-52"
          />
          <SortAndGroup {...props} wrap={false} />
        </div>
      )}

      {props.hidden > 0 && <p className="text-2xs text-ink-faint">{props.hidden} hidden by filters</p>}
    </div>
  );
}
