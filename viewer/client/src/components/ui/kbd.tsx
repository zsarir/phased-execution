import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A key, as a key looks — for the shortcuts the palette, the help sheet and
 * a tooltip name. `<kbd>` is the element; the mono face, the ligature-off
 * rule and the wrap rule come from the base layer.
 */
export function Kbd({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-rule-strong/70 bg-surface-raised',
        'px-1 font-mono text-2xs font-medium text-ink-muted shadow-[inset_0_-1px_0_var(--rule-strong)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

/** A chord — keys with the platform's own separators, for "⌘ K" or "g then r". */
export function KbdChord({ keys, className, conjunction = ' ' }: { keys: string[]; className?: string; conjunction?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)}>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-2xs text-ink-faint" aria-hidden>{conjunction.trim() || '+'}</span>}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  );
}
