/**
 * The write menu — ported from `views/views.test.tsx` when Phase 11 deleted
 * `views/`.
 *
 * The one property worth a file of its own: **it is gated on
 * `state.allowWrites`.** It shells out to scripts, so a menu that renders its
 * buttons on a read-only console offers actions that will 403 and — worse —
 * reads as though the console can do them. Everything else here is about the
 * dry run: nothing may fire before the exact command has been shown.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { ConsoleState, PlanDetail } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * One api mock for every view under test.
 * ------------------------------------------------------------------ */

// `vi.hoisted`, not plain `const`: a `vi.mock` factory is hoisted above every
// declaration in the file, so a top-level `const` it closes over is in its
// temporal dead zone when the factory runs. The failure reads as "Cannot access
// 'state' before initialization" from inside an unrelated module.
const { state, search, runs, notifications, browse, checkRoot, write, run, queue, runScopes } = vi.hoisted(
  () => ({
    state: vi.fn(),
    search: vi.fn(),
    runs: vi.fn(),
    notifications: vi.fn(),
    browse: vi.fn(),
    checkRoot: vi.fn(),
    write: vi.fn(),
    run: vi.fn(),
    queue: vi.fn(),
    runScopes: vi.fn(),
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      search,
      runs,
      notifications,
      browse,
      checkRoot,
      write,
      run,
      queue,
      runScopes,
      plans: vi.fn(async () => []),
      stats: vi.fn(async () => null),
      approvals: vi.fn(async () => []),
      auth: vi.fn(async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' })),
      runTranscript: vi.fn(async () => []),
      policy: vi.fn(async () => {
        throw new Error('no policy endpoint');
      }),
      restartReadiness: vi.fn(async () => {
        throw new Error('no restart endpoint');
      }),
      push: vi.fn(async () => ({ publicKey: 'k', devices: [], categories: [] })),
    },
  };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'not-built',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(BASE_STATE);
  search.mockResolvedValue({ query: '', total: 0, groups: [] });
  runs.mockResolvedValue([]);
  notifications.mockResolvedValue({
    items: [],
    total: 0,
    unread: 0,
    more: false,
    categories: [],
    devices: 0,
    outOfBand: { configured: false },
  });
  browse.mockResolvedValue({ path: '/repo', parent: '/', entries: [] });
  checkRoot.mockResolvedValue({
    path: '/repo',
    ok: false,
    label: 'repo',
    planCount: 0,
    handoffCount: 0,
    reason: 'No docs/plans directory here',
  });
  write.mockResolvedValue({ dryRun: true, command: 'new-handoff.sh demo 2 x complete' });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  queue.mockResolvedValue({ max: 3, live: 0, queued: 0, throttledUntil: null, grants: [], entries: [] });
  runScopes.mockResolvedValue({ scopes: [] });
  // Browser-local and therefore sticky across cases in this file: a test that
  // opens the runs console would otherwise leave it open for the next one.
  setPrefs({ runsConsole: false });
  window.location.hash = '';
});
/* ------------------------------------------------------------------ *
 * The write menu — the carry-forward this phase owed
 * ------------------------------------------------------------------ */

const DETAIL = {
  summary: { slug: 'demo', title: 'demo plan', kind: 'plan', phases: 3, ready: [2] },
  plan: { path: '/repo/docs/plans/demo.md' },
  phases: [],
} as unknown as PlanDetail;

const PHASE = {
  phase: 2,
  title: 'the thing',
  state: 'ready',
  size: 'M',
  weight: 40_000,
  gated: false,
  bullets: [],
};

