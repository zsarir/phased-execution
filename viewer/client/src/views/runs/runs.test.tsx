/**
 * The fleet.
 *
 * The four properties this page had before are asserted in `views.test.tsx` and
 * must stay true — the stale-server gate, the two subtitle strings, and a plan
 * cell that is a real link inside a real `<tr>`. What is added here is what the
 * old table could not do:
 *
 * - **A run says why it stopped.** `halt.reason` and `finishedReason` were on
 *   every row of `/api/runs` and on screen nowhere, so the only way to learn
 *   what had gone wrong was to leave the page.
 * - **`RunState.phases` is keyed by string.** Reading it with numeric keys
 *   yields an empty run, which renders as "no phases" — indistinguishable from
 *   a run that genuinely never started one.
 * - **A live run is never buried.** Whatever the order, the run currently
 *   spending money outranks two hundred finished ones.
 * - **The console does not read a transcript nobody opened.** It is the largest
 *   payload this console fetches.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { RunState } from '@/lib/api';
import { outcomeOf } from '../run/defaults';
import {
  NO_FILTERS, applyFilters, fleetTotals, groupRows, outcomeCounts, phasesOf, planOptions,
  sortRows, stopReason, toRows,
} from './model';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const run = (over: Partial<RunState> = {}): RunState => ({
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
  ...over,
} as unknown as RunState);

/** Phase records arrive keyed by the phase number **as a string**. */
const phases = (...records: { phase: number; status: string; [k: string]: unknown }[]) =>
  Object.fromEntries(records.map((r) => [String(r.phase), { attempts: 1, costUsd: 0, ...r }]));

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

describe('collapsing every status into five outcomes', () => {
  it('maps every status the runner can write', () => {
    const all = [
      'running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting',
      'paused', 'parked', 'halted', 'finished', 'interrupted',
    ];
    expect(all.map(outcomeOf)).toEqual([
      'live', 'live', 'live', 'live', 'live', 'live', 'live',
      'attention', 'attention', 'halted', 'finished', 'interrupted',
    ]);
  });

  it('puts a paused run with the ones waiting on a person, and a frozen one with the live', () => {
    // `paused` has genuinely stopped and only a person restarts it. `frozen`
    // still holds a warm child, so it belongs with what is running.
    expect(outcomeOf('paused')).toBe('attention');
    expect(outcomeOf('frozen')).toBe('live');
  });

  it('does not report a queued run as one that died', () => {
    // `outcomeOf` ends in a bare `return 'interrupted'`, so a status missing
    // from `LIVE_STATUSES` is not merely uncategorised — it is actively
    // mislabelled as a run that stopped without saying why.
    expect(outcomeOf('queued')).toBe('live');
  });
});

/* ------------------------------------------------------------------ *
 * Why a run is where it is
 * ------------------------------------------------------------------ */

