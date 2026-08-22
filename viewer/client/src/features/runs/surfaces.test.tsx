/**
 * The Runs ledger and the run page, mounted against a whole-API mock — ported
 * from `views/views.test.tsx` when Phase 11 deleted `views/`.
 *
 * These cases are about the SHELL of those two surfaces: what the header says
 * when nothing is running, that every run links to its own tab, that a queued
 * phase says what it is behind. Per-component behaviour lives beside each
 * component in the other `features/runs/*.test.tsx` files.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { ConsoleState, PlanDetail, RunState } from '@/lib/api';

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

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const RUN = {
  id: 'abc123',
  slug: 'demo',
  root: '/repo',
  status: 'finished',
  autonomy: 'keep-going',
  model: 'opus',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 1.65,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T01:00:00Z',
  activePhase: null,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: {},
} as unknown as RunState;

describe('runs', () => {
  it('explains a stale server rather than showing a wall of failed requests', async () => {
    state.mockResolvedValue({ ...BASE_STATE, autopilot: false });
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);
    expect(await screen.findByText(/older build/i)).toBeTruthy();
    expect(runs).not.toHaveBeenCalled();
  });

  it('says nothing is running rather than leaving the subtitle empty', async () => {
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);
    expect(await screen.findByText(/Nothing running right now/i)).toBeTruthy();
  });

  it('lists every run with a link into its own autopilot tab', async () => {
    runs.mockResolvedValue([RUN]);
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    const link = await screen.findByRole('link', { name: 'demo' });
    expect(link.getAttribute('href')).toBe('#/plan/demo/run');
    const row = link.closest('tr')!;
    expect(within(row).getByText('$1.65')).toBeTruthy();
    expect(within(row).getByText('finished')).toBeTruthy();
  });

  it('names the live run in the header when there is one', async () => {
    runs.mockResolvedValue([{ ...RUN, status: 'running', activePhase: 3 }]);
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);
    expect(await screen.findByText(/demo is running — phase 3/i)).toBeTruthy();
  });

  /**
   * Issue #7: this page is about every run there has ever been, and its console
   * could reach exactly one session. With two plans live it showed one of them
   * and gave no sign the other existed.
   */
  it('reaches every live session across plans as its own tab', async () => {
    runs.mockResolvedValue([
      { ...RUN, id: 'r1', slug: 'alpha', status: 'running', activePhase: 5, phases: RECORDS(5) },
      { ...RUN, id: 'r2', slug: 'beta', status: 'running', activePhase: 2, phases: RECORDS(2) },
    ]);
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['alphaP5', 'betaP2']);
  });

  it('keeps the single console for a finished run, which has no lane', async () => {
    // The fallback is not dead code: a run you picked to re-read has no session
    // to tab to, and neither does a page with nothing running at all.
    runs.mockResolvedValue([RUN]);
    const { default: RunsView } = await import('@/features/runs');
    setPrefs({ runsConsole: true });
    mount(<RunsView />);

    expect(await screen.findByRole('log', { name: 'Session console' })).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The autopilot page — one window per session
 * ------------------------------------------------------------------ */

/** Phase records, keyed by the phase number **as a string**. */
const RECORDS = (...live: number[]) =>
  Object.fromEntries(
    live.map((phase) => [String(phase), { phase, status: 'running', attempts: 1, costUsd: 0 }]),
  );

const PLAN_PHASES = [
  {
    phase: 1,
    title: 'the api',
    state: 'ready',
    size: 'M',
    weight: 40_000,
    gated: false,
    bullets: [],
    row: {
      phase: 1,
      title: 'the api',
      dependsOn: [],
      parallelSafe: '',
      repos: 'packages/cart-api',
      exitCriteria: '',
    },
  },
  {
    phase: 2,
    title: 'the docs',
    state: 'waiting',
    size: 'S',
    weight: 15_000,
    gated: false,
    bullets: [],
    row: { phase: 2, title: 'the docs', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
  },
];

const planDetail = () => ({ ...DETAIL, phases: PLAN_PHASES }) as unknown as PlanDetail;

describe('the autopilot page', () => {
  it('gives every live and queued phase a tab of its own, beside the run', async () => {
    run.mockResolvedValue({
      run: {
        ...RUN,
        status: 'running',
        activePhase: 1,
        phases: {
          ...RECORDS(1),
          2: { phase: 2, status: 'queued', attempts: 0, costUsd: 0 },
        },
      },
      history: [],
      eta: null,
    });
    queue.mockResolvedValue({
      max: 3,
      live: 1,
      queued: 1,
      throttledUntil: null,
      grants: [],
      entries: [
        {
          id: 'q1',
          slug: 'demo',
          phase: 2,
          runId: 'abc123',
          scope: ['hub-docs'],
          since: Date.now(),
          bypassed: 0,
          reserving: false,
          waitingOn: [
            {
              kind: 'grant',
              slug: 'other-plan',
              phase: 4,
              owner: 'claude-a/x',
              scope: ['hub-docs'],
              overlaps: ['hub-docs'],
            },
          ],
        },
      ],
    });

    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    // The count on Run is the lane count — the one number that says "there is
    // more than one thing happening" without opening anything.
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Run2', 'Phase 1', 'Phase 2queued']);
  });

  it('points the ask box at the tab you are on, not at whatever is active', async () => {
    // The whole reason to open a lane's tab is to talk to THAT session. An ask
    // box that silently addressed `activePhase` would send it to another one.
    run.mockResolvedValue({
      run: { ...RUN, status: 'running', activePhase: 1, phases: RECORDS(1, 2) },
      history: [],
      eta: null,
    });
    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('tab', { name: 'Phase 2' }));
    await waitFor(() => expect(screen.getByPlaceholderText(/ask the session running phase 2/i)).toBeTruthy());
  });

  it('says what a queued phase is behind rather than just that it is queued', async () => {
    run.mockResolvedValue({
      run: {
        ...RUN,
        status: 'running',
        phases: { 2: { phase: 2, status: 'queued', attempts: 0, costUsd: 0 } },
      },
      history: [],
      eta: null,
    });
    queue.mockResolvedValue({
      max: 3,
      live: 0,
      queued: 1,
      throttledUntil: null,
      grants: [],
      entries: [
        {
          id: 'q1',
          slug: 'demo',
          phase: 2,
          runId: 'abc123',
          scope: ['hub-docs'],
          since: Date.now(),
          bypassed: 0,
          reserving: false,
          waitingOn: [
            {
              kind: 'grant',
              slug: 'other-plan',
              phase: 4,
              owner: 'claude-a/x',
              scope: ['hub-docs'],
              overlaps: ['hub-docs'],
            },
          ],
        },
      ],
    });

    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    // On the row, and again in the pane behind the tab — both from one reading.
    expect(await screen.findByText('queued — waiting on other-plan P4')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Phase 2/ }));
    await waitFor(() => expect(screen.getByText('Phase 2 is queued')).toBeTruthy());
  });

  /** Issue #17: the Repos cell has been parsed since before there was concurrency. */
  it('shows what each phase touches, and calls a blank cell what it is', async () => {
    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    const row = (await screen.findByRole('link', { name: 'the api' })).closest('tr')!;
    expect(within(row).getByText('packages/cart-api')).toBeTruthy();

    // A blank Repos cell is `all` — the phase might touch anything, which is why
    // it runs alone. Rendering it as an empty cell hid the reason.
    const blank = screen.getByRole('link', { name: 'the docs' }).closest('tr')!;
    expect(within(blank).getByText('all')).toBeTruthy();
  });
});
