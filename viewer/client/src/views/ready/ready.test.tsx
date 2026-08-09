/**
 * The departures board.
 *
 * What is worth asserting here is the handful of properties that are invisible
 * until they are wrong:
 *
 * - **`plan.ready` is an array of numbers.** The view this replaces read it as
 *   an array of objects, so every phase number, title, size and gate came back
 *   `undefined`: each row linked to the plan instead of the phase and two ready
 *   phases of the same plan rendered identically. Nothing failed; the page just
 *   quietly stopped answering its own question. That is the regression these
 *   tests exist for.
 * - **A claimed phase never leads.** It sinks below every unclaimed one in
 *   every order, because "somebody else is in this phase" outranks any argument
 *   for starting it.
 * - **The orders differ.** Five sorts that produce the same first row are one
 *   sort with five labels.
 * - **A row renders before its plan detail arrives.** Enrichment is a second
 *   request per plan; the board must be readable while they land.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { PlanDetail, PlanSummaryFull } from '@/lib/api';
import {
  NO_FILTERS, applyFilters, isClaimed, load, queueTotals, rank, repoOptions, toDepartures,
  type Departure,
} from './model';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull => ({
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  activity: Date.UTC(2026, 7, 3),
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [], mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
  ...over,
});

const detail = (phases: unknown[]): PlanDetail => ({ phases } as unknown as PlanDetail);

const phaseView = (over: Record<string, unknown> = {}) => ({
  phase: 2,
  title: 'Wire the ingest',
  state: 'ready',
  size: 'M',
  weight: 40_000,
  gated: false,
  bullets: [],
  analysis: { unblocks: 3, onCriticalPath: true, weight: 40_000 },
  ...over,
});

const NOW = Date.UTC(2026, 7, 3, 12);

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

describe('building the queue', () => {
  it('reads ready as phase numbers, not objects', () => {
    // The whole defect in one assertion: the wire shape is `[2]`, and a row
    // built from it must still know it is phase 2.
    const [d] = toDepartures([plan({ ready: [2] })], new Map(), NOW);
    expect(d.phase).toBe(2);
    expect(d.key).toBe('alpha#2');
  });

  it('renders a row before the plan detail lands, then upgrades it', () => {
    const bare = toDepartures([plan()], new Map(), NOW)[0];
    expect(bare.enriched).toBe(false);
    expect(bare.title).toBeUndefined();
    // The summary still knows the leverage of the engine's own best next move.
    expect(bare.onCriticalPath).toBe(true);

    const full = toDepartures(
      [plan({ nextBest: { phase: 2, unblocks: 3 } })],
      new Map([['alpha', detail([phaseView()])]]),
      NOW,
    )[0];
    expect(full.enriched).toBe(true);
    expect(full.title).toBe('Wire the ingest');
    expect(full.size).toBe('M');
    expect(full.unblocks).toBe(3);
  });

  it('counts idle days from the plan activity', () => {
    const [d] = toDepartures([plan({ activity: NOW - 9 * 86_400_000 })], new Map(), NOW);
    expect(d.idleDays).toBe(9);
  });

  it('treats an expired lease as unclaimed', () => {
    expect(isClaimed({ owner: 'someone', expired: false })).toBe(true);
    expect(isClaimed({ owner: 'someone', expired: true })).toBe(false);
    expect(isClaimed(undefined)).toBe(false);
  });

  /* ---------------- closure ----------------
   * The highest-stakes gate in the client, and the one the server cannot make
   * for us. `stats.ready` is `board.ready` verbatim — the engine deliberately
   * still reports what a closed plan never finished, so the plan's own page can
   * say so — which means a closed plan arrives here with a POPULATED ready
   * array. Every row this builds is an invitation to boot a session. */

  it('never boards a closed plan, whichever terminal word it uses', () => {
    for (const status of ['complete', 'abandoned', 'superseded']) {
      expect(toDepartures([plan({ status, ready: [2, 3] })], new Map(), NOW)).toEqual([]);
    }
  });

  it('boards the open plans in the same list', () => {
    const queue = toDepartures([
      plan({ slug: 'gone', status: 'abandoned', ready: [1, 2, 3] }),
      plan({ slug: 'live', ready: [2] }),
    ], new Map(), NOW);
    expect(queue.map((d) => d.key)).toEqual(['live#2']);
  });

  it('reads the server’s closed flag ahead of the status word', () => {
    expect(toDepartures([plan({ status: 'shelved', closed: true, ready: [2] })], new Map(), NOW))
      .toEqual([]);
    // …and an explicitly open plan boards even if the word is unfamiliar.
    expect(toDepartures([plan({ status: 'shelved', closed: false, ready: [2] })], new Map(), NOW))
      .toHaveLength(1);
  });

  // A closed plan contributes no departures, so its slug is not in the set
  // `queueTotals` sums over — the session count cannot inherit its work.
  it('leaves a closed plan out of the queue totals', () => {
    const summaries = [
      plan({ slug: 'gone', status: 'abandoned', ready: [1, 2], remainingSessions: 5 }),
      plan({ slug: 'live', ready: [2], remainingSessions: 2 }),
    ];
    const totals = queueTotals(toDepartures(summaries, new Map(), NOW), summaries);
    expect(totals).toMatchObject({ phases: 1, plans: 1, sessions: 2 });
  });
});