describe('why a run stopped', () => {
  it('prefers what the runner wrote down', () => {
    expect(stopReason(run({ status: 'halted', halt: { at: '', reason: 'verification failed' } } as never)))
      .toBe('verification failed');
    expect(stopReason(run({ status: 'finished', finishedReason: 'phase 8 was the last one' } as never)))
      .toBe('phase 8 was the last one');
  });

  it('names who froze it and where', () => {
    expect(stopReason(run({ status: 'frozen', freeze: { at: '', phase: 3, pid: 1, by: 'mobin', escalateAt: '' } } as never)))
      .toBe('frozen at phase 3 by mobin');
  });

  it('never leaves a row with nothing but its status', () => {
    // A row that says only `interrupted` has told you the least useful true
    // thing about itself.
    for (const status of ['running', 'parked', 'finished', 'interrupted', 'stopping']) {
      const reason = stopReason(run({ status, activePhase: 4 } as never));
      expect(reason.length, status).toBeGreaterThan(status.length);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Building a row
 * ------------------------------------------------------------------ */

describe('building a row', () => {
  it('reads the phase record through its string keys, in phase order', () => {
    const state = run({ phases: phases(
      { phase: 10, status: 'pending' },
      { phase: 2, status: 'done' },
      { phase: 1, status: 'done' },
    ) as never });
    expect(phasesOf(state).map((p) => p.phase)).toEqual([1, 2, 10]);
    expect(toRows([state])[0].phasesDone).toBe(2);
  });

  it('draws no meter for a run with no budget rather than a full one', () => {
    expect(toRows([run({ runBudgetUsd: null })])[0].spendFraction).toBeNull();
  });

  it('clamps a run that went over its budget, and says that it did', () => {
    // `LoadMeter` draws the fraction it is given; 140% would run past its track.
    const [row] = toRows([run({ runBudgetUsd: 1, spentUsd: 1.4 })]);
    expect(row.spendFraction).toBe(1);
    expect(row.overBudget).toBe(true);
  });

  it('counts time on task, not wall-clock since it was created', () => {
    // A run created three days ago and paused for two did not work for three
    // days, and the cost is against the time it actually ran.
    const [row] = toRows([run({ phases: phases(
      { phase: 1, status: 'done', durationMs: 60_000 },
      { phase: 2, status: 'done', durationMs: 30_000 },
    ) as never })]);
    expect(row.workedMs).toBe(90_000);
  });

  it('counts retries as attempts beyond the first', () => {
    const [row] = toRows([run({ phases: phases(
      { phase: 1, status: 'done', attempts: 1 },
      { phase: 2, status: 'failed', attempts: 3 },
    ) as never })]);
    expect(row.retries).toBe(2);
  });

  it('reads an absent permission profile as guarded, never as unknown', () => {
    expect(toRows([run()])[0].profile).toBe('guarded');
  });
});

/* ------------------------------------------------------------------ *
 * Ordering and filtering
 * ------------------------------------------------------------------ */

describe('ordering the fleet', () => {
  const rows = toRows([
    run({ id: 'cheap', status: 'finished', spentUsd: 0.1, updatedAt: '2026-08-03T05:00:00Z' }),
    run({ id: 'dear', status: 'finished', spentUsd: 90, updatedAt: '2026-08-01T00:00:00Z' }),
    run({ id: 'live', status: 'running', spentUsd: 0.5, updatedAt: '2026-07-01T00:00:00Z' }),
  ]);

  it('pins the live run to the top of every order', () => {
    // Whatever you sorted by, the thing currently spending money on your behalf
    // is the row you came to see.
    for (const by of ['updated', 'cost', 'worked', 'plan'] as const) {
      expect(sortRows(rows, by)[0].id, by).toBe('live');
    }
  });

  it('still orders the rest by the key you asked for', () => {
    expect(sortRows(rows, 'cost').map((r) => r.id)).toEqual(['live', 'dear', 'cheap']);
    expect(sortRows(rows, 'updated').map((r) => r.id)).toEqual(['live', 'cheap', 'dear']);
  });
});

describe('filtering the fleet', () => {
  const rows = toRows([
    run({ id: 'a1', slug: 'demo', status: 'finished' }),
    run({ id: 'b2', slug: 'trade', status: 'halted' }),
  ]);

  it('opens showing everything', () => {
    // A page that opened already filtered would make a run somebody is looking
    // for appear never to have happened.
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(2);
  });

  it('filters by outcome, by plan and by free text over the slug or the run id', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, outcome: 'halted' }).map((r) => r.id)).toEqual(['b2']);
    expect(applyFilters(rows, { ...NO_FILTERS, plan: 'demo' }).map((r) => r.id)).toEqual(['a1']);
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'b2' }).map((r) => r.id)).toEqual(['b2']);
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'TRADE' }).map((r) => r.id)).toEqual(['b2']);
  });

  it('counts each outcome, and lists the plans busiest first', () => {
    expect(outcomeCounts(rows)).toMatchObject({ finished: 1, halted: 1, live: 0 });
    expect(planOptions(rows)).toEqual([{ slug: 'demo', runs: 1 }, { slug: 'trade', runs: 1 }]);
  });

  it('sums spend across what is shown, not across everything that ever ran', () => {
    const totals = fleetTotals(applyFilters(rows, { ...NO_FILTERS, outcome: 'halted' }));
    expect(totals).toMatchObject({ shown: 1, spent: 1.65 });
  });

  it('groups by plan without reordering the rows', () => {
    expect(groupRows(rows, true).map((g) => g.key)).toEqual(['demo', 'trade']);
    expect(groupRows(rows, false)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const { state, runs, approvals, auth, runTranscript } = vi.hoisted(() => ({
  state: vi.fn(),
  runs: vi.fn(),
  approvals: vi.fn(),
  auth: vi.fn(),
  runTranscript: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, runs, approvals, auth, runTranscript } };
});

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const HALTED = run({
  id: 'h1',
  slug: 'trade',
  status: 'halted',
  halt: { at: '2026-08-03T01:00:00Z', reason: 'npm test failed at phase 3' },
  phases: phases(
    { phase: 1, status: 'done', costUsd: 0.42, turns: 38, durationMs: 720_000 },
    { phase: 2, status: 'done', costUsd: 0.3 },
    { phase: 3, status: 'failed', attempts: 2, costUsd: 0.9 },
  ),
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrefs({ runsSort: 'updated', runsOutcome: '', runsGroup: false, runsConsole: false });
  state.mockResolvedValue({
    autopilot: true, allowRun: true, allowWrites: false, unread: 0,
    root: { label: 'hub', path: '/hub', ok: true, planCount: 3 },
    repo: { available: true, branch: 'main', dirty: [] },
  });
  runs.mockResolvedValue([]);
  approvals.mockResolvedValue([]);
  auth.mockResolvedValue({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' });
  runTranscript.mockResolvedValue([]);
});

describe('the runs page', () => {
  it('says why a run stopped, in the row', async () => {
    runs.mockResolvedValue([HALTED]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    const link = await screen.findByRole('link', { name: 'trade' });
    const row = link.closest('tr')!;
    expect(within(row).getByText('npm test failed at phase 3')).toBeTruthy();
  });

  it('opens a row into the phases the run recorded, fetching nothing to do it', async () => {
    runs.mockResolvedValue([HALTED]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    const toggle = await screen.findByRole('button', { name: /Show the phases of run h1/ });
    expect(screen.queryByText('38 turns')).toBeNull();

    fireEvent.click(toggle);
    expect(await screen.findByText(/38 turns/)).toBeTruthy();
    expect(screen.getByText(/2 attempts/)).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Everything on screen came out of the list payload already in the cache.
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('folds the console away while nothing is running, and reads no transcript for it', async () => {
    runs.mockResolvedValue([run()]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    expect(await screen.findByText(/idle · last: demo finished/)).toBeTruthy();
    // A transcript is the largest payload this console reads; rendering a box
    // nobody expanded is not a reason to fetch one.
    expect(runTranscript).not.toHaveBeenCalled();
  });

  it('opens the console when asked, and only then reads the transcript', async () => {
    runs.mockResolvedValue([run()]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    fireEvent.click(await screen.findByText(/idle · last: demo finished/));
    await waitFor(() => expect(runTranscript).toHaveBeenCalled());
    expect(screen.getByText('Session console')).toBeTruthy();
  });

  it('keeps the console open on its own while a run is live', async () => {
    runs.mockResolvedValue([run({ status: 'running', activePhase: 3 })]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    expect(await screen.findByText('Session console')).toBeTruthy();
    expect(screen.queryByText(/idle · last/)).toBeNull();
  });

  it('narrows the fleet to one outcome, and says how many it hid', async () => {
    runs.mockResolvedValue([HALTED, run()]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Halted, 1 run' }));
    await waitFor(() => expect(screen.getByText(/1 hidden by filters/)).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'demo' })).toBeNull();
  });

  it('counts what the fleet is doing, across the runs shown', async () => {
    runs.mockResolvedValue([HALTED, run({ status: 'parked', id: 'p1' })]);
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);

    const tiles = await screen.findByRole('region', { name: 'What the fleet is doing' });
    expect(within(tiles).getByText('Waiting on you')).toBeTruthy();
    expect(within(tiles).getByText('$3.30')).toBeTruthy();
  });

  it('lights no outcome chip amber until one of them is narrowing the fleet', async () => {
    // Showing everything is the resting state, so "Everything" is never the
    // amber one — amber is reserved for a view you have deliberately narrowed.
    runs.mockResolvedValue([HALTED, run()]);
    const { default: RunsView } = await import('./index');
    const { container } = mount(<RunsView />);

    const halted = await screen.findByRole('button', { name: 'Halted, 1 run' });
    const amber = () => [...container.querySelectorAll('button')]
      .filter((b) => b.className.includes('bg-action/12'))
      .map((b) => b.textContent?.trim());
    expect(amber().filter((label) => label !== 'Latest')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Everything' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(halted);
    await waitFor(() => expect(amber()).toContain('Halted1'));
  });

  it('reports a failed read as a failure rather than an empty fleet', async () => {
    runs.mockRejectedValue(new Error('the run store went away'));
    const { default: RunsView } = await import('./index');
    mount(<RunsView />);
    // The production config retries once before giving up.
    expect(await screen.findByText(/the run store went away/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('No runs yet')).toBeNull();
  });
});

describe('lifecycle from the fleet', () => {
  it('a live row offers Freeze, and Stop only behind a dialog that names the cost', async () => {
    const { Fleet } = await import('./fleet');
    const onLifecycle = vi.fn();
    const rows = toRows([run({ id: 'live1', status: 'running', activePhase: 2 })]);
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <Fleet
          rows={rows}
          grouped={false}
          onWatch={() => {}}
          onLifecycle={onLifecycle}
          allowRun
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Show the phases of run live1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
    expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({ id: 'live1' }), 'freeze');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/interrupted/)).toBeTruthy();
    expect(onLifecycle).not.toHaveBeenCalledWith(expect.anything(), 'stop');
    fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
    await waitFor(() => expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({ id: 'live1' }), 'stop'));
  });

  it('a finished row offers no lifecycle at all — there is nothing to act on', async () => {
    const { Fleet } = await import('./fleet');
    const rows = toRows([run({ id: 'done1', status: 'finished' })]);
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <Fleet rows={rows} grouped={false} onWatch={() => {}} onLifecycle={() => {}} allowRun />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Show the phases of run done1/ }));
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});
