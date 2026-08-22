/**
 * The home page, assembled.
 *
 * Three properties that are invisible until they are wrong:
 *
 *  - **the band order is the urgency order.** Needs you, then what is running,
 *    then what is next, then the shape of the portfolio. On a phone the bands
 *    simply stack, so the order in the DOM IS the order on the screen — which
 *    is why it is asserted as a document order rather than as four separate
 *    "is it on screen" checks.
 *  - **first paint fans out to nothing.** The per-plan detail is one engine
 *    invocation each; the page must read the shell's own queries and then
 *    upgrade. Sixty-five reads to fill a screen nobody scrolls is the trade
 *    this page exists to refuse.
 *  - **the four addresses it absorbed still mean what they meant.** `#/ready`
 *    was never "the home page", it was the part of it about what to start.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, redirectTarget, type Route } from '@/app/routes';
import { queryClientConfig } from '@/lib/queries';

const api = vi.hoisted(() => ({
  state: vi.fn(),
  plans: vi.fn(),
  plan: vi.fn(),
  runs: vi.fn(),
  approvals: vi.fn(),
  spend: vi.fn(),
  converge: vi.fn(),
  auth: vi.fn(),
  sessionRegistry: vi.fn(),
  stats: vi.fn(),
  inbox: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...api } };
});

const PLAN = {
  slug: 'demo',
  title: 'Demo plan',
  kind: 'plan',
  activity: Date.now(),
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [4],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [],
  mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
};

const RUN = {
  id: 'r1',
  slug: 'demo',
  root: '/tmp/demo',
  status: 'running',
  autonomy: 'keep-going',
  model: 'opus',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 3,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  activePhase: 4,
  child: { pid: 1, phase: 4, sessionId: 's4', startedAt: new Date(Date.now() - 600_000).toISOString() },
  children: {
    '4': { pid: 1, phase: 4, sessionId: 's4', startedAt: new Date(Date.now() - 600_000).toISOString() },
  },
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: { '4': { phase: 4, status: 'running', attempts: 1, costUsd: 1.5 } },
};

const ITEM = {
  id: 'approval:demo:4:r1:a1',
  kind: 'approval',
  severity: 'urgent',
  slug: 'demo',
  phase: 4,
  runId: 'r1',
  title: 'A session is waiting on a decision',
  need: 'A session is parked until you answer.',
  how: 'Allow it or deny it.',
  since: new Date(Date.now() - 120_000).toISOString(),
  href: '#/plan/demo/run',
  actions: [
    {
      verb: 'allow',
      label: 'Allow',
      endpoint: '/api/approvals/a1',
      method: 'POST',
      body: { decision: 'allow' },
    },
    {
      verb: 'deny',
      label: 'Deny',
      endpoint: '/api/approvals/a1',
      method: 'POST',
      body: { decision: 'deny' },
    },
  ],
};

const route = (hash: string): Route => parseHash(hash) as Route;

async function mount(hash = '#/now') {
  const { default: NowView } = await import('./index');
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash}>
        <NowView route={route(hash)} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.state.mockResolvedValue({
    allowRun: true,
    allowWrites: true,
    autopilot: true,
    unread: 0,
    instance: { name: 'hub' },
    root: { ok: true, label: 'hub', path: '/tmp/hub' },
    repo: { available: true, branch: 'main' },
  });
  api.plans.mockResolvedValue([PLAN]);
  api.plan.mockResolvedValue({
    summary: PLAN,
    phases: [
      {
        phase: 2,
        title: 'Wire the ingest',
        state: 'ready',
        size: 'M',
        weight: 40_000,
        gated: false,
        bullets: [],
        analysis: { unblocks: 3, onCriticalPath: true, weight: 40_000 },
      },
    ],
    route: { nodes: [], edges: [], layers: 0, rows: 0 },
  });
  api.runs.mockResolvedValue([RUN]);
  api.approvals.mockResolvedValue([]);
  api.spend.mockResolvedValue({ today: { settledUsd: 12, ladderUsd: 3, capUsd: 100 }, runs: [], series: [] });
  api.converge.mockResolvedValue({
    automatic: true,
    everyMs: 900_000,
    pending: [],
    running: [],
    reports: [],
  });
  api.auth.mockResolvedValue({ loggedIn: true });
  api.sessionRegistry.mockResolvedValue({ sessions: [] });
  api.stats.mockResolvedValue({ totals: { percent: 42 }, velocity: [], stalled: [] });
  api.inbox.mockResolvedValue({ items: [ITEM], generatedAt: new Date().toISOString() });
});

describe('the page', () => {
  it('answers the four questions in the order it costs to ignore them', async () => {
    const { container } = await mount();
    await screen.findByTestId('needs-you');
    const order = [...container.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) =>
        ['header-strip', 'needs-you', 'live-lanes', 'next-up', 'plans-in-flight'].includes(id!),
      );
    expect(order).toEqual(['header-strip', 'needs-you', 'live-lanes', 'next-up', 'plans-in-flight']);
  });

  it('leads the strip with what is running, what needs a person, and today against the cap', async () => {
    await mount();
    const strip = await screen.findByTestId('header-strip');
    expect(strip.textContent).toContain('hub');
    expect(strip.textContent).toContain('main');
    // $12 settled + $3 the ladder spent, against the $100 cap — the CAP's own
    // arithmetic, not the sum of what the rows on screen have spent.
    await waitFor(() => expect(strip.textContent).toContain('$15.00'));
    expect(strip.textContent).toContain('$100.00');
    expect(strip.textContent).toContain('42% of everything');
    // One live lane, one urgent inbox row.
    expect(strip.textContent).toContain('1running');
    expect(strip.textContent).toContain('1need you');
  });

  it('renders the inbox row the server sent, with its own remedies', async () => {
    await mount();
    expect(await screen.findByText('A session is waiting on a decision')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
  });

  it('draws the live lane, and the ready phase under Next up', async () => {
    await mount();
    const lane = await screen.findByTestId('lane-row');
    expect(lane.textContent).toContain('phase 4');
    await waitFor(() => expect(screen.getByTestId('next-up').textContent).toContain('Wire the ingest'));
  });

  it('fans out to the plans that HAVE something, not to every plan', async () => {
    api.plans.mockResolvedValue([
      PLAN,
      { ...PLAN, slug: 'idle', ready: [], inProgress: [], done: 4, phases: 4, activity: 0 },
    ]);
    await mount();
    await screen.findByTestId('needs-you');
    await waitFor(() => expect(api.plan).toHaveBeenCalled());
    // `idle` is finished and has nothing ready: no strip, no lane, no row —
    // and therefore no engine invocation.
    expect(api.plan.mock.calls.map((call) => call[0])).not.toContain('idle');
  });

  it('says a server too old for the inbox cannot tell you, rather than "all clear"', async () => {
    const { ApiError } = await import('@/lib/api');
    api.inbox.mockRejectedValue(new ApiError('not found', 404, '/api/inbox'));
    await mount();
    expect(await screen.findByText('This server has no inbox')).toBeTruthy();
  });
});

describe('the addresses it absorbed', () => {
  it('keeps what each of the four old URLs MEANT', () => {
    expect(redirectTarget(route('#/dashboard'))).toBe('now');
    expect(redirectTarget(route('#/ready'))).toBe('#/now?focus=next');
    expect(redirectTarget(route('#/pulse'))).toBe('#/now?focus=lanes');
    expect(redirectTarget(route('#/notifications'))).toBe('#/now?bell=1&panel=announcements');
  });

  it('marks the band a ?focus= names, and ignores a word it does not know', async () => {
    const { unmount } = await mount('#/now?focus=lanes');
    expect((await screen.findByTestId('live-lanes')).getAttribute('data-focused')).toBe('true');
    expect(screen.getByTestId('next-up').getAttribute('data-focused')).toBeNull();
    unmount();

    await mount('#/now?focus=nonsense');
    await waitFor(() => expect(screen.getByTestId('live-lanes').getAttribute('data-focused')).toBeNull());
  });
});
