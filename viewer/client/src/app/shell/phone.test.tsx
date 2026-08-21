/**
 * The two places a phone puts a number next to an icon.
 *
 * Both were drawing the count *on top of* the glyph it counts. Measured on a
 * 390px viewport: the bell was 18px wide at x 359–377 and its badge sat at
 * 366–386 — eleven pixels of overlap at a count of one, and at three digits the
 * badge grew left across the whole bell and right off the edge of the screen,
 * because it was pinned by its right edge.
 *
 * A badge is a decoration on the thing it counts; when it covers the thing it
 * counts it has stopped doing its job. These pin the two answers, which survived
 * the 3.0 rebuild intact: the header sets the count *beside* the bell, where
 * nothing can overlap at any width, and the tab bar keeps the corner idiom but
 * caps the number so the badge stays a circle instead of growing into the tab
 * next door.
 */

import { render as renderBare, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { Header } from './header';
import { TabBar } from './tab-bar';

// The header carries the usage meters and the project switcher, which read the
// accounts and state queries — so the harness provides a client the way
// `app.test.tsx` does. `retry: false` keeps a missing mock from stalling a test
// on retries. `MemoryRouterProvider` keeps every tap out of the address bar.
const render = (ui: ReactElement) =>
  renderBare(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouterProvider initial="#/now">{ui}</MemoryRouterProvider>
    </QueryClientProvider>,
  );

const route = (hash = '#/now'): Route => parseHash(hash) as Route;

const counts = (over: Partial<ShellCounts> = {}): ShellCounts => ({
  plans: 0,
  phases: 0,
  ready: 0,
  approvals: 0,
  needsYou: 0,
  sessions: 0,
  unread: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
  ...over,
});

const SESSIONS_ON: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  allowTerminal: true,
  allowAgent: true,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 0, handoffCount: 0 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 0,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

describe('the announcement count in the header', () => {
  it('sits beside the bell rather than on top of it', () => {
    render(
      <Header state={undefined} counts={counts({ unread: 4 })} route={route()} phone slotRef={() => {}} />,
    );
    const bell = screen.getByRole('button', { name: /Announcements, 4 unread/ });
    const badge = within(bell).getByText('4');

    // Nothing between the badge and the button may take it out of the flow.
    for (let node = badge; node !== bell; node = node.parentElement!) {
      expect(node.className).not.toMatch(/\babsolute\b/);
    }
  });

  it('keeps three digits on the screen', () => {
    render(
      <Header state={undefined} counts={counts({ unread: 1284 })} route={route()} phone slotRef={() => {}} />,
    );
    // Capped, and still the full figure to a screen reader.
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.getByRole('button', { name: /1284 unread/ })).toBeTruthy();
  });

  it('draws nothing at all when there is nothing unread', () => {
    render(<Header state={undefined} counts={counts()} route={route()} phone slotRef={() => {}} />);
    expect(screen.getByRole('button', { name: 'Announcements' }).textContent).toBe('');
  });
});

describe('the counts in the tab bar', () => {
  const bar = (over: Partial<ShellCounts>) =>
    render(
      <TabBar state={SESSIONS_ON} counts={counts(over)} head="now" moreOpen={false} onMore={() => {}} />,
    );

  it('caps the corner badge at 9+, so it cannot grow into the next tab', () => {
    bar({ ready: 42 });
    expect(screen.getByText('9+')).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('rings the badge in the bar so the glyph reads out from under it', () => {
    bar({ ready: 3 });
    const badge = screen.getByText('3');
    expect(badge.className).toMatch(/ring-ground-deep/);
    // And it never swallows the tap meant for the tab it decorates.
    expect(badge.parentElement!.className).toMatch(/pointer-events-none/);
  });

  it('offers Now, Plans, Runs, Sessions and More — and marks where you are', () => {
    bar({});
    for (const label of ['Now', 'Plans', 'Runs', 'Sessions', 'More']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}$`) }), label).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Now' }).getAttribute('aria-current')).toBe('page');
  });

  it('lights Sessions for a terminal deep link, not Now', () => {
    // The 2.x bar had no Sessions entry at all, so `#/terminal/abc` lit nothing
    // and the app read as though you had left it.
    render(
      <TabBar state={SESSIONS_ON} counts={counts()} head="terminal" moreOpen={false} onMore={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Now' }).getAttribute('aria-current')).toBeNull();
  });
});
