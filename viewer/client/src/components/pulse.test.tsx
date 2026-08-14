/**
 * The pulse panel — the "what is happening right now" answer, pinned.
 *
 * The derivations are pure and tested as data; the render test pins what an
 * operator actually reads off the panel: which phase, in what vehicle, for
 * how long, and what is parked waiting on the world.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanPulse, fmtElapsed, isLiveRun, pulseLanes, pulseWaits } from './pulse';
import { pulseRuns } from '@/views/pulse';
import type { RunState } from '@/lib/api';

function run(over: Partial<RunState> = {}): RunState {
  return {
    id: 'r1', slug: 'demo', root: '/tmp/demo', status: 'running', autonomy: 'auto',
    model: 'sonnet', phaseBudgetUsd: null, runBudgetUsd: null, spentUsd: 1.25,
    maxConsecutiveFailures: 2, consecutiveFailures: 0,
    createdAt: '2026-08-15T10:00:00Z', updatedAt: new Date().toISOString(),
    activePhase: 4, phases: {}, ...over,
  } as RunState;
}

describe('pulseLanes', () => {
  it('one lane per live child, carrying the record\'s model, clock and cost', () => {
    const state = run({
      children: { '4': { pid: 1, phase: 4, sessionId: 's4', startedAt: '2026-08-15T10:05:00Z' } },
      phases: {
        '4': {
          phase: 4, status: 'running', attempts: 1, costUsd: 0.42,
          startedAt: '2026-08-15T10:05:00Z', actualModel: 'claude-sonnet-5',
        },
      },
    } as never);
    const lanes = pulseLanes(state, new Map([[4, 'cart api']]));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({
      phase: 4, title: 'cart api', vehicle: 'Autopilot session',
      model: 'claude-sonnet-5', costUsd: 0.42, frozen: false, sessionId: 's4',
    });
  });

  it('falls back to the active phase when the run predates the pool', () => {
    const lanes = pulseLanes(run({ activePhase: 2, phases: { '2': { phase: 2, status: 'running', attempts: 1, costUsd: 0 } } } as never));
    expect(lanes.map((l) => l.phase)).toEqual([2]);
  });

  it('a stopped run has no lanes — the pulse never invents motion', () => {
    expect(pulseLanes(run({ status: 'halted' }))).toEqual([]);
  });
});

describe('pulseWaits', () => {
  it('separates queued-behind-a-lock from parked-on-the-world', () => {
    const state = run({
      phases: {
        '5': { phase: 5, status: 'queued', attempts: 0, costUsd: 0, lockWaitSince: '2026-08-15T10:00:00Z' },
        '6': {
          phase: 6, status: 'waiting', attempts: 1, costUsd: 0,
          parkedUntil: '2026-08-15T12:00:00Z', parkReason: 'CI run 812 is still building',
          watch: ['gh:owner/repo#run/812'],
        },
      },
    } as never);
    const waits = pulseWaits(state);
    expect(waits.map((w) => w.kind)).toEqual(['queued', 'parked']);
    expect(waits[0].why).toMatch(/behind a lock/);
    expect(waits[1]).toMatchObject({ why: 'CI run 812 is still building', watch: ['gh:owner/repo#run/812'] });
  });
});

describe('fmtElapsed', () => {
  it('reads like a clock at every magnitude', () => {
    expect(fmtElapsed(38_000)).toBe('38s');
    expect(fmtElapsed(14 * 60_000 + 5_000)).toBe('14m 05s');
    expect(fmtElapsed(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(fmtElapsed(-5)).toBe('—');
  });
});

describe('PlanPulse', () => {
  it('shows the lane — phase, vehicle, model — and the parked row with its reason', () => {
    const state = run({
      children: { '4': { pid: 1, phase: 4, sessionId: 's4', startedAt: new Date(Date.now() - 90_000).toISOString() } },
      phases: {
        '4': { phase: 4, status: 'running', attempts: 1, costUsd: 0.42, startedAt: new Date(Date.now() - 90_000).toISOString(), model: 'opus' },
        '6': { phase: 6, status: 'waiting', attempts: 1, costUsd: 0, parkReason: 'waiting on the image build' },
      },
    } as never);
    render(<PlanPulse
      slug="demo"
      run={state}
      board={[
        { phase: 4, title: 'cart api', state: 'ready' },
        { phase: 6, title: 'deploy', state: 'ready' },
        { phase: 7, title: 'docs', state: 'waiting', dependsOn: [6] },
      ]}
    />);
    expect(screen.getByText('P4')).toBeInTheDocument();
    expect(screen.getByText('cart api')).toBeInTheDocument();
    expect(screen.getByText(/Autopilot session/)).toBeInTheDocument();
    expect(screen.getByText(/1m 30s|1m 2\ds/)).toBeInTheDocument();
    expect(screen.getByText('waiting on the image build')).toBeInTheDocument();
    // Up next, from the board's own dependency column.
    expect(screen.getByText(/after P6/)).toBeInTheDocument();
  });

  it('renders nothing for an idle plan', () => {
    const { container } = render(<PlanPulse slug="demo" run={run({ status: 'finished', activePhase: null })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('pulseRuns', () => {
  it('keeps the newest run per plan, live plans first, and forgets old stopped ones', () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const rows = pulseRuns([
      run({ id: 'a-old', slug: 'alpha', status: 'finished', updatedAt: stale }),
      run({ id: 'b', slug: 'beta', status: 'finished', updatedAt: fresh }),
      run({ id: 'c', slug: 'gamma', status: 'running', updatedAt: fresh }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['gamma', 'beta']);
  });
});

describe('isLiveRun', () => {
  it('counts the states with a process behind them, nothing else', () => {
    expect(isLiveRun(run({ status: 'running' }))).toBe(true);
    expect(isLiveRun(run({ status: 'frozen' }))).toBe(true);
    expect(isLiveRun(run({ status: 'halted' }))).toBe(false);
    expect(isLiveRun(null)).toBe(false);
  });
});
