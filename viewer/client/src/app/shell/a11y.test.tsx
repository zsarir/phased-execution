/**
 * The shell, run through axe — at both widths and with every overlay open.
 *
 * The chrome is the one part of the app that is on screen on every page, so a
 * violation here is a violation everywhere, and it is exactly the kind that
 * survives a screenshot: an icon-only button with no name, a landmark declared
 * twice, a dialog with no title, a badge whose number is announced as a bare
 * number with nothing to say what it counts.
 *
 * jsdom lays nothing out, so contrast is not asked here — `styles/contrast.test
 * .ts` computes every (state, surface) pair from the stylesheet instead. What
 * axe can see without layout — names, roles, labels, ARIA validity, nesting —
 * is what this covers.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lazy, type ReactElement } from 'react';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import type { ConsoleState } from '@/lib/api';
import { queryClientConfig, type ShellCounts } from '@/lib/queries';
import { ShellLayout } from './layout';
import { Rail } from './rail';
import { TabBar } from './tab-bar';
import { MoreSheet } from './more-sheet';

const { state, notifications } = vi.hoisted(() => ({ state: vi.fn(), notifications: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, notifications } };
});

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowTerminal: true,
  allowAgent: true,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, label: 'repo', planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [{ path: '/other', label: 'other' }],
  unread: 7,
};

// Every badge lit: a count that renders nothing cannot fail a name check.
const COUNTS: ShellCounts = {
  plans: 3,
  phases: 11,
  ready: 2,
  approvals: 1,
  needsYou: 1,
  sessions: 4,
  unread: 7,
  agentSessions: 1,
  terminalSessions: 3,
  mcpAttention: 1,
};

const route = (hash = '#/now'): Route => parseHash(hash) as Route;

const mount = (ui: ReactElement) => {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouterProvider initial="#/now">{ui}</MemoryRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  notifications.mockResolvedValue({
    items: [],
    total: 0,
    unread: 0,
    more: false,
    categories: [],
    devices: 1,
    outOfBand: { configured: true },
  });
});

describe('the shell has no axe violations', () => {
  it('on a desktop — rail, header, one scroller', async () => {
    const { container } = mount(
      <ShellLayout state={STATE} counts={COUNTS} route={route()} phone={false}>
        <h1>Now</h1>
      </ShellLayout>,
    );
    await screen.findByRole('navigation', { name: 'Main' });
    await expectNoAxeViolations(container);
  });

  it('on a phone — header, one scroller, tab bar', async () => {
    const { container } = mount(
      <ShellLayout state={STATE} counts={COUNTS} route={route()} phone>
        <h1>Now</h1>
      </ShellLayout>,
    );
    await screen.findByRole('navigation', { name: 'Main' });
    await expectNoAxeViolations(container);
  });

  it('with the More sheet open', async () => {
    mount(
      <MoreSheet open onOpenChange={() => {}} state={STATE} counts={COUNTS} route={route()} head="now" />,
    );
    // Sheets portal to the body, so the whole document is the subject.
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
  });
});

describe('the navigation names itself', () => {
  it('gives the rail and the tab bar ONE landmark between them, never two', async () => {
    // Both carry `aria-label="Main"`; rendering both at once would announce two
    // main navigations to a screen reader, which is the failure a media query
    // hides from everyone who can see.
    const desktop = mount(
      <ShellLayout state={STATE} counts={COUNTS} route={route()} phone={false}>
        <h1>Now</h1>
      </ShellLayout>,
    );
    expect(await desktop.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(desktop.queryAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    desktop.unmount();

    const phone = mount(
      <ShellLayout state={STATE} counts={COUNTS} route={route()} phone>
        <h1>Now</h1>
      </ShellLayout>,
    );
    expect(phone.queryAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
  });

  it('names every destination, badge and all', async () => {
    mount(<Rail state={STATE} counts={COUNTS} head="now" />);
    for (const label of ['Now', 'Plans', 'Runs', 'Sessions', 'Insights', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) }), label).toBeTruthy();
    }
  });

  it('gives the icon-only tab-bar buttons a readable name', async () => {
    const { container } = mount(
      <TabBar state={STATE} counts={COUNTS} head="now" moreOpen={false} onMore={() => {}} />,
    );
    await expectNoAxeViolations(container);
    // The glyph is `aria-hidden`, so the word beside it is the whole name.
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The three jobs a hash router has to do by hand
 * ------------------------------------------------------------------ */

describe('a hash change is a navigation, and is treated as one', () => {
  it('offers a skip link as the first focusable thing on the page', async () => {
    mount(<ShellLayout state={STATE} counts={COUNTS} route={route()} phone={false} children={null} />);
    const skip = await screen.findByRole('link', { name: /skip to content/i });
    // Visually hidden until focused — `sr-only` plus a `focus:not-sr-only`
    // escape. A skip link that is always visible is the one everybody deletes.
    expect(skip.className).toContain('sr-only');
    expect(skip.className).toContain('focus:not-sr-only');
    expect(skip.getAttribute('href')).toBe('#main');
  });

  it('moves focus into the page it lands on, and says where it is', async () => {
    const { RouteFrame } = await import('./route-frame');
    const Page = lazy(async () => ({ default: () => <p>the page</p> }));

    function Harness({ path }: { path: string }) {
      return (
        <>
          <main id="main" tabIndex={-1}>
            <RouteFrame view={Page} route={parseHash(`#/${path}`) as Route} />
          </main>
        </>
      );
    }

    const { rerender } = mount(<Harness path="now" />);
    await screen.findByText('the page');
    // Nothing on the FIRST paint: nothing was navigated from, and stealing
    // focus on load is noise on top of the page the reader just opened.
    expect(document.activeElement).not.toBe(document.querySelector('main'));

    rerender(
      <QueryClientProvider client={new QueryClient(queryClientConfig)}>
        <TooltipProvider>
          <MemoryRouterProvider initial="#/insights">
            <Harness path="insights" />
          </MemoryRouterProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('main')));
    // And a screen reader is told, politely, which destination this is.
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Insights');
  });

  it('names the destination and where in it, never the raw hash', async () => {
    const { routeAnnouncement } = await import('./route-frame');
    expect(routeAnnouncement(parseHash('#/now') as Route)).toBe('Now');
    expect(routeAnnouncement(parseHash('#/settings/automation') as Route)).toBe('Settings, automation');
    // A head that is not itself a destination still announces the one it
    // belongs under — the same mapping that keeps the nav lit.
    expect(routeAnnouncement(parseHash('#/plan/demo/route') as Route)).toBe('Plans, demo route');
  });
});
