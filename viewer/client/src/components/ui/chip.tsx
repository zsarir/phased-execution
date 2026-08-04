import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import {
  PHASE_STATUS_TONE, RUN_STATUS_TONE, boardStateTitle, phaseStatusTitle, runStatusTitle,
} from '@/lib/status-vocab';

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
export const PHASE_STATES = [
  'done', 'ready', 'in-progress', 'waiting', 'blocked', 'stuck', 'gated',
] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

/**
 * The engine's state strings arrive as plain `string` off the wire, and an
 * unknown one must still paint *something* — `waiting` is the honest default
 * ("we do not know that this can start"), and it is never amber, so an
 * unrecognised state can never be mistaken for an actionable one.
 */
export function asPhaseState(value: string | undefined): PhaseState {
  return (PHASE_STATES as readonly string[]).includes(value ?? '')
    ? (value as PhaseState)
    : 'waiting';
}

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
 * The same states spelled the way a departures board would.
 *
 * This is the transit identity doing real work rather than decoration: "Held"
 * says *why* a phase is not moving in a way "waiting" does not, and "Boarding"
 * is the one word on the board that means go.
 */
export const STATE_BOARD: Record<PhaseState, string> = {
  done: 'Departed',
  ready: 'Boarding',
  'in-progress': 'On track',
  waiting: 'Held',
  blocked: 'Blocked',
  stuck: 'Blocked',
  gated: 'Gated',
};

/**
 * A chip that carries its own `--state`, so the colour and the word can never
 * disagree — the one class sets both.
 */
export function StateChip({
  state,
  label,
  board = false,
  className,
  title,
  ...props
}: {
  state: PhaseState | string;
  label?: string;
  /** Use the departures vocabulary — Departed / Boarding / On track / Held. */
  board?: boolean;
} & Omit<ChipProps, 'tone' | 'children'>) {
  const resolved = asPhaseState(state);
  return (
    <Chip
      tone="state"
      dot
      className={cn(`state-${resolved}`, className)}
      // Every state word explains itself on hover — what it means and what to
      // do — unless the caller has something more specific to say. The same
      // text the Guide's Reference tables render, from one vocabulary module.
      title={title ?? boardStateTitle(resolved)}
      {...props}
    >
      {label ?? (board ? STATE_BOARD : STATE_LABEL)[resolved]}
    </Chip>
  );
}

/**
 * Dress a bare status WORD in its badge's own clothes — class and hover title.
 *
 * For the Guide's status tables: the words there are inline code in markdown,
 * and markdown cannot colour them. This answers "how would the app paint this
 * word?" from the same tone maps and vocabulary the real chips use, so the
 * glossary and the badges can never drift. Board states (and their departures
 * spellings — Departed, Boarding, Held…) get the state classes; run and phase
 * words get their tone. Unknown words get null, never a guess.
 */
export function decorateStatusWord(word: string): { className: string; title: string } | null {
  if ((PHASE_STATES as readonly string[]).includes(word)) {
    return {
      className: cn(chipVariants({ tone: 'state', mono: true }), `state-${word}`),
      title: boardStateTitle(word) ?? '',
    };
  }
  const spelled = (Object.entries(STATE_BOARD) as [PhaseState, string][])
    .find(([, board]) => board === word)?.[0];
  if (spelled) {
    return {
      className: cn(chipVariants({ tone: 'state' }), `state-${spelled}`),
      title: boardStateTitle(spelled) ?? '',
    };
  }
  const runTitle = runStatusTitle(word);
  if (runTitle) {
    return {
      className: cn(chipVariants({ tone: RUN_STATUS_TONE[word as keyof typeof RUN_STATUS_TONE] ?? 'neutral', mono: true })),
      title: runTitle,
    };
  }
  const phaseTitle = phaseStatusTitle(word);
  if (phaseTitle) {
    return {
      className: cn(chipVariants({ tone: PHASE_STATUS_TONE[word as keyof typeof PHASE_STATUS_TONE] ?? 'neutral', mono: true })),
      title: phaseTitle,
    };
  }
  return null;
}
