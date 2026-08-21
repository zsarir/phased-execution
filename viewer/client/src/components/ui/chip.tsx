import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { boardLabel, boardStateTitle, boardUiState } from '@/lib/status-vocab';
import { Badge, badgeVariants, type BadgeTone } from './badge';
import { StatusBadge } from './status-badge';

/**
 * `Chip` — a thin alias over `Badge`, kept for the 2.x views until Phase 11
 * deletes them. New code uses `Badge` (a word), `StatusBadge` (a state) or
 * `CountBadge` (a number) directly.
 *
 * The old tone axis is mapped onto the vocabulary's tone families: `busy` is
 * live (running), `warn`/`gate`/`stuck` all meant "a person is needed" and are
 * the accent, `bad` is failed. The colours therefore come from the same eight
 * tokens every new badge paints with — there is no second palette here.
 */

/** The 2.x tone words → the Badge tone families. */
export const LEGACY_TONE: Readonly<Record<string, BadgeTone>> = Object.freeze({
  neutral: 'neutral',
  ok: 'ok',
  busy: 'live',
  bad: 'bad',
  warn: 'accent',
  gate: 'accent',
  stuck: 'accent',
  state: 'state',
  /* The vocabulary's own family names pass straight through. */
  live: 'live',
  wait: 'wait',
  accent: 'accent',
  solid: 'solid',
});

export type ChipTone = keyof typeof LEGACY_TONE | undefined;

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  mono?: boolean;
  /** Show the leading dot. */
  dot?: boolean;
}

/** The class a 2.x caller composed by hand. Prefer `badgeVariants`. */
export const chipVariants = ({ tone, mono }: { tone?: ChipTone; mono?: boolean } = {}) =>
  badgeVariants({ tone: LEGACY_TONE[tone ?? 'neutral'] ?? 'neutral', mono: mono ?? false });

export function Chip({ className, tone, mono, dot = false, children, ...props }: ChipProps) {
  return (
    <Badge
      tone={LEGACY_TONE[tone ?? 'neutral'] ?? 'neutral'}
      mono={mono ?? false}
      dot={dot}
      className={cn(className)}
      {...props}
    >
      {children}
    </Badge>
  );
}

/** Phase states, as the engine names them. */
export const PHASE_STATES = ['done', 'ready', 'in-progress', 'waiting', 'blocked', 'stuck', 'gated'] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

/**
 * The engine's state strings arrive as plain `string` off the wire, and an
 * unknown one must still paint *something* — `waiting` is the honest default
 * ("we do not know that this can start"), and it is never amber, so an
 * unrecognised state can never be mistaken for an actionable one.
 */
export function asPhaseState(value: string | undefined): PhaseState {
  return (PHASE_STATES as readonly string[]).includes(value ?? '') ? (value as PhaseState) : 'waiting';
}

/**
 * A board state as a `StatusBadge` — the 2.x `StateChip` signature over the
 * vocabulary: the board word becomes its UI state, the label is the plain
 * word ("Next up" for ready), and the hover explains the board state itself.
 */
export function StateChip({
  state,
  label,
  board: _board,
  dot: _dot,
  className,
  title,
  ...props
}: {
  state: PhaseState | string;
  label?: string;
  /** 2.x: "use the departures vocabulary". The vocabulary is plain words now; accepted and ignored. */
  board?: boolean;
} & Omit<ChipProps, 'tone' | 'children'>) {
  const resolved = asPhaseState(state);
  return (
    <StatusBadge
      state={boardUiState(resolved)}
      label={label ?? boardLabel(resolved)}
      title={title ?? boardStateTitle(resolved)}
      className={className}
      {...props}
    />
  );
}
