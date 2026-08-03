import { cn } from '@/lib/cn';

/**
 * A plan's phases as one bar: departed, on track, blocked, boarding, then the
 * track still to be laid.
 *
 * It is a `role="img"` with a written label rather than a `<progressbar>`,
 * because it is not one number — it is four counts sharing a length, and a
 * screen reader given "37%" would be told the least useful of them.
 */
export function Progress({
  total,
  done = 0,
  inProgress = 0,
  ready = 0,
  stuck = 0,
  className,
}: {
  total: number;
  done?: number;
  inProgress?: number;
  ready?: number;
  stuck?: number;
  className?: string;
}) {
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  const parts = [
    ['bg-done', done],
    ['bg-progress', inProgress],
    ['bg-stuck', stuck],
    ['bg-ready', ready],
  ] as const;

  return (
    <div
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-track', className)}
      role="img"
      aria-label={`${done} of ${total} phases done`}
    >
      {parts.map(([tone, value]) => (
        <span key={tone} className={cn('block h-full', tone)} style={{ width: pct(value) }} />
      ))}
    </div>
  );
}
