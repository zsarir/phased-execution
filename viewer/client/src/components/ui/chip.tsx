import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * The tone variants are real classes, not a colour passed in as a prop.
 *
 * In the old client a run status and a phase status both rendered `<span
 * class="chip">` and were coloured by whatever `--state` happened to be in
 * scope, so two different statuses could paint identically and nobody could see
 * it in the markup. Here `ok`/`busy`/`bad`/`warn` differ *by construction*: they
 * are separate classes with separate colours, and a status that forgets to pick
 * one is grey, which is visibly wrong rather than invisibly wrong.
 */
export const chipVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-2xs leading-tight ' +
    'font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-rule text-ink-muted',
        ok: 'border-done/45 text-done',
        busy: 'border-progress/45 text-progress',
        bad: 'border-blocked/45 text-blocked',
        warn: 'border-action/50 text-action',
        gate: 'border-gated/50 text-gated',
        stuck: 'border-stuck/45 text-stuck',
        /** Painted by the nearest `.state-*` ancestor. */
        state: 'border-state/45 text-state',
      },
      mono: { true: 'font-mono', false: '' },
    },
    defaultVariants: { tone: 'neutral', mono: false },
  },
);

export interface ChipProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {
  /** Show the leading dot. */
  dot?: boolean;
}

export function Chip({ className, tone, mono, dot = false, children, ...props }: ChipProps) {
  return (
    <span className={cn(chipVariants({ tone, mono }), className)} {...props}>
      {dot && <span className="size-[7px] shrink-0 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** Phase/run states, as the route map names them. */
export type PhaseState =
  | 'done' | 'ready' | 'in-progress' | 'waiting' | 'blocked' | 'stuck' | 'gated';

const STATE_LABEL: Record<PhaseState, string> = {
  done: 'done',
  ready: 'ready',
  'in-progress': 'in progress',
  waiting: 'waiting',
  blocked: 'blocked',
  stuck: 'stuck',
  gated: 'gated',
};

/**
 * A chip that carries its own `--state`, so the colour and the word can never
 * disagree — the one class sets both.
 */
export function StateChip({
  state,
  label,
  className,
  ...props
}: { state: PhaseState; label?: string } & Omit<ChipProps, 'tone' | 'children'>) {
  return (
    <Chip
      tone="state"
      dot
      className={cn(`state-${state}`, className)}
      {...props}
    >
      {label ?? STATE_LABEL[state]}
    </Chip>
  );
}
