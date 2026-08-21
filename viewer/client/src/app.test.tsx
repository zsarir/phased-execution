/**
 * What the app is when the console is not there.
 *
 * This only became a question in Phase 7. Before the shell was precached, a
 * console you could not reach was a browser error page — ugly, but unambiguous.
 * Now the app loads from the device and has to say so itself, and the way that
 * goes wrong is not a crash: it is a board rendered from whatever was in memory,
 * looking exactly like a live one. Every number on it is a claim about a
 * repository that sessions are editing right now.
 *
 * So the rule these pin is narrow and absolute: **no board without a server.**
 * The app is allowed to show its own name, an explanation, and a way to try
 * again. It is not allowed to show a phase status.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import type { ConsoleState } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';

const { state } = vi.hoisted(() => ({ state: vi.fn() }));

// `vi.hoisted` for the same reason `views.test.tsx` needs it: the factory below
// is hoisted above every `const` in this file.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      plans: vi.fn(async () => []),
      stats: vi.fn(async () => null),
      approvals: vi.fn(async () => []),
      // The palette is shell chrome now and asks for the fleet by name.
      runs: vi.fn(async () => []),
    },
  };
});

const READY_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

function mount() {
  // `retry: false` so a rejected query settles in one tick; the app's own
  // config retries once, which only makes these slower.
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const setOnline = (value: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
};

/**
 * A fetch failure, the way `fetch` actually produces one: a NEW Error object
 * every call. `mockRejectedValue(new TypeError(...))` reuses a single instance,
 * and that difference is not cosmetic — code that keys off the error's identity
 * behaves completely differently against the two. It is what let the refetch
 * loop below pass as a green test.
 */
const failsFreshly = (message = 'Failed to fetch') =>
  state.mockImplementation(() => Promise.reject(new TypeError(message)));

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/now';
  setOnline(true);
});

describe('the console cannot be reached', () => {
  it('says the device is offline, in those words, when it is', async () => {
    setOnline(false);
    failsFreshly();
    mount();

    expect(await screen.findByRole('heading', { name: /you're offline/i })).toBeInTheDocument();
    // The app still names itself: this is the console, loaded from the device,
    // not a browser error page.
    expect(screen.getByText('Phase Console')).toBeInTheDocument();
  });

  it('distinguishes a dead server from a dead network', async () => {
    setOnline(true);
    failsFreshly('500');
    mount();

    // Being on a network and being able to reach the console are different
    // facts, and only one of them is worth restarting anything over.
    expect(await screen.findByRole('heading', { name: /not answering/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /you're offline/i })).not.toBeInTheDocument();
  });

  it('shows no board at all — not one phase, not one count', async () => {
    setOnline(false);
    failsFreshly();
    mount();
    await screen.findByRole('heading', { name: /you're offline/i });

    // The whole point. A cached board is indistinguishable from a live one and
    // wrong within a minute.
    for (const nav of ['Now', 'Plans', 'Runs', 'Sessions', 'Insights', 'Settings']) {
      expect(screen.queryByRole('button', { name: new RegExp(nav, 'i') })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: new RegExp(nav, 'i') })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/would be out of date/i)).toBeInTheDocument();
  });

  it('does not hammer a console that is not there', async () => {
    // The bug this exists for, found in a browser and not by any of the tests
    // above it: retrying whenever `online && error` re-fires on every failure,
    // because each failure is a *new* Error object. It produced a request every
    // millisecond and — worse — a permanent boot spinner, since the query was
    // always mid-retry and never settled into the error state the offline
    // screen renders from. The retry belongs on the offline→online transition.
    setOnline(true);
    failsFreshly();
    mount();
    await screen.findByRole('heading', { name: /not answering/i });

    const settled = state.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(state.mock.calls.length).toBe(settled);
    // And it is still showing the screen, not a spinner.
    expect(screen.getByRole('heading', { name: /not answering/i })).toBeInTheDocument();
  });

  it('explains itself with the underlying failure, quietly', async () => {
    failsFreshly('NetworkError when attempting to fetch resource.');
    mount();
    expect(await screen.findByText(/NetworkError when attempting/)).toBeInTheDocument();
  });

  it('comes back when the console does, without a reload', async () => {
    failsFreshly();
    mount();
    const retry = await screen.findByRole('button', { name: /try again/i });

    state.mockResolvedValue(READY_STATE);
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /you're offline/i })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: 'Now' })).toBeInTheDocument();
  });

  it('asks again by itself the moment the network returns', async () => {
    setOnline(false);
    failsFreshly();
    mount();
    await screen.findByRole('heading', { name: /you're offline/i });
    const asked = state.mock.calls.length;

    state.mockResolvedValue(READY_STATE);
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(state.mock.calls.length).toBeGreaterThan(asked));
    expect(await screen.findByRole('button', { name: 'Now' })).toBeInTheDocument();
  });
});

describe('the network drops while the board is up', () => {
  it('labels what is on screen as no longer updating', async () => {
    state.mockResolvedValue(READY_STATE);
    mount();
    await screen.findByRole('button', { name: 'Now' });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    // The board stays — it was true when it was fetched — but it stops being
    // presented as live, which is the only dishonest option here.
    expect(await screen.findByText(/no longer updating/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Now' })).toBeInTheDocument();
  });
});
