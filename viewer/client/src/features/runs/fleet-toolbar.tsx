/**
 * How the fleet is filtered, and what it is not showing you.
 *
 * The mechanism is `components/toolbar.tsx`, shared with the Plans list; what
 * is left here is the vocabulary of a RUN — outcomes, plans, whether the table
 * groups.
 *
 * The outcome chips stay visible in both shapes — unlike the plans page, where
 * the filters hide behind a button on a phone. They carry their own counts, so
 * the row is simultaneously the filter and the only summary of the fleet's
 * shape: five numbers that say two hundred finished, one halted, nothing
 * running. Folding that into a sheet would hide the answer inside the control.
 */

import { Button } from '@/components/ui';
import { Toolbar, ToolbarSorts, fieldClass, type ToolbarShape } from '@/components/toolbar';
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

function GroupAndPlan({
  grouped,
  onGrouped,
  filters,
  onFilters,
  plans,
  shape,
}: Pick<ControlsProps, 'grouped' | 'onGrouped' | 'filters' | 'onFilters' | 'plans'> & {
  shape: ToolbarShape;
}) {
  const stacked = shape === 'sheet';
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <Button
        size="sm"
        variant={grouped ? 'action' : 'default'}
        aria-pressed={grouped}
        onClick={() => onGrouped(!grouped)}
        className={stacked ? 'self-start' : undefined}
      >
        Group by plan
      </Button>
      {plans.length > 1 && (
        <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
          <span className="shrink-0 uppercase tracking-wide">Plan</span>
          <select
            className={cn(fieldClass, stacked ? 'flex-1' : 'max-w-44')}
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
  const body = (shape: ToolbarShape) =>
    shape === 'sheet' ? (
      <>
        <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="sheet" />
        <hr className="my-3 border-rule" />
        <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Show</p>
        <GroupAndPlan {...props} shape="sheet" />
      </>
    ) : (
      <>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="inline" />
        <GroupAndPlan {...props} shape="inline" />
      </>
    );

  return (
    <Toolbar
      search={{
        value: props.filters.query,
        onChange: (query) => props.onFilters({ query }),
        placeholder: 'Plan or run id',
        label: 'Find a run by plan or run id',
      }}
      chips={
        <OutcomeChips
          counts={props.counts}
          value={props.filters.outcome}
          onChange={(outcome) => props.onFilters({ outcome })}
        />
      }
      activeCount={Number(Boolean(props.filters.plan)) + Number(Boolean(props.filters.query))}
      sheetTitle="Sort and filter the fleet"
      note={props.hidden > 0 ? `${props.hidden} hidden by filters` : undefined}
    >
      {body}
    </Toolbar>
  );
}
