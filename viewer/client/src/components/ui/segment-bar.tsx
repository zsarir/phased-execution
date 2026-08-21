import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { STATE_META, UI_STATES, type UiState } from '@/lib/status-vocab';

/**
 * A proportional bar over the UI states: how many phases are done, running,
 * next up, waiting, needing you — in the width of a table cell.
 *
 * Every segment is painted by its state's token through `.state-<ui>` (never
 * a colour of its own), drawn worst-first so the amber sits at the left edge
 * where a glance lands, and the whole thing is one `role="img"` whose name
 * reads the counts out in words — a proportional bar is not a progress bar,
 * and "37 %" would be the least useful of its numbers.
 */
export interface SegmentCounts extends Partial<Record<UiState, number>> {}

export function SegmentBar({
  counts,
  total,
  label = 'phases',
  height = 'md',
  className,
  ...props
}: {
  counts: SegmentCounts;
  /** The denominator; defaults to the sum of the counts. A larger total leaves track unpainted. */
  total?: number;
  /** What is being counted, for the accessible name. */
  label?: string;
  height?: 'sm' | 'md';
} & HTMLAttributes<HTMLSpanElement>) {
  const segments = UI_STATES.map((state) => ({ state, value: Math.max(0, counts[state] ?? 0) })).filter((s) => s.value > 0);
  const sum = segments.reduce((acc, s) => acc + s.value, 0);
  const denominator = Math.max(total ?? sum, sum, 1);
  const name = segments.length
    ? `${sum} of ${denominator} ${label}: ${segments.map((s) => `${s.value} ${STATE_META[s.state].label.toLowerCase()}`).join(', ')}`
    : `no ${label}`;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        'flex w-full min-w-0 items-stretch gap-px overflow-hidden rounded-full bg-track',
        height === 'sm' ? 'h-1.5' : 'h-2.5',
        className,
      )}
      {...props}
    >
      {segments.map((s) => (
        <span
          key={s.state}
          className={cn('block min-w-0 bg-state', `state-${s.state}`)}
          style={{ width: `${(s.value / denominator) * 100}%` }}
        />
      ))}
    </span>
  );
}
