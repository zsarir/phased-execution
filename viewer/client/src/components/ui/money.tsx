import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';

/**
 * A dollar amount: tabular figures, mono, and an honest blank.
 *
 * `null`/`undefined` renders the em-dash, never `$0.00` — a cost the runner
 * has not recorded is not free. `against` paints the figure in the failed
 * colour once it passes the budget, with the budget named in the title.
 */
export function MoneyAmount({
  usd,
  against,
  className,
  ...props
}: {
  usd: number | null | undefined;
  /** A budget to read the figure against. Over it, the figure is red and says so. */
  against?: number | null;
} & HTMLAttributes<HTMLSpanElement>) {
  const over = usd != null && against != null && against > 0 && usd > against;
  return (
    <span
      className={cn('font-mono tabular-nums', over ? 'text-failed' : undefined, className)}
      title={
        against != null && against > 0
          ? `${money(usd)} of a ${money(against)} budget${over ? ' — over' : ''}`
          : undefined
      }
      {...props}
    >
      {usd == null ? '—' : money(usd)}
    </span>
  );
}
