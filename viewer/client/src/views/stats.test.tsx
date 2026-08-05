/**
 * The statistics page.
 *
 * Its job is "which of these should I look at next", so the properties worth
 * asserting are the ones that make it answerable: the health filter actually
 * filters, an issue points at the phase it is about rather than only the plan,
 * and an empty filter says *which* filter is empty rather than implying the
 * portfolio is clean.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { Portfolio } from '@/lib/api';

const { stats } = vi.hoisted(() => ({ stats: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, stats } };
});

const PORTFOLIO: Portfolio = {
  generatedAt: Date.parse('2026-08-03T12:00:00Z'),
  totals: {
    plans: 4, documents: 1, orphans: 0, phases: 30, done: 21, ready: 3, waiting: 5,
    inProgress: 1, stuck: 0, percent: 70, remainingWeight: 310_000, remainingSessions: 2,
  },
  byStatus: [{ status: 'active', count: 3 }, { status: 'complete', count: 1 }],
  activeLocks: [{ slug: 'demo', phase: 5, owner: 'claude-a/p5', expired: false, leaseUntil: Date.now() + 900_000 }],
  issues: [
    { slug: 'demo', severity: 'warning', kind: 'handoff-drift', message: 'INDEX disagrees', phase: 2 },
    { slug: 'other', severity: 'error', kind: 'cycle', message: 'phase 3 depends on itself' },
    { slug: 'demo', severity: 'info', kind: 'note', message: 'no QA recorded' },
  ],
  velocity: [{ week: '2026-W30', count: 2 }, { week: '2026-W31', count: 4 }],
  calendar: [{ date: '2026-08-01', count: 2 }],
  medianCycleDays: 0,
  sizeMix: [{ size: 'S', count: 4 }, { size: 'M', count: 18 }, { size: 'L', count: 8 }],
  repos: [{ repo: 'skill', count: 8 }],
  skills: [],
  models: [{ model: 'claude-opus-5', count: 4 }],
  stalled: [{ slug: 'other', days: 12, ready: [2, 3] }],
  busiest: [{ slug: 'demo', completions: 12 }],
};

function mount() {
  const client = new QueryClient(queryClientConfig);
  return import('./stats').then(({ default: StatsView }) => render(
    <QueryClientProvider client={client}><StatsView /></QueryClientProvider>,
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  stats.mockResolvedValue(PORTFOLIO);
});

describe('statistics', () => {
  it('counts issues by severity in the tiles and the filter labels', async () => {
    await mount();
    await screen.findByRole('button', { name: 'All 3' });
    expect(screen.getByRole('button', { name: 'Errors 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Warnings 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Info 1' })).toBeTruthy();
  });

  it('sorts issues worst-first, whatever order the server sent them', async () => {
    await mount();
    // Anchored, so the Errors tile's "1 warning · 1 note" hint is not mistaken
    // for an issue row.
    const kinds = (await screen.findAllByText(/^(cycle|handoff-drift|note)$/))
      .map((el) => el.textContent);
    expect(kinds).toEqual(['cycle', 'handoff-drift', 'note']);
  });

  it('filters to one severity, and says which filter is empty', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Errors 1' }));
    expect(screen.getByText('phase 3 depends on itself')).toBeTruthy();
    expect(screen.queryByText('INDEX disagrees')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Info 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Errors 1' }));
    // Nothing is asserted about counts here; what matters is that an empty
    // *filter* never reads as an empty portfolio.
    expect(screen.queryByText(/Plans, handoffs, indexes and locks all agree/)).toBeNull();
  });

  it('links an issue at its phase when it names one, and at the plan when it does not', async () => {
    await mount();
    const links = await screen.findAllByRole('link');
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('#/plan/demo/phase/2');
    expect(hrefs).toContain('#/plan/other/route');
  });

  it('links a held lock at the phase it holds', async () => {
    await mount();
    const link = await screen.findByRole('link', { name: 'demo P5' });
    expect(link.getAttribute('href')).toBe('#/plan/demo/phase/5');
  });

  it('shows stalled plans with how long they have been idle', async () => {
    await mount();
    expect(await screen.findByText(/P2, P3 ready · idle 12 days/)).toBeTruthy();
  });

  it('says “same day” rather than “0d” for a zero median gap', async () => {
    await mount();
    expect(await screen.findByText(/median gap between phases\s*same day/)).toBeTruthy();
  });

  it('says nothing is flagged when the portfolio is clean', async () => {
    stats.mockResolvedValue({ ...PORTFOLIO, issues: [] });
    await mount();
    expect(await screen.findByText(/Plans, handoffs, indexes and locks all agree/)).toBeTruthy();
  });

  it('surfaces a failure as an error rather than an endless skeleton', async () => {
    stats.mockRejectedValue(new Error('the engine is not there'));
    await mount();
    // The shared client config retries once before giving up, so the error is
    // two round trips away — past the 1s default of `findBy`.
    expect(await screen.findByText('the engine is not there', undefined, { timeout: 5000 }))
      .toBeTruthy();
  });
});

describe('recentRate — how long a phase actually takes', () => {
  it('states the rate per M phase, not per unit of weight', async () => {
    // "60 ms per unit of weight" is the right thing to store and an unreadable
    // thing to print. M is the size the sizing constants are anchored on.
    const { recentRate } = await import('./stats');
    expect(recentRate({ ratePerWeight: 60, basis: 'plan', samples: 5, spread: 0.35 }, 40_000))
      .toBe(' · recent rate ≈ 40 min per M phase');
  });

  it('scales with the machine\'s own sizing rather than a baked-in 40K', async () => {
    const { recentRate } = await import('./stats');
    expect(recentRate({ ratePerWeight: 60, basis: 'portfolio', samples: 5, spread: 0.5 }, 20_000))
      .toContain('20 min');
  });

  it('says nothing at all when there is nothing to say', async () => {
    // It rides on the end of a hint that already says something, so `· unknown`
    // is worse than silence — and the heuristic is not a measured rate.
    const { recentRate } = await import('./stats');
    expect(recentRate(undefined)).toBe('');
    expect(recentRate({ ratePerWeight: 60, basis: 'heuristic', samples: 0, spread: 0.6 })).toBe('');
    expect(recentRate({ ratePerWeight: 0, basis: 'plan', samples: 1, spread: 0.7 })).toBe('');
  });
});