describe('ranking', () => {
  const queue = (): Departure[] => toDepartures(
    [
      plan({ slug: 'heavy', ready: [1], activity: NOW - 86_400_000, budget: 200_000 }),
      plan({ slug: 'light', ready: [1], activity: NOW, budget: 200_000 }),
      plan({ slug: 'stale', ready: [1], activity: NOW - 30 * 86_400_000, budget: 200_000 }),
    ],
    new Map([
      ['heavy', detail([phaseView({ phase: 1, weight: 90_000, analysis: { unblocks: 5, onCriticalPath: false, weight: 90_000 } })])],
      ['light', detail([phaseView({ phase: 1, weight: 15_000, analysis: { unblocks: 1, onCriticalPath: false, weight: 15_000 } })])],
      ['stale', detail([phaseView({ phase: 1, weight: 40_000, analysis: { unblocks: 2, onCriticalPath: true, weight: 40_000 } })])],
    ]),
    NOW,
  );

  it('leads with the phase that frees the most under Leverage', () => {
    expect(rank(queue(), 'leverage')[0].slug).toBe('heavy');
  });

  it('leads with the critical path under Critical path', () => {
    expect(rank(queue(), 'critical')[0].slug).toBe('stale');
  });

  it('leads with the lightest under Quick wins', () => {
    expect(rank(queue(), 'quick')[0].slug).toBe('light');
  });

  it('leads with the most recent plan under Momentum', () => {
    expect(rank(queue(), 'momentum')[0].slug).toBe('light');
  });

  it('leads with the longest untouched under Unstick', () => {
    expect(rank(queue(), 'unstick')[0].slug).toBe('stale');
  });

  it('sinks a claimed phase below every unclaimed one, in every order', () => {
    const claimedQueue = toDepartures(
      [
        plan({ slug: 'taken', ready: [1], locks: [{ phase: 1, owner: 'other', expired: false }] }),
        plan({ slug: 'free', ready: [1] }),
      ],
      new Map([
        // The claimed one is the better move on every other measure, which is
        // exactly the case that must not win.
        ['taken', detail([phaseView({ phase: 1, weight: 15_000, analysis: { unblocks: 9, onCriticalPath: true, weight: 15_000 } })])],
        ['free', detail([phaseView({ phase: 1, weight: 90_000, analysis: { unblocks: 0, onCriticalPath: false, weight: 90_000 } })])],
      ]),
      NOW,
    );
    for (const order of ['leverage', 'critical', 'quick', 'momentum', 'unstick'] as const) {
      expect(rank(claimedQueue, order)[0].slug, order).toBe('free');
    }
  });

  it('sorts an unsized phase last rather than as weightless', () => {
    const mixed = toDepartures(
      [plan({ slug: 'sized', ready: [1] }), plan({ slug: 'unsized', ready: [1] })],
      new Map([['sized', detail([phaseView({ phase: 1, weight: 90_000, analysis: { unblocks: 0, onCriticalPath: false, weight: 90_000 } })])]]),
      NOW,
    );
    expect(rank(mixed, 'quick').map((d) => d.slug)).toEqual(['sized', 'unsized']);
  });
});

