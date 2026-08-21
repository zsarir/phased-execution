/**
 * Badge, CountBadge, Kbd — the small words and numbers. What these tests
 * hold: a Badge's tone is one of the vocabulary's tone families (accent is
 * the rationed amber, the default is honest grey), its dot is decoration;
 * a CountBadge renders NOTHING at zero unless asked (an empty "0" pill reads
 * as "something"), caps at `max+`, and — when it carries a label — is one
 * atomic named element whose name actually reaches assistive tech; a Kbd is
 * a real `<kbd>` so the shortcut reads as a key everywhere.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Badge } from './badge';
import { CountBadge } from './count-badge';
import { Kbd, KbdChord } from './kbd';

const first = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('Badge', () => {
  it('defaults to the neutral tone — grey, visibly unopinionated', () => {
    const { container } = render(<Badge>draft</Badge>);
    const badge = first(container);
    expect(badge).toHaveTextContent('draft');
    expect(badge).toHaveClass('text-ink-muted');
    expect(badge).not.toHaveClass('text-accent');
  });

  it('tone="accent" is the amber one', () => {
    const { container } = render(<Badge tone="accent">needs you</Badge>);
    expect(first(container)).toHaveClass('text-accent');
  });

  it('dot renders the leading dot as decoration', () => {
    const { container } = render(<Badge dot>live</Badge>);
    const dot = first(container).querySelector('[aria-hidden]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass('bg-current');
    const { container: plain } = render(<Badge>live</Badge>);
    expect(first(plain).querySelector('[aria-hidden]')).toBeNull();
  });

  it('has no axe violations in a sentence of badges', async () => {
    const { container } = render(
      <p>
        <Badge tone="accent" dot>needs you</Badge> <Badge tone="ok">green</Badge> <Badge mono>v2.3.0</Badge>
      </p>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('CountBadge', () => {
  it('renders nothing at zero — an empty pill reads as "something"', () => {
    const { container } = render(<CountBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('showZero shows the zero', () => {
    const { container } = render(<CountBadge count={0} showZero />);
    expect(first(container)).toHaveTextContent('0');
  });

  it('caps at max+', () => {
    const { container } = render(<CountBadge count={140} />);
    expect(first(container)).toHaveTextContent('99+');
    const { container: low } = render(<CountBadge count={140} max={9} />);
    expect(first(low)).toHaveTextContent('9+');
  });

  it('a label names what is counted, and the name reaches assistive tech', () => {
    const { container } = render(<CountBadge count={3} label="approvals waiting" />);
    const badge = first(container);
    expect(badge).toHaveAttribute('aria-label', '3 approvals waiting');
    // aria-label on a bare span is prohibited ARIA; the labelled pill is an
    // atomic named element, so it carries a role the label is allowed on.
    expect(badge).toHaveAttribute('role', 'img');
    expect(badge.querySelector('[aria-hidden="true"]')).toHaveTextContent('3');
  });

  it('an unlabelled count is plain text with no role and no dangling ARIA', () => {
    const { container } = render(<CountBadge count={7} />);
    const badge = first(container);
    expect(badge).not.toHaveAttribute('role');
    expect(badge).not.toHaveAttribute('aria-label');
  });

  it('has no axe violations, labelled and not', async () => {
    const { container } = render(
      <p>
        <CountBadge count={3} label="approvals waiting" tone="accent" />
        <CountBadge count={12} />
      </p>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Kbd', () => {
  it('renders a real <kbd>', () => {
    const { container } = render(<Kbd>K</Kbd>);
    const kbd = container.querySelector('kbd');
    expect(kbd).not.toBeNull();
    expect(kbd).toHaveTextContent('K');
  });

  it('KbdChord renders every key, separated by decoration only', () => {
    const { container } = render(<KbdChord keys={['⌘', 'K']} />);
    const keys = [...container.querySelectorAll('kbd')].map((k) => k.textContent);
    expect(keys).toEqual(['⌘', 'K']);
    const separator = container.querySelector('[aria-hidden]');
    expect(separator).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <p>Press <KbdChord keys={['g', 'r']} conjunction=" then " /> to jump.</p>,
    );
    await expectNoAxeViolations(container);
  });
});
