import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type KeyValueItem = readonly [label: string, value: ReactNode] | null | undefined | false;

/**
 * Facts as a real `<dl>`.
 *
 * Rows whose value is missing are dropped rather than rendered empty — a fact
 * list padded with em-dashes reads as a form with holes in it, and the reason a
 * row is absent (this plan has no lock, no gate, no QA) is never interesting.
 * Passing `null` for a row is therefore the normal way to say "not applicable".
 */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  const rows = items.filter(
    (item): item is readonly [string, ReactNode] => Array.isArray(item) && item[1] != null && item[1] !== '',
  );
  if (!rows.length) return null;

  return (
    <dl className={cn('grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm', className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="col-span-2 grid grid-cols-subgrid items-baseline">
          <dt className="text-2xs uppercase tracking-wide text-ink-faint">{label}</dt>
          <dd className="m-0 min-w-0 text-ink-muted">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
