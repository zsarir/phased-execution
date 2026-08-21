import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/clock';

/**
 * "3 minutes ago", kept true.
 *
 * A relative time painted once goes stale while you read it; this one re-reads
 * the clock (every 30 s, or the caller's cadence) while `live`, and carries the
 * absolute instant in `dateTime` and the hover — the figure is the glance, the
 * title is the fact. Accepts epoch ms or an ISO string; an unparseable or
 * missing instant renders the em-dash rather than "NaN ago".
 */
export function RelativeTime({
  at,
  live = true,
  intervalMs = 30_000,
  className,
  title,
  ...props
}: {
  at: number | string | null | undefined;
  /** Tick while mounted. Off for a list of hundreds of rows that never change. */
  live?: boolean;
  intervalMs?: number;
} & HTMLAttributes<HTMLElement>) {
  const ms = typeof at === 'string' ? Date.parse(at) : at ?? NaN;
  const valid = Number.isFinite(ms);
  useNow(live && valid, intervalMs);
  if (!valid) return <span className={cn('text-ink-faint', className)} {...props}>—</span>;
  const date = new Date(ms as number);
  return (
    <time
      dateTime={date.toISOString()}
      title={title ?? date.toLocaleString()}
      className={cn('tabular-nums', className)}
      {...props}
    >
      {relativeTime(ms as number)}
    </time>
  );
}