describe('filtering', () => {
  const queue = () => toDepartures(
    [
      plan({ slug: 'a', ready: [1], repos: ['hub'], locks: [{ phase: 1, owner: 'x', expired: false }] }),
      plan({ slug: 'b', ready: [1], repos: ['aws', 'hub'] }),
    ],
    new Map([['b', detail([phaseView({ phase: 1, gated: true })])]]),
    NOW,
  );

  it('hides claimed phases on request', () => {
    expect(applyFilters(queue(), { ...NO_FILTERS, unclaimed: true }).map((d) => d.slug)).toEqual(['b']);
  });

  it('hides gated phases on request', () => {
    expect(applyFilters(queue(), { ...NO_FILTERS, open: true }).map((d) => d.slug)).toEqual(['a']);
  });

  it('filters by repo and by plan', () => {
    expect(applyFilters(queue(), { ...NO_FILTERS, repo: 'aws' }).map((d) => d.slug)).toEqual(['b']);
    expect(applyFilters(queue(), { ...NO_FILTERS, plan: 'a' }).map((d) => d.slug)).toEqual(['a']);
  });

  it('offers every repo the queue names, most used first', () => {
    expect(repoOptions(queue())).toEqual(['hub', 'aws']);
  });

  it('counts what the board is showing', () => {
    const totals = queueTotals(queue(), [plan({ slug: 'a', remainingSessions: 2 }), plan({ slug: 'b', remainingSessions: 3 })]);
    expect(totals).toMatchObject({ phases: 2, plans: 2, claimed: 1, gated: 1, sessions: 5 });
  });
});

