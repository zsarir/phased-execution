import {
  CircleCheck, CircleDashed, CirclePlay, CircleSlash, CircleX, Hand, Hourglass, SearchCheck,
  type LucideIcon,
} from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  STATE_META, UNKNOWN_STATE, isUiState, uiStateTitle, wordTitle, wordUiState, type UiState,
} from '@/lib/status-vocab';
import { badgeVariants } from './badge';

/**
 * The status badge — ONE of the two places a UI state's hue and icon are read
 * (the other is the `.state-<ui>` classes in `styles/theme.css`, which this
 * badge wears). Every run status, phase record, board state and situation
 * reaches a badge through `shared/status-vocab.js`, so the word, the colour and
 * the icon can never disagree, and colour is never the only carrier: the
 * label is always text and the icon is always drawn (WCAG 1.4.1).
 *
 * `running` is the only state that may pulse, and only when the caller says
 * the thing is live right now (`pulse`) — a static dot cannot distinguish "a
 * session is thinking" from "this page is stale".
 */

/** `STATE_META[*].icon` → the lucide component. `status-badge.test.tsx` holds it total. */
export const STATE_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  'hand': Hand,
  'circle-x': CircleX,
  'circle-play': CirclePlay,
  'search-check': SearchCheck,
  'hourglass': Hourglass,
  'circle-dashed': CircleDashed,
  'circle-slash': CircleSlash,
  'circle-check': CircleCheck,
});

/** The honest state for a word the vocabulary does not know. */
export function asUiState(value: string | null | undefined): UiState {
  return isUiState(value) ? value : UNKNOWN_STATE;
}

/** The classes that paint an element as a given UI state's badge — for markup React does not own. */
export function statusBadgeClass(state: UiState, opts: { mono?: boolean } = {}): string {
  return cn(badgeVariants({ tone: 'state', mono: opts.mono ?? false }), `state-${state}`);
}

/**
 * Dress a bare status WORD in its badge's clothes — class and hover title.
 *
 * For the Guide's status tables: the words there are inline code in markdown,
 * and markdown cannot colour them. This answers "how would the app paint this
 * word?" from the same vocabulary the real badges use, so the glossary and the
 * badges cannot drift. Unknown words get null, never a guess.
 */
export function decorateStatusWord(word: string): { className: string; title: string } | null {
  const state = wordUiState(word);
  if (!state) return null;
  return { className: statusBadgeClass(state, { mono: true }), title: wordTitle(word) ?? uiStateTitle(state) ?? '' };
}

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** A UI state. An unknown word paints as `UNKNOWN_STATE` — never amber, never green. */
  state: UiState | string;
  /** The word on the badge. Defaults to the state's own label ("Needs you", "Running", …). */
  label?: ReactNode;
  /** Draw the state's icon (default yes). Off only where the icon sits elsewhere on the row. */
  icon?: boolean;
  /** Breathe — honoured for `running` only, and only while the thing is live. */
  pulse?: boolean;
  size?: 'sm' | 'md';
  mono?: boolean;
}

export function StatusBadge({
  state, label, icon = true, pulse = false, size = 'sm', mono = false, className, title, ...props
}: StatusBadgeProps) {
  const ui = asUiState(state);
  const meta = STATE_META[ui];
  const Icon = STATE_ICONS[meta.icon];
  return (
    <span
      data-state={ui}
      className={cn(badgeVariants({ tone: 'state', size, mono }), `state-${ui}`, className)}
      // Every state explains itself on hover — what it means and what to do —
      // unless the caller has something more specific to say.
      title={title ?? uiStateTitle(ui)}
      {...props}
    >
      {icon && Icon && (
        <Icon
          size={size === 'md' ? 13 : 11}
          strokeWidth={2.25}
          aria-hidden
          className={cn('shrink-0', pulse && ui === 'running' && 'animate-pulse-soft')}
        />
      )}
      {label ?? meta.label}
    </span>
  );
}

/**
 * A bare state dot for dense rows — the hue and nothing else, so it MUST sit
 * beside the word it colours (the label or the row's own text).
 */
export function StatusDot({ state, pulse = false, className }: { state: UiState | string; pulse?: boolean; className?: string }) {
  const ui = asUiState(state);
  return (
    <span
      aria-hidden
      data-state={ui}
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full bg-state',
        `state-${ui}`,
        pulse && ui === 'running' && 'animate-pulse-soft',
        className,
      )}
    />
  );
}
