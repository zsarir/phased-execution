/**
 * The one toolbar. Two lists use it; neither owns it.
 *
 * Plans and Runs arrived at the same control strip from opposite ends and wrote
 * it twice — two `SearchBox`es, two phone sheets, two `fieldClass` strings, two
 * spellings of "N hidden by filters". They were never quite the same: the
 * fleet's search cleared on a different element, the plans sheet was titled and
 * the fleet's was not, and only one of the two put its sort blurb on screen. A
 * person moving between the pages had to learn the control twice.
 *
 * ## What is shared, and what is not
 *
 * Shared is the MECHANISM: a search field that clears itself, the phone/desktop
 * split, the sheet, the count of how far the filters are from their defaults,
 * and the note underneath. Not shared is the VOCABULARY — which sorts exist,
 * what a chip counts, whether there is a layout toggle. Each page passes its
 * own, so this file never learns what a plan or a run is.
 *
 * ## Why the body is a render prop
 *
 * The filter controls are not two components, they are one set of controls in
 * two SHAPES: inline on a wide screen, stacked inside the sheet on a phone.
 * `children` receives which shape it is being asked for and lays itself out
 * accordingly — so the two renderings cannot drift into two different sets of
 * controls, which is exactly what happened to the copies this replaces (the
 * fleet's Plan select existed only in the sheet on a phone and only inline on a
 * desktop, and nothing said so).
 */

import type { ReactNode } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button, ButtonGroup, Chip, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';

/** Which rendering the body is being asked for. */
export type ToolbarShape = 'inline' | 'sheet';

/**
 * The field class both pages were spelling out.
 *
 * `min-h-(--tap-min)` only under `hover:none` — a mouse does not need a 44 px
 * select, and forcing one on a desktop makes a control row that is taller than
 * the rows it filters.
 */
export const fieldClass =
  'h-9 min-w-0 rounded border border-rule bg-surface px-2 text-sm text-ink ' +
  'hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)';

/** One entry in a sort control: the id stored, the word shown, the reason why. */
export interface SortOption<Id extends string = string> {
  id: Id;
  label: string;
  /** The short gloss on the button itself (a `title`). */
  hint?: string;
  /** The sentence under the toolbar once it is the chosen order. */
  blurb?: string;
}

/* ------------------------------------------------------------------ *
 * The search field
 * ------------------------------------------------------------------ */

export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The accessible name — always longer than the placeholder, and never absent. */
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('relative flex min-w-0 items-center', className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-faint" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
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
 * The sort control
 * ------------------------------------------------------------------ */

/**
 * The order, in whichever shape fits.
 *
 * A joined segmented control cannot wrap without its borders coming apart, so
 * the sheet uses separate pressable buttons of the same vocabulary. The pressed
 * one is amber ONLY there: inside a `ButtonGroup` the segment's own selected
 * styling already says it, and amber is the colour this system rations.
 */
export function ToolbarSorts<Id extends string>({
  sorts,
  value,
  onSort,
  shape,
}: {
  sorts: readonly SortOption<Id>[];
  value: Id;
  onSort: (id: Id) => void;
  shape: ToolbarShape;
}) {
  const buttons = sorts.map((sort) => (
    <Button
      key={sort.id}
      size="sm"
      variant={shape === 'sheet' && value === sort.id ? 'action' : 'default'}
      aria-pressed={value === sort.id}
      onClick={() => onSort(sort.id)}
      title={sort.hint ?? sort.blurb ?? ''}
    >
      {sort.label}
    </Button>
  ));

  if (shape === 'sheet') return <div className="flex flex-wrap gap-1.5">{buttons}</div>;
  return <ButtonGroup>{buttons}</ButtonGroup>;
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

export interface ToolbarProps {
  /** The search field's own words. */
  search: { value: string; onChange: (value: string) => void; placeholder: string; label: string };
  /**
   * A row that stays visible in BOTH shapes, above everything else — the
   * fleet's outcome chips, which are simultaneously the filter and the only
   * summary of the fleet's shape. Folding those into a sheet would hide the
   * answer inside the control.
   */
  chips?: ReactNode;
  /** How many filters are away from their default — the number on the sheet button. */
  activeCount?: number;
  /** The sheet's heading. A sheet with no title is a panel that appeared. */
  sheetTitle: string;
  /** Right-aligned on a wide screen, last in the sheet on a phone. */
  trailing?: ReactNode;
  /** The line under the strip: the chosen order, what is hidden, what to press. */
  note?: ReactNode;
  /** The controls themselves, laid out for the shape they are asked for. */
  children: (shape: ToolbarShape) => ReactNode;
}

export function Toolbar({
  search,
  chips,
  activeCount = 0,
  sheetTitle,
  trailing,
  note,
  children,
}: ToolbarProps) {
  const phone = usePhone();

  return (
    <div className="flex flex-col gap-2">
      {chips}

      {phone ? (
        <div className="flex items-center gap-2">
          <ToolbarSearch {...search} className="flex-1" />
          <Sheet>
            <SheetTrigger asChild>
              <Button size="sm" className="shrink-0">
                <SlidersHorizontal size={14} aria-hidden />
                Sort
                {activeCount > 0 && <Chip tone="warn">{activeCount}</Chip>}
              </Button>
            </SheetTrigger>
            <SheetContent title={sheetTitle}>
              {children('sheet')}
              {trailing != null && (
                <>
                  <hr className="my-3 border-rule" />
                  {trailing}
                </>
              )}
            </SheetContent>
          </Sheet>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ToolbarSearch {...search} className="w-52" />
          {children('inline')}
          {trailing != null && <div className="ml-auto">{trailing}</div>}
        </div>
      )}

      {note != null && <p className="min-w-0 text-2xs text-ink-faint">{note}</p>}
    </div>
  );
}

/** The label a shape toggle wears once it has something to bring back. */
export const countedLabel = (label: string, count: number): string =>
  count > 0 ? `${label} — ${count} more` : label;
