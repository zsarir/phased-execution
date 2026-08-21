import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { duration, elapsed } from '@/lib/format';
import { useNow } from '@/lib/clock';

/**
 * A span of time, as a figure that may still be growing.
 *
 * Two readings: `ms` is a settled length ("took 4m 12s"); `since` is a start
 * that is still counting, in which case the figure ticks once a second while
 * `live` — a clock that stops is how a console tells you the session died,
 * so `live` is never assumed. Tabular, mono, and `<time>` for assistive tech.
 */
export function Duration({
  ms,
  since,
  live = false,
  className,
  ...props
}: {
  /** A settled length. */
  ms?: number | null;
  /** A start timestamp (epoch ms) still counting; ticks while `live`. */
  since?: number | null;
  live?: boolean;
} & HTMLAttributes<HTMLElement>) {
  const now = useNow(Boolean(live && since != null));
  const value = since != null ? Math.max(0, now - since) : ms;
  if (value == null || !Number.isFinite(value)) {
    return <span className={cn('text-ink-faint', className)} {...props}>—</span>;
  }
  const text = since != null ? elapsed(value) : duration(value);
  return (
    <time
      dateTime={isoDuration(value)}
      className={cn('font-mono tabular-nums', className)}
      {...props}
    >
      {text}
    </time>
  );
}

/** `PT1H2M3S` for the `dateTime` attribute. */
export function isoDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}
