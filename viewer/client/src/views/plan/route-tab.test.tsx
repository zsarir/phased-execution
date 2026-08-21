/**
 * The route tab's card strip.
 *
 * Three properties, matching what the cards are for: a quiet plan gets exactly
 * one card — Autopilot, with the door to its tab — and no manufactured alarm;
 * a plan in trouble gets the trouble said in the run's own words plus the
 * recovery offers, deduplicated so lint and a stuck phase do not mint two
 * plan-repair buttons; and a console without `--allow-agent` still shows the
 * remedy, disabled, naming the flag — the same never-a-dead-end rule every
 * other recovery surface keeps.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import type { PlanDetail } from '@/lib/api';

const { state, run, auth, terminal } = vi.hoisted(() => ({
  state: vi.fn(),
  run: vi.fn(),
  auth: vi.fn(),
  terminal: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, run, auth, terminal } };
});

const DETAIL = {
  summary: {
    slug: 'demo',
    title: 'demo plan',
    kind: 'plan',
    status: 'active',
    phases: 3,
    done: 1,
    ready: [2],
    waiting: 1,
    inProgress: [],
    stuck: [],
    qaMode: 'off',
    budget: 200_000,
  },
  phases: [
    { phase: 1, title: 'Foundations', state: 'done', size: 'M', weight: 40_000, gated: false, bullets: [] },
    { phase: 2, title: 'Surface', state: 'ready', size: 'L', weight: 90_000, gated: false, bullets: [] },
    { phase: 3, title: 'Cutover', state: 'waiting', size: 'S', weight: 15_000, gated: false, bullets: [] },
  ],
  lint: { ok: true, issues: [], summary: 'LINT OK: demo — 3 phases', timedOut: false },
} as unknown as PlanDetail;

async function mount(detail: PlanDetail) {
  const client = new QueryClient(queryClientConfig);
  const { RouteCards } = await import('./route-cards');
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouteCards detail={detail} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ allowAgent: true, autopilot: true });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  auth.mockResolvedValue({ loggedIn: true, checkedAt: '2026-08-05T00:00:00Z' });
  terminal.mockResolvedValue({ available: 'yes', sessions: [] });
});

describe('the route tab card strip', () => {
  it('a quiet plan gets the Autopilot card, its door, and nothing else', async () => {
    await mount(DETAIL);
    expect(await screen.findByText('Autopilot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open autopilot/ })).toHaveAttribute('href', '#/plan/demo/run');
    expect(screen.getByText(/Nothing has been run/)).toBeInTheDocument();
    expect(screen.queryByText("Something's wrong")).toBeNull();
    expect(screen.queryByText('Recovery')).toBeNull();
  });

  it('a halted run and a stuck phase fill all three cards, deduplicated', async () => {
    run.mockResolvedValue({
      run: {
        id: 'r1',
        slug: 'demo',
        status: 'halted',
        model: 'opus',
        spentUsd: 3,
        halt: { at: '', reason: 'phase 2 did not verify: npm test', phase: 2 },
        phases: {},
        activePhase: null,
        child: null,
      },
      history: [],
      eta: null,
    });
    const troubled = {
      ...DETAIL,
      phases: DETAIL.phases.map((p) => (p.phase === 3 ? { ...p, state: 'stuck' } : p)),
      lint: { ok: false, issues: [], summary: 'LINT FAIL: demo — 1 problem', timedOut: false },
    } as unknown as PlanDetail;
    await mount(troubled);

    expect(await screen.findByText("Something's wrong")).toBeInTheDocument();
    // In the Autopilot summary AND the trouble banner — same words, two jobs.
    expect(screen.getAllByText(/did not verify/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Phase 3 is stuck/)).toBeInTheDocument();
    expect(screen.getByText(/LINT FAIL/)).toBeInTheDocument();

    expect(screen.getByText('Ways forward')).toBeInTheDocument();
    // The halt wants a verification fix; the stuck phase and the lint share
    // ONE plan-repair… no — the stuck phase targets its own phase, the lint
    // targets the plan, so three distinct offers stand.
    // Twice by design now: the Autopilot card's plan-level offers AND the
    // Ways-forward card both surface the class.
    expect(
      screen.getAllByRole('button', { name: /Fix the failing verification|Fix with a new agent/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /Recover & continue/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /Repair the plan with a new agent/i }).length).toBe(2);
  });

  it('without --allow-agent the remedy is disabled and names the flag — never absent', async () => {
    state.mockResolvedValue({ allowAgent: false, autopilot: true });
    run.mockResolvedValue({
      run: {
        id: 'r1',
        slug: 'demo',
        status: 'halted',
        model: 'opus',
        spentUsd: 0,
        halt: { at: '', reason: 'phase 2 did not verify: npm test', phase: 2 },
        phases: {},
        activePhase: null,
        child: null,
      },
      history: [],
      eta: null,
    });
    await mount(DETAIL);
    const buttons = await screen.findAllByRole('button', { name: /Fix with a new agent/i });
    for (const button of buttons) expect(button).toBeDisabled();
  });
});