describe('the write menu', () => {
  it('renders nothing in a header when writes are off', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    const { container } = mount(<WriteMenu detail={DETAIL} allowWrites={false} />);
    expect(container.textContent).toBe('');
  });

  it('says what --allow-writes would give you when it is inline and off', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} phase={PHASE as never} allowWrites={false} inline />);
    expect(screen.getByText(/--allow-writes/)).toBeTruthy();
  });

  it('offers the phase verbs when writes are on', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} phase={PHASE as never} allowWrites inline />);
    expect(screen.getByRole('button', { name: 'Scaffold handoff' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record QA' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim phase' })).toBeTruthy();
  });

  it('offers Release rather than Claim while a live lock is held', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(
      <WriteMenu
        detail={DETAIL}
        phase={{ ...PHASE, lock: { owner: 'someone', expired: false } } as never}
        allowWrites
        inline
      />,
    );
    expect(screen.getByRole('button', { name: 'Release lock' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim phase' })).toBeNull();
  });

  it('treats an expired lock as claimable', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(
      <WriteMenu
        detail={DETAIL}
        phase={{ ...PHASE, lock: { owner: 'someone', expired: true } } as never}
        allowWrites
        inline
      />,
    );
    expect(screen.getByRole('button', { name: 'Claim phase' })).toBeTruthy();
  });

  it('shows the exact command as a dry run before anything can be pressed', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} phase={PHASE as never} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Scaffold handoff' }));

    await waitFor(() => expect(write).toHaveBeenCalled());
    // The second argument is the dry-run flag. It is the whole safety property
    // of this dialog: nothing runs to produce the preview.
    expect(write.mock.calls[0][1]).toBe(true);
    expect(await screen.findByText(/new-handoff\.sh demo 2/)).toBeTruthy();
  });

  it('keeps Run disabled until a required field is filled', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} phase={PHASE as never} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Scaffold handoff' }));

    const run = await screen.findByRole('button', { name: 'Run' });
    expect(run.hasAttribute('disabled')).toBe(true);
  });

  /* ---------------- closing and reopening ----------------
   * The plan-level action list was empty until this existed. Only one direction
   * is ever offered: they are the two ends of one switch, and showing both
   * would make you read the plan's status off some other part of the page to
   * know which one applies. */

  const CLOSED = {
    ...DETAIL,
    summary: { ...DETAIL.summary, status: 'abandoned', closed: true },
  } as unknown as PlanDetail;

  it('offers Close on an open plan and Reopen on a closed one, never both', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    const open = mount(<WriteMenu detail={DETAIL} allowWrites />);
    expect(screen.getByRole('button', { name: 'Close plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reopen plan' })).toBeNull();
    open.unmount();

    mount(<WriteMenu detail={CLOSED} allowWrites />);
    expect(screen.getByRole('button', { name: 'Reopen plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close plan' })).toBeNull();
  });

  it('asks for a reason before it will close anything', async () => {
    // The server refuses a reasonless close, and a status select alone would
    // leave a closed plan that tells the next reader nothing.
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));

    expect(await screen.findByRole('button', { name: 'Run' })).toHaveAttribute('disabled');
    // `active` is not on the menu — reopening is its own verb, not a status.
    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['abandoned', 'superseded', 'complete']);
  });

  it('previews the real close-plan.sh invocation before anything runs', async () => {
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    fireEvent.change(await screen.findByPlaceholderText(/superseded by/), {
      target: { value: 'the approach did not survive contact' },
    });

    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls.at(-1)![1]).toBe(true); // dry run, always
    expect(write.mock.calls.at(-1)![0]).toMatchObject({
      action: 'close-plan',
      slug: 'demo',
      status: 'abandoned',
      reason: 'the approach did not survive contact',
    });
  });

  it('confirms a reopen rather than firing it on one press', async () => {
    // One small button on this side; on the other, the plan reappears on the
    // ready board, in the nav badge and in the dashboard's recommendation.
    const { WriteMenu } = await import('@/components/write-menu');
    mount(<WriteMenu detail={CLOSED} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen plan' }));

    expect(await screen.findByText('Reopen this plan?')).toBeTruthy();
    expect(write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: 'reopen-plan', slug: 'demo' }));
  });
});
