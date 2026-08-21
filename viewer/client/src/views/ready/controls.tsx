/**
 * How the board is ordered, and what it leaves out.
 *
 * One component, two shapes. On a wide screen the controls are a toolbar,
 * because there is room for the whole vocabulary to be visible at once and
 * seeing "Leverage" beside "Quick wins" is what tells you the other orders
 * exist. Below the shell breakpoint they collapse into a single button that
 * opens a sheet — a phone that spends 140px on four rows of toggles has pushed
 * the thing they control off the screen.
 *
 * The rank blurb is not help text. Five orders that all sound reasonable are
 * five orders nobody switches between; the sentence under the row is what makes
 * the choice meaningful, so it is shown in both shapes.
 */

import { SlidersHorizontal } from 'lucide-react';
import { Button, ButtonGroup, Chip, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import { RANKS, type Filters, type RankId } from './model';

export interface ControlsProps {
  rankId: RankId;
  onRank: (id: RankId) => void;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  grouped: boolean;
  onGrouped: (value: boolean) => void;
  repos: string[];
  plans: { slug: string; title: string }[];
  /** How many rows the filters are currently hiding — never a silent cut. */
  hidden: number;
}

const selectClass =
  'h-9 min-w-0 max-w-44 rounded border border-rule bg-surface px-2 text-sm text-ink ' +
  'hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)';

export function activeFilterCount(filters: Filters): number {
  return (
    Number(filters.unclaimed) +
    Number(filters.open) +
    Number(Boolean(filters.repo)) +
    Number(Boolean(filters.plan))
  );
}

function RankRow({ rankId, onRank, wrap }: { rankId: RankId; onRank: (id: RankId) => void; wrap: boolean }) {
  const buttons = RANKS.map((r) => (
    <Button key={r.id} size="sm" aria-pressed={rankId === r.id} onClick={() => onRank(r.id)} title={r.blurb}>
      {r.label}
    </Button>
  ));
  // A joined segmented control cannot wrap without its borders coming apart, so
  // the phone sheet uses separate pressable chips of the same vocabulary.
  return wrap ? (
    <div className="flex flex-wrap gap-1.5">
      {RANKS.map((r) => (
        <Button
          key={r.id}
          size="sm"
          variant={rankId === r.id ? 'action' : 'default'}
          aria-pressed={rankId === r.id}
          onClick={() => onRank(r.id)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  ) : (
    <ButtonGroup>{buttons}</ButtonGroup>
  );
}

function FilterFields({
  filters,
  onFilters,
  grouped,
  onGrouped,
  repos,
  plans,
  stacked,
}: Omit<ControlsProps, 'rankId' | 'onRank' | 'hidden'> & { stacked: boolean }) {
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={filters.unclaimed ? 'action' : 'default'}
          aria-pressed={filters.unclaimed}
          onClick={() => onFilters({ unclaimed: !filters.unclaimed })}
        >
          Unclaimed only
        </Button>
        <Button
          size="sm"
          variant={filters.open ? 'action' : 'default'}
          aria-pressed={filters.open}
          onClick={() => onFilters({ open: !filters.open })}
        >
          No gate to clear
        </Button>
        <Button
          size="sm"
          variant={grouped ? 'action' : 'default'}
          aria-pressed={grouped}
          onClick={() => onGrouped(!grouped)}
        >
          Group by plan
        </Button>
      </div>

      <div className={cn('flex gap-2', stacked && 'flex-col')}>
        {repos.length > 1 && (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Repo</span>
            <select
              className={cn(selectClass, stacked && 'max-w-none flex-1')}
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
        {plans.length > 1 && (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Plan</span>
            <select
              className={cn(selectClass, stacked && 'max-w-none flex-1')}
              value={filters.plan}
              onChange={(e) => onFilters({ plan: e.target.value })}
            >
              <option value="">every plan</option>
              {plans.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

export function Controls(props: ControlsProps) {
  const phone = usePhone();
  const rank = RANKS.find((r) => r.id === props.rankId) ?? RANKS[0];
  const active = activeFilterCount(props.filters);

  if (phone) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-2xs text-ink-faint">
          <span className="text-ink-muted">{rank.label}</span> — {rank.hint}
          {props.hidden > 0 && <> · {props.hidden} hidden</>}
        </p>
        <Sheet>
          <SheetTrigger asChild>
            <Button size="sm" className="shrink-0">
              <SlidersHorizontal size={14} />
              Sort &amp; filter
              {active > 0 && <Chip tone="warn">{active}</Chip>}
            </Button>
          </SheetTrigger>
          <SheetContent title="Sort and filter the board">
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
            <RankRow rankId={props.rankId} onRank={props.onRank} wrap />
            <p className="mt-2 text-sm text-ink-muted">{rank.blurb}</p>
            <hr className="my-3 border-rule" />
            <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Show</p>
            <FilterFields {...props} stacked />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <RankRow rankId={props.rankId} onRank={props.onRank} wrap={false} />
        <FilterFields {...props} stacked={false} />
      </div>
      <p className="text-2xs text-ink-faint">
        {rank.blurb}
        {props.hidden > 0 && <> · {props.hidden} hidden by filters</>}
      </p>
    </div>
  );
}
