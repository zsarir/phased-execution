/**
 * The phone shell's keyboard and scroll contracts, at the App level.
 *
 * Phone/touch is faked via vi.mock('@/lib/media') — the only mechanism that
 * works (matchMedia answers are cached module-level; see guide.test.tsx).
 * Kept separate from app.test.tsx, whose suites all describe the desktop.
 */

import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

import { App } from '@/App';
import type { ConsoleState } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';

const { state } = vi.hoisted(() => ({ state: vi.fn() }));

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

beforeEach(() => {
  vi.clearAllMocks();
  // The home page itself, not a redirect into it: `#/ready` became one in
  // Phase 8, and a shell test that starts mid-navigation is a shell test with
  // an extra render nobody asked for.
  window.location.hash = '#/now';
  state.mockResolvedValue(READY_STATE);
});

describe('the phone shell', () => {
  it('hides the tab bar while a SOFTWARE keyboard is up — focus AND the viewport giving up room — and brings it back on blur', async () => {
    // A mutable visual viewport, installed before the shell mounts: the
    // shell mirrors it into --app-height and reads the keyboard's share.
    const listeners = new Set<() => void>();
    const vv = {
      height: 844,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener: (_type: string, fn: () => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: () => void) => {
        listeners.delete(fn);
      },
      fire: () => {
        for (const fn of listeners) fn();
      },
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    mount();
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await act(async () => {
      await frame();
    });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    // Focus alone is a hardware keyboard, or a field on a desktop: the tab
    // bar stays. (This used to hide it — and hid it for a Bluetooth keyboard.)
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();

    // The software keyboard opens: the visual viewport shrinks by ~300px.
    vv.height = 520;
    await act(async () => {
      vv.fire();
      await frame();
    });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      vv.height = 844;
      vv.fire();
      await frame();
    });
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    textarea.remove();
  });

  it('resets the one scroller to the top when the route changes', async () => {
    mount();
    const main = (await screen.findByRole('main')) as HTMLElement & { __scrollToCalls?: unknown[][] };
    const before = main.__scrollToCalls?.length ?? 0;

    await act(async () => {
      window.location.hash = '#/plans';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const calls = main.__scrollToCalls ?? [];
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)).toEqual([0, 0]);
  });
});

describe('full-height routes', () => {
  it('terminal gets a non-scrolling flex main; plans keeps the one page scroller', async () => {
    window.location.hash = '#/terminal';
    mount();
    const main = await screen.findByRole('main');
    expect(main.className).toContain('overflow-hidden');
    expect(main.className).not.toContain('overflow-y-auto');

    await act(async () => {
      window.location.hash = '#/plans';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect((await screen.findByRole('main')).className).toContain('overflow-y-auto');
  });
});
