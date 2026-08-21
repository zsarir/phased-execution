/**
 * Chip and StateChip — the 2.x aliases over Badge/StatusBadge, kept until
 * Phase 11 deletes the old views. What these tests hold: the legacy tone
 * words land on the vocabulary's tone families (warn/gate/stuck all meant "a
 * person is needed" and are the accent; busy is live) so there is no second
 * palette; StateChip paints a board word as its UI state with the board's own
 * label ("Next up", never a bare "queued"); and the dead `board` prop is
 * still accepted so 2.x call sites compile, while changing nothing.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { asPhaseState, Chip, chipVariants, StateChip } from './chip';

const first = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('Chip', () => {
  it('tone="warn" is the accent family — amber, a person is needed', () => {
    const { container } = render(<Chip tone="warn">gate open</Chip>);
    expect(first(container)).toHaveClass('text-accent');
  });

  it('tone="busy" is the live family', () => {
    const { container } = render(<Chip tone="busy">running</Chip>);
    expect(first(container)).toHaveClass('text-running');
  });

  it('gate and stuck also mean "a person" and share the accent', () => {
    expect(chipVariants({ tone: 'gate' })).toContain('text-accent');
    expect(chipVariants({ tone: 'stuck' })).toContain('text-accent');
    expect(chipVariants({ tone: 'bad' })).toContain('text-failed');
  });

  it('an unknown or absent tone is neutral, never a guess', () => {
    const { container } = render(<Chip>plain</Chip>);
    expect(first(container)).toHaveClass('text-ink-muted');
    expect(chipVariants()).toContain('text-ink-muted');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <p><Chip tone="warn" dot>gated</Chip> <Chip tone="ok" mono>ok</Chip></p>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('StateChip', () => {
  it('a ready phase reads "Next up" and wears the queued state', () => {
    const { container } = render(<StateChip state="ready" />);
    const chip = first(container);
    expect(chip).toHaveTextContent('Next up');
    expect(chip).toHaveClass('state-queued');
  });

  it('the 2.x board prop is accepted and changes nothing', () => {
    const { container: withBoard } = render(<StateChip state="ready" board />);
    const { container: without } = render(<StateChip state="ready" />);
    expect(first(withBoard).className).toBe(first(without).className);
    expect(first(withBoard).textContent).toBe(first(without).textContent);
  });

  it('an unknown engine word paints as waiting — never amber, never green', () => {
    const { container } = render(<StateChip state="halted-weirdly" />);
    expect(first(container)).toHaveClass('state-waiting');
    expect(asPhaseState('halted-weirdly')).toBe('waiting');
    expect(asPhaseState(undefined)).toBe('waiting');
    expect(asPhaseState('gated')).toBe('gated');
  });

  it('has no axe violations across the board words', async () => {
    const { container } = render(
      <p>
        {(['done', 'ready', 'in-progress', 'waiting', 'blocked', 'stuck', 'gated'] as const).map((s) => (
          <StateChip key={s} state={s} />
        ))}
      </p>,
    );
    await expectNoAxeViolations(container);
  });
});
