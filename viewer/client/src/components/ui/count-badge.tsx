import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A count in a pill — unread notifications, approvals waiting, items hidden.
 *
 * Replaces the old brand-coloured `Badge`: a count is a number, not a word,
 * and it is amber ONLY when what it counts needs a person (`tone="accent"`).
 * Zero renders nothing unless asked: an empty "0" pill is noise that reads
 * as "something", which is the one thing a count must never do.
 */
export function CountBadge({
  count,
  max = 99,
  showZero = false,
  tone = 'neutral',
  label,
  className,
  ...props
}: {
  count: number;
  /** Above this it reads `max+`. */
  max?: number;
  showZero?: boolean;
  tone?: 'neutral' | 'accent' | 'solid';
  /** What is being counted, for assistive tech: "3 approvals waiting". */
  label?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  if (!Number.isFinite(count) || (count <= 0 && !showZero)) return null;
  const text = count > max ? `${max}+` : String(count);
  return (
    <span
      className={cn(
        'inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1',
        'text-2xs font-semibold leading-none tabular-nums',
        tone === 'accent' && 'bg-accent text-ground',
        tone === 'solid' && 'bg-ink text-ground',
        tone === 'neutral' && 'bg-rule text-ink',
        className,
      )}
      // With a label the pill is one atomic, named thing; a bare span (role
      // generic) silently drops aria-label, so the name never reached AT.
      role={label ? 'img' : undefined}
      aria-label={label ? `${count} ${label}` : undefined}
      {...props}
    >
      <span aria-hidden={Boolean(label)}>{text}</span>
    </span>
  );
}
