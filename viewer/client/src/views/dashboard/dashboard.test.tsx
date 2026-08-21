/**
 * The dashboard.
 *
 * The properties worth holding are the ones about *what the page is for*:
 *
 * - **Anything blocked on a person outranks anything merely true.** The order
 *   of the attention row is the page's only real editorial judgement, and a
 *   permission card that sorts below an unread badge is a session left parked.
 * - **It does not talk to a server that has no run endpoints.** Same guard the
 *   runs view has: `/api/state` must answer before the run queries fire, or a
 *   console running an older server fills the log with 404s.
 * - **Every number agrees with the nav beside it.** The header used to read the
 *   plan *document* count while the rail read the plan count.
 * - **A plan strip renders the plan's real phase states**, and a state the
 *   engine invents later paints grey rather than transparent.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';
import { demands } from './now';

/* ------------------------------------------------------------------ *
 * The editorial judgement
 * ------------------------------------------------------------------ */

const RUN = {
  id: 'r1', slug: 'alpha', status: 'halted', halt: { at: '', reason: 'verification failed' },
} as unknown as RunState;

describe('what is waiting on a person', () => {
  it('puts a parked session above everything else', () => {
    const items = demands({ approvals: 1, runs: [RUN] });
    expect(items[0].id).toBe('approvals');
    // A halted run has already stopped; a card is still stopping something.
    // The stop itself is raised only because nothing automatic will touch it
    // here (this console cannot run) — the loop's own stops come back as errands.
    expect(items.map((i) => i.id)).toEqual(['approvals', 'halt-r1']);
  });

  it('is empty when nothing needs anyone', () => {
    expect(demands({ approvals: 0, runs: [] })).toEqual([]);
  });

  it('names the run and its reason rather than saying something went wrong', () => {
    const [item] = demands({ approvals: 0, runs: [RUN] });
    expect(item.label).toBe('alpha halted');
    expect(item.detail).toBe('verification failed');
    expect(item.href).toBe('#/plan/alpha/run');
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const { state, plans, planDetail, stats, runs, approvals } = vi.hoisted(() => ({
  state: vi.fn(),
  plans: vi.fn(),
  planDetail: vi.fn(),
  stats: vi.fn(),
  runs: vi.fn(),
  approvals: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state, plans, plan: planDetail, stats, runs, approvals },
  };
});

const PLAN = {
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  activity: Date.UTC(2026, 7, 3),
  phases: 3,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [],
  stuck: [],
  percent: 33,
  remainingWeight: 80_000,
  remainingSessions: 1,
  criticalPath: [2],
  nextBest: { phase: 2, unblocks: 1 },
  budget: 200_000,
  skills: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
};

const STATS = {
  generatedAt: Date.UTC(2026, 7, 3),
  totals: {
    plans: 1, documents: 0, orphans: 0, closed: 0, phases: 3, done: 1, ready: 1, waiting: 1,
    inProgress: 0, stuck: 0, percent: 33, remainingWeight: 80_000, remainingSessions: 1,
  },
  byStatus: [], activeLocks: [], issues: [], velocity: [{ week: '2026-W31', count: 2 }],
  calendar: [], sizeMix: [], repos: [], skills: [], models: [], stalled: [], busiest: [],
};

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({
    autopilot: true, allowRun: true, allowWrites: true, allowTerminal: false, unread: 0,
    // `planCount` counts documents, not plans — deliberately different from the
    // one plan in `plans` below, which is the disagreement this page had.
    root: { label: 'hub', path: '/hub', ok: true, planCount: 9 },
    repo: { available: true, branch: 'main', dirty: [] },
    supervisor: { detail: 'launchd' },
  });
  plans.mockResolvedValue([PLAN, { ...PLAN, slug: 'doc', kind: 'document', ready: [] }]);
  planDetail.mockResolvedValue({
    phases: [{ phase: 2, title: 'Wire the ingest', state: 'ready', size: 'M', weight: 40_000, gated: false, bullets: [] }],
    route: {
      nodes: [
        { phase: 1, state: 'done', title: 'a', layer: 0, row: 0, size: 'M', gated: false },
        { phase: 2, state: 'ready', title: 'b', layer: 1, row: 0, size: 'M', gated: false },
        { phase: 3, state: 'waiting', title: 'c', layer: 2, row: 0, size: 'M', gated: false },
      ],
      edges: [], layers: 3, rows: 1,
    },
  });
  stats.mockResolvedValue(STATS);
  runs.mockResolvedValue([]);
  approvals.mockResolvedValue([]);
});

describe('the dashboard', () => {
  it('counts plans the way the nav does', async () => {
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);
    // One plan and one document — the header says one plan, not nine documents.
    expect(await screen.findByText(/hub · 1 plan · main/)).toBeTruthy();
  });

  it('says nothing is running and names the move to make instead', async () => {
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    expect(await screen.findByText(/Nothing is running/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/alpha phase 2/)).toBeTruthy());
  });

  /* Authoring a plan was reachable only from the Plans list — the one page you
     have no reason to open when the dashboard has just told you nothing is
     running. The card is on the dashboard now, and it is DISABLED rather than
     absent without the flag: a gap reads as "this console cannot make plans",
     when the truth is that it can and was started without `--allow-agent`. */
  describe('starting a new plan', () => {
    it('offers the card, and opens the wizard', async () => {
      state.mockResolvedValue({
        autopilot: true, allowRun: true, allowWrites: true, allowAgent: true, unread: 0,
        root: { label: 'hub', path: '/hub', ok: true, planCount: 9 },
        repo: { available: true, branch: 'main', dirty: [] },
      });
      const { default: DashboardView } = await import('./index');
      mount(<DashboardView />);

      // The card renders before `/api/state` answers, and renders DISABLED
      // while it has no capability to go on — so the wait is for the button to
      // become enabled, not merely to exist.
      await waitFor(() => expect(
        screen.getAllByRole('button', { name: /new plan with ai/i })[0],
      ).toBeEnabled());

      fireEvent.click(screen.getAllByRole('button', { name: /new plan with ai/i })[0]);
      expect(await screen.findByPlaceholderText(/what should this plan achieve/i))
        .toBeInTheDocument();
    });

    it('without --allow-agent the card stays, disabled, and names the flag', async () => {
      // `allowAgent` is absent from the base state above.
      const { default: DashboardView } = await import('./index');
      mount(<DashboardView />);

      expect(await screen.findByText('New plan')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /new plan with ai/i })).toBeDisabled();
      expect(screen.getByText('--allow-agent')).toBeInTheDocument();
    });
  });

  it('shows the live run with its phase instead of the quiet state', async () => {
    runs.mockResolvedValue([{
      id: 'r9', slug: 'alpha', status: 'running', activePhase: 2, model: 'opus', spentUsd: 1.5,
      child: { pid: 1, phase: 2, sessionId: 's', startedAt: new Date().toISOString() },
    } as unknown as RunState]);

    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    // A function matcher on textContent: the status word carries its own
    // explanatory title span now, which splits the line into elements.
    expect(await screen.findByText((_, element) =>
      element?.textContent === 'phase 2 · running · opus'
      && element.className.includes('truncate'))).toBeTruthy();
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
  });

  it('does not ask a server that has no run endpoints', async () => {
    state.mockResolvedValue({ autopilot: false, root: { label: 'hub', ok: true } });
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    await screen.findByText(/predates the autopilot/);
    expect(runs).not.toHaveBeenCalled();
    expect(approvals).not.toHaveBeenCalled();
  });

  it('draws every phase of a plan strip, painted by state', async () => {
    const { default: DashboardView } = await import('./index');
    const { container } = mount(<DashboardView />);

    await waitFor(() => expect(container.querySelector('[aria-label="3 phases, 1 done"]')).toBeTruthy());
    const strip = container.querySelector('[aria-label="3 phases, 1 done"]')!;
    const fills = [...strip.children].map((c) => (c as HTMLElement).style.background);
    // Board words through the vocabulary: done → done, ready → queued ("Next up"), waiting → waiting.
    expect(fills).toEqual(['var(--status-done)', 'var(--status-queued)', 'var(--status-waiting)']);
  });

  it('links each ready phase of a strip to that phase', async () => {
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    const link = await screen.findByRole('link', { name: /P2 ready/ });
    expect(link.getAttribute('href')).toBe('#/plan/alpha/phase/2');
  });

  /* ---------------- closure ----------------
   * `done < phases` is true of every abandoned plan ever written, and that was
   * the only test the "Plans in flight" strip and the "In flight" hint applied.
   * The recommendation line under "Nothing is running" is the other half: it
   * becomes "Start phase N" with a button beside it. */

  it('does not put a closed plan in flight, in the counts, or up as the next move', async () => {
    plans.mockResolvedValue([
      { ...PLAN, slug: 'gone', title: 'Walked away', status: 'abandoned', closed: true,
        ready: [2, 3], inProgress: [1], nextBest: { phase: 2, unblocks: 9 } },
    ]);
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    await screen.findByText(/Nothing is running/);
    // No recommendation at all — better silence than a boot into a closed plan.
    expect(screen.queryByText(/gone phase/)).toBeNull();
    // No strip for it either.
    expect(screen.queryByText('Walked away')).toBeNull();
    // Ready and In flight both read zero: its 2 ready and 1 in-progress phases
    // are the engine's record of what never happened, not live work.
    await waitFor(() => expect(screen.getByText('Ready now')).toBeTruthy());
    // A tile renders as `<value><label><hint>`, so the count is the leading run
    // of digits — `\b0\b` would not survive `0Ready now`.
    const tile = (label: string) =>
      screen.getByText(label).closest('div')?.parentElement?.textContent ?? '';
    expect(tile('Ready now')).toMatch(/^0Ready now/);
    expect(tile('In flight')).toMatch(/^0In flight0 plans unfinished/);
  });

  it('still recommends the open plan sitting beside a closed one', async () => {
    // The control: the gate must be closure, not the fixture losing its plans.
    plans.mockResolvedValue([
      { ...PLAN, slug: 'gone', status: 'abandoned', closed: true, ready: [2] },
      PLAN,
    ]);
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);
    await waitFor(() => expect(screen.getByText(/alpha phase 2/)).toBeTruthy());
  });

  it('reports what this console can do', async () => {
    const { default: DashboardView } = await import('./index');
    mount(<DashboardView />);

    expect(await screen.findByText('Writes on')).toBeTruthy();
    expect(screen.getByText('Autopilot on')).toBeTruthy();
    // The terminal is off by default; a console that implied otherwise would
    // put a nav entry on screen that 403s.
    expect(screen.getByText('Terminal off')).toBeTruthy();
    expect(screen.getByText('/hub')).toBeTruthy();
  });
});
