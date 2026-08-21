import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A badge: a short word or number in a bordered pill.
 *
 * The tone axis is the TONE FAMILY of the status vocabulary (`STATE_META[*].tone`)
 * plus `state`, which paints with whatever `--state` the nearest `.state-<ui>`
 * class set — that is how `StatusBadge` and a `.state-*` row agree without
 * either naming a colour. A badge that forgets to pick a tone is grey, which
 * is visibly wrong rather than invisibly wrong.
 *
 * Never a hover-only affordance: a badge's `title` is a hint for a mouse; the
 * word on it must carry the meaning by itself.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs leading-tight ' +
    'font-medium whitespace-nowrap tabular-nums',
  {
    variants: {
      tone: {
        neutral: 'border-rule text-ink-muted',
        ok: 'border-done/45 text-done',
        live: 'border-running/45 text-running',
        wait: 'border-waiting/45 text-waiting',
        bad: 'border-failed/45 text-failed',
        /** The amber one: needs a person. Rationed, like every amber. */
        accent: 'border-accent/50 text-accent',
        /** Painted by the nearest `.state-<ui>` class — its own or an ancestor's. */
        state: 'border-state/45 text-state',
        /** A filled pill — the brand, a count that must be seen. */
        solid: 'border-transparent bg-ink text-ground',
      },
      size: {
        sm: 'text-2xs px-1.5 py-0.5',
        md: 'text-xs px-2 py-0.5',
      },
      mono: { true: 'font-mono', false: '' },
    },
    defaultVariants: { tone: 'neutral', size: 'sm', mono: false },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Show the leading dot (`bg-current`, so it follows the tone). */
  dot?: boolean;
}

export function Badge({ className, tone, size, mono, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size, mono }), className)} {...props}>
      {dot && <span className="size-[7px] shrink-0 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
