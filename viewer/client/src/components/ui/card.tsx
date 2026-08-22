import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * What a card looks like, as a string.
 *
 * Exported because not every card can BE a `<Card>`: a collapsible one is a
 * `<details>`, and an element cannot be two tags. Three files retyped this by
 * hand before it had a name, which is how a card ends up with the wrong shadow
 * on one page and nobody notices.
 */
export const cardClass = 'rounded-lg border border-rule bg-surface shadow-card';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(cardClass, className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-start justify-between gap-3 border-b border-rule px-4 py-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('font-display text-lg', className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-3', className)} {...props} />;
}

/**
 * A number and what it counts. The number is display-face and large because on
 * a phone it is often the only thing read; the label is what makes it a fact
 * rather than a decoration.
 */
export function Tile({
  label,
  value,
  hint,
  state,
  className,
  ...props
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Paints the value with a state colour — `state-ready` for a ready count. */
  state?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-rule bg-surface px-3 py-2.5', state, className)} {...props}>
      {/* `tabular-nums` because every Tile value in this app is a figure — a
          count, a sum of money, a duration — and a column of them that
          re-flows digit by digit as the numbers tick is a column you cannot
          compare down. It affects digits only, so it is inert on the `—` a
          tile shows when it has nothing. */}
      <div
        className={cn('font-display text-2xl leading-none tabular-nums', state ? 'text-state' : 'text-ink')}
      >
        {value}
      </div>
      <div className="mt-1 text-2xs tracking-wide text-ink-muted uppercase">{label}</div>
      {hint != null && <div className="mt-0.5 text-2xs text-ink-faint">{hint}</div>}
    </div>
  );
}
