/**
 * StatusBadge — where a UI state becomes a word, a hue class and an icon, and
 * nowhere else. What these tests hold: every one of the eight states renders
 * the vocabulary's own label (never a second copy), wears `state-<ui>` so the
 * stylesheet's token paints it and `data-state` so a row can read it, always
 * draws its icon (colour is never the only carrier), explains itself on hover,
 * paints an unknown word as the honest `waiting` — never amber, never green —
 * and pulses ONLY for `running`, only when asked. `decorateStatusWord` is the
 * Guide's bridge onto the same vocabulary, so a glossary word and a badge
 * cannot drift apart.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATE_META, UI_STATES, UNKNOWN_STATE } from '@/lib/status-vocab';
import { expectNoAxeViolations } from '@/test/axe';
import {
  STATE_ICONS, StatusBadge, StatusDot, asUiState, decorateStatusWord, statusBadgeClass,
} from './status-badge';

const first = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('StatusBadge', () => {
  it.each(UI_STATES)('%s: the vocabulary label, state-<ui>, data-state and a hidden icon', (state) => {
    const { container } = render(<StatusBadge state={state} />);
    const badge = first(container);
    expect(badge).toHaveTextContent(STATE_META[state].label);
    expect(badge).toHaveClass(`state-${state}`);
    expect(badge).toHaveAttribute('data-state', state);
    const icon = badge.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('explains itself on hover — what the state means, then what to do', () => {
    const { container } = render(<StatusBadge state="failed" />);
    const title = first(container).getAttribute('title') ?? '';
    expect(title).toContain('→');
    expect(title).toMatch(/failed/i);
  });

  it('lets the caller say something more specific in the title', () => {
    const { container } = render(<StatusBadge state="failed" title="exit 1 in verify" />);
    expect(first(container)).toHaveAttribute('title', 'exit 1 in verify');
  });

  it('paints an unknown word as waiting — never amber, never green', () => {
    const { container } = render(<StatusBadge state="halted" />);
    const badge = first(container);
    expect(badge).toHaveClass(`state-${UNKNOWN_STATE}`);
    expect(badge).toHaveAttribute('data-state', 'waiting');
    expect(badge).toHaveTextContent('Waiting');
    expect(badge).not.toHaveClass('state-needs-you');
    expect(badge).not.toHaveClass('state-done');
  });

  it('pulses only for running, and only when asked', () => {
    const { container: live } = render(<StatusBadge state="running" pulse />);
    expect(live.querySelector('svg')).toHaveClass('animate-pulse-soft');
    const { container: still } = render(<StatusBadge state="running" />);
    expect(still.querySelector('svg')).not.toHaveClass('animate-pulse-soft');
    const { container: verifying } = render(<StatusBadge state="verifying" pulse />);
    expect(verifying.querySelector('svg')).not.toHaveClass('animate-pulse-soft');
  });

  it('takes a label of its own and drops the icon when the row carries it', () => {
    const { container } = render(<StatusBadge state="done" label="Merged" icon={false} />);
    const badge = first(container);
    expect(badge).toHaveTextContent('Merged');
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge).toHaveClass('state-done');
  });

  it('size and mono are variants of the one badge class', () => {
    const { container } = render(<StatusBadge state="queued" size="md" mono />);
    expect(first(container)).toHaveClass('font-mono', 'text-xs', 'text-state');
  });

  it('has no axe violations across the whole vocabulary', async () => {
    const { container } = render(
      <p>{UI_STATES.map((state) => <StatusBadge key={state} state={state} />)}</p>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('StatusDot', () => {
  it('is decoration: hidden from assistive tech, painted by its state class', () => {
    const { container } = render(<StatusDot state="running" pulse />);
    const dot = first(container);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveAttribute('data-state', 'running');
    expect(dot).toHaveClass('state-running', 'bg-state', 'animate-pulse-soft');
  });

  it('never pulses for a state that is not running', () => {
    const { container } = render(<StatusDot state="waiting" pulse />);
    expect(first(container)).not.toHaveClass('animate-pulse-soft');
  });

  it('paints an unknown word as waiting', () => {
    const { container } = render(<StatusDot state="nonsense" />);
    expect(first(container)).toHaveClass('state-waiting');
  });
});

describe('STATE_ICONS', () => {
  it('names a lucide component for every icon the vocabulary uses', () => {
    for (const state of UI_STATES) {
      const icon = STATE_META[state].icon;
      expect(STATE_ICONS[icon], `${state} → ${icon}`).toBeDefined();
    }
  });
});

describe('decorateStatusWord', () => {
  it('dresses a run status word in its UI state\'s badge class, mono, with a title', () => {
    const word = decorateStatusWord('halted');
    expect(word).not.toBeNull();
    expect(word?.className).toContain('state-needs-you');
    expect(word?.className).toContain('font-mono');
    expect(word?.title).toContain('→');
  });

  it('a UI state name answers as itself; a board word as its UI state', () => {
    expect(decorateStatusWord('done')?.className).toContain('state-done');
    expect(decorateStatusWord('ready')?.className).toContain('state-queued');
  });

  it('answers null — never a guess — for a word outside every vocabulary', () => {
    expect(decorateStatusWord('--allow-run')).toBeNull();
  });
});

describe('statusBadgeClass and asUiState', () => {
  it('statusBadgeClass paints with the state tone and the state class', () => {
    const cls = statusBadgeClass('failed');
    expect(cls).toContain('state-failed');
    expect(cls).toContain('text-state');
    expect(cls).not.toContain('font-mono');
    expect(statusBadgeClass('failed', { mono: true })).toContain('font-mono');
  });

  it('asUiState keeps a known state and maps anything else to waiting', () => {
    expect(asUiState('failed')).toBe('failed');
    expect(asUiState('bogus')).toBe('waiting');
    expect(asUiState(null)).toBe('waiting');
    expect(asUiState(undefined)).toBe('waiting');
  });
});