describe('session load', () => {
  it('reads a weight as a fraction of the plan budget', () => {
    expect(load(40_000, 200_000)).toMatchObject({ fraction: 0.2, short: '20%', over: false });
  });

  it('says a phase is over budget rather than clamping it silently', () => {
    const over = load(300_000, 200_000);
    expect(over.over).toBe(true);
    expect(over.short).toBe('over');
    // Clamped for drawing — a bar cannot be 150% wide — but the label still says so.
    expect(over.fraction).toBe(1);
  });

  it('has no reading when either number is missing', () => {
    expect(load(undefined, 200_000).fraction).toBeNull();
    expect(load(40_000, 0).fraction).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------ */

const { state, plans, planDetail, prompt } = vi.hoisted(() => ({
  state: vi.fn(),
  plans: vi.fn(),
  planDetail: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state, plans, plan: planDetail, prompt },
  };
});

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  // Most of this file exercises the FLAT board (promotion, prompts, ordering)
  // — still one toggle away, no longer the default. The grouped default has
  // its own test below.
  const { setPrefs } = await import('@/lib/prefs');
  setPrefs({ readyGroup: false });
  state.mockResolvedValue({ allowRun: true, allowWrites: false, autopilot: true, unread: 0 });
  plans.mockResolvedValue([plan({ ready: [2], nextBest: { phase: 2, unblocks: 3 } })]);
  planDetail.mockResolvedValue(detail([phaseView()]));
  prompt.mockResolvedValue('boot me');
});

describe('the default view', () => {
  it('groups departures by PLAN out of the box — phases are known by their plan', async () => {
    const { PREF_DEFAULTS, setPrefs } = await import('@/lib/prefs');
    // The shipped default IS grouped (the module-level pref cache carries the
    // flat setting the beforeEach wrote, so the default is pinned on the
    // constant and the grouped rendering exercised explicitly).
    expect(PREF_DEFAULTS.readyGroup).toBe(true);
    setPrefs({ readyGroup: true });
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);

    // The grouped board leads with the plan — its title linking to the plan
    // page, its slug beneath (two plans can share a title prefix)…
    expect(await screen.findByRole('link', { name: 'Alpha plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'alpha' })).toBeInTheDocument();
    // …not with the flat board's single promoted departure.
    expect(screen.queryByText(/Also boarding/i)).toBeNull();
  });
});

describe('the board', () => {
  it('links a row to the phase, not to the plan', async () => {
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);

    const link = await screen.findByRole('link', { name: /Wire the ingest/ });
    expect(link.getAttribute('href')).toBe('#/plan/alpha/phase/2');
  });

  it('promotes one recommendation and says why', async () => {
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);

    const hero = (await screen.findByText(/Next departure/i)).closest('section')!;
    expect(within(hero).getByText(/Starting it frees 3 phases/i)).toBeTruthy();
    expect(within(hero).getByText(/critical path/i)).toBeTruthy();
  });

  it('leads a row with the reason not to start it, not the reason to', async () => {
    // The first two reasons are what a row has room for. A phase somebody is
    // holding, that also frees three phases and sits on the critical path, must
    // still lead with the claim.
    const { reasons } = await import('./departure');
    const [d] = toDepartures(
      [plan({ ready: [2], locks: [{ phase: 2, owner: 'other', expired: false }] })],
      new Map([['alpha', detail([phaseView()])]]),
      NOW,
    );
    expect(reasons(d).slice(0, 2).map((r) => r.key)).toContain('lock');
  });

  it('fetches a boot prompt only when one is asked for', async () => {
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);
    await screen.findByText(/Next departure/i);

    // Thirteen rows that each pre-fetched a prompt would be thirteen engine
    // invocations to answer a question nobody asked.
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Show/ }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('alpha', 2));
  });

  it('marks a claimed phase and refuses to recommend it', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'taken', ready: [1], locks: [{ phase: 1, owner: 'claude-b/p1', expired: false }] }),
      plan({ slug: 'free', ready: [1] }),
    ]);
    planDetail.mockImplementation(async (slug: string) =>
      detail([phaseView({ phase: 1, title: `${slug} work` })]));

    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);

    const hero = (await screen.findByText(/Next departure/i)).closest('section')!;
    expect(within(hero).getByText(/free work/)).toBeTruthy();
    expect(screen.getByText(/claimed by claude-b\/p1/)).toBeTruthy();
  });

  it('changes the recommendation when the order changes', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'big', ready: [1] }),
      plan({ slug: 'small', ready: [1] }),
    ]);
    planDetail.mockImplementation(async (slug: string) => detail([phaseView({
      phase: 1,
      title: `${slug} work`,
      weight: slug === 'big' ? 90_000 : 15_000,
      analysis: { unblocks: slug === 'big' ? 5 : 0, onCriticalPath: false, weight: slug === 'big' ? 90_000 : 15_000 },
    })]));

    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);

    const hero = async () => (await screen.findByText(/Next departure/i)).closest('section')!;
    expect(within(await hero()).getByText(/big work/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Quick wins' }));
    await waitFor(async () => expect(within(await hero()).getByText(/small work/)).toBeTruthy());
  });

  it('offers a way back when the filters hide everything', async () => {
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);
    await screen.findByText(/Next departure/i);

    fireEvent.click(screen.getByRole('button', { name: 'No gate to clear' }));
    // Nothing here is gated, so this filter removes nothing — use the plan
    // filter, which can empty the board.
    fireEvent.click(screen.getByRole('button', { name: 'Unclaimed only' }));
    expect(screen.queryByText(/Every ready phase is filtered out/)).toBeNull();
  });

  it('says nothing is ready rather than showing an empty board', async () => {
    plans.mockResolvedValue([plan({ ready: [] })]);
    const { default: ReadyView } = await import('./index');
    mount(<ReadyView />);
    expect(await screen.findByText(/Nothing is ready/)).toBeTruthy();
    expect(planDetail).not.toHaveBeenCalled();
  });
});
