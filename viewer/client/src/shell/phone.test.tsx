/**
 * The two places a phone puts a number next to an icon.
 *
 * Both were drawing the count *on top of* the glyph it counts. Measured on a
 * 390px viewport: the bell is 18px wide at x 359–377 and its badge sat at
 * 366–386 — eleven pixels of overlap at a count of one, and at three digits the
 * badge grew left across the whole bell and right off the edge of the screen,
 * because it was pinned by its right edge.
 *
 * A badge is a decoration on the thing it counts; when it covers the thing it
 * counts it has stopped doing its job. These pin the two answers: the header
 * sets the count *beside* the bell, where nothing can overlap at any width, and
 * the tab bar keeps the corner idiom but caps the number so the badge stays a
 * circle instead of growing into the tab next door.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabBar, TopBar } from '@/shell/phone';
import type { ShellCounts } from '@/lib/queries';

vi.mock('@/router', () => ({ navigate: vi.fn() }));

const counts = (over: Partial<ShellCounts> = {}): ShellCounts => ({
  plans: 0, phases: 0, ready: 0, approvals: 0, unread: 0, agentSessions: 0, terminalSessions: 0,
  ...over,
});

describe('the notification count in the header', () => {
  it('sits beside the bell rather than on top of it', () => {
    render(
      <TopBar state={undefined} counts={counts({ unread: 4 })} head="dashboard" onPickSource={() => {}} />,
    );
    const bell = screen.getByRole('button', { name: /Notifications, 4 unread/ });
    const badge = within(bell).getByText('4');

    // Nothing between the badge and the button may take it out of the flow.
    for (let node = badge; node !== bell; node = node.parentElement!) {
      expect(node.className).not.toMatch(/\babsolute\b/);
    }
  });

  it('keeps three digits on the screen', () => {
    render(
      <TopBar state={undefined} counts={counts({ unread: 1284 })} head="dashboard" onPickSource={() => {}} />,
    );
    // Capped, and still the full figure to a screen reader.
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.getByRole('button', { name: /1284 unread/ })).toBeTruthy();
  });

  it('draws nothing at all when there is nothing unread', () => {
    render(
      <TopBar state={undefined} counts={counts()} head="dashboard" onPickSource={() => {}} />,
    );
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(bell.textContent).toBe('');
  });
});

describe('the counts in the tab bar', () => {
  it('caps the corner badge at 9+, so it cannot grow into the next tab', () => {
    render(<TabBar counts={counts({ ready: 42 })} head="dashboard" moreOpen={false} onMore={() => {}} />);
    expect(screen.getByText('9+')).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('rings the badge in the bar so the glyph reads out from under it', () => {
    render(<TabBar counts={counts({ ready: 3 })} head="dashboard" moreOpen={false} onMore={() => {}} />);
    const badge = screen.getByText('3');
    expect(badge.className).toMatch(/ring-ground-deep/);
    // And it never swallows the tap meant for the tab it decorates.
    expect(badge.parentElement!.className).toMatch(/pointer-events-none/);
  });
});
