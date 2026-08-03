import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A loading placeholder shaped like the thing that is coming. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded bg-rule/60', className)}
      {...props}
    />
  );
}

/**
 * Nothing here — and why, and what to do about it.
 *
 * An empty list that says only "No results" is indistinguishable from a broken
 * one, which is why `action` is part of the shape rather than an afterthought.
 */
export function Empty({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid place-items-center px-4 py-10 text-center', className)}>
      <div className="max-w-sm">
        {icon != null && <div className="mb-2 flex justify-center text-ink-faint">{icon}</div>}
        <p className="font-display text-lg text-ink">{title}</p>
        {body != null && <p className="mt-1 text-sm text-ink-muted">{body}</p>}
        {action != null && <div className="mt-3 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

/** The spinner, for the cases where a skeleton would be a lie about the shape. */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 text-sm text-ink-muted', className)} role="status">
      <span
        className="size-4 animate-spin rounded-full border-2 border-rule border-t-action"
        aria-hidden
      />
      {label && <span>{label}</span>}
    </div>
  );
}
