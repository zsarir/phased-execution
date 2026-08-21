import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tables.
 *
 * The wrapper is the load-bearing part: a table wide enough to need scrolling
 * scrolls *inside its own box*, so the page body never does. A phone that
 * scrolls sideways as a whole loses the tab bar off the edge and never gets it
 * back — that is the single most common way a responsive layout breaks here.
 */
export function TableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // Never give this wrapper a max-height: `overflow-x` makes computed
      // `overflow-y` auto, so a height-capped wrapper becomes a second
      // vertical scroller that captures touch flicks meant for the page.
      // Height always fits content here, so no vertical gesture is consumed.
      className={cn(
        'w-full max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-rule',
        className,
      )}
      {...props}
    />
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    // Not sticky: inside an overflow-x wrapper, sticky can only stick to the
    // wrapper — which never scrolls vertically — so it was pure paint cost
    // that also promoted a layer on every table.
    <thead
      className={cn('bg-surface-raised text-left text-2xs uppercase tracking-wide text-ink-muted', className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-rule', className)} {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('bg-surface hover:bg-surface-raised', className)} {...props} />;
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('whitespace-nowrap px-3 py-2 font-medium', className)} {...props} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}
