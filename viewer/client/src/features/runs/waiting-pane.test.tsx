/**
 * The second queue.
 *
 * The property worth pinning is honesty about the future: a phase whose
 * dependencies are unfinished must appear SOMEWHERE on the run page, naming
 * exactly what it waits on — the page without this read as "the autopilot
 * stops after the current phases", which is not what the loop does. And a
 * phase that already has a lane tab must never appear twice: the plan detail
 * and the run are separate snapshots that can skew.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WaitingPane, waitingOf } from './waiting-pane';
import type { PlanDetail } from '@/lib/api';

function detail(): PlanDetail {
  return {
    summary: { slug: 'demo' },
    phases: [
      { phase: 7, title: 'the api', state: 'in-progress', gated: false, bullets: [] },
      { phase: 9, title: 'the tests', state: 'ready', gated: false, bullets: [] },
      {
        phase: 10,
        title: 'the docs',
        state: 'waiting',
        gated: false,
        bullets: [],
        analysis: {
          phase: 10,
          state: 'waiting',
          size: 'M',
          weight: 1,
          dependsOn: [7, 9],
          dependents: [],
          transitiveDependents: [],
          unblocks: 0,
          onCriticalPath: false,
        },
      },
      {
        phase: 11,
        title: 'the release',
        state: 'waiting',
        gated: true,
        gates: 'phase 10 verified',
        bullets: [],
        analysis: {
          phase: 11,
          state: 'waiting',
          size: 'S',
          weight: 1,
          dependsOn: [10],
          dependents: [],
          transitiveDependents: [],
          unblocks: 0,
          onCriticalPath: false,
        },
      },
    ],
    eta: { plan: null, perPhase: [{ phase: 10, estMs: 30 * 60_000, label: '~30m' }] },
  } as unknown as PlanDetail;
}

describe('waitingOf', () => {
  it('lists waiting phases with each unmet dependency and its own state', () => {
    const rows = waitingOf(detail());
    expect(rows.map((row) => row.phase)).toEqual([10, 11]);
    // Done dependencies are not "waited on" — only the unmet ones are named.
    expect(rows[0].deps).toEqual([
      { phase: 7, state: 'in-progress' },
      { phase: 9, state: 'ready' },
    ]);
    expect(rows[0].estMs).toBe(30 * 60_000);
    expect(rows[1].gated).toBe(true);
  });

  it('never duplicates a phase that already has a lane tab', () => {
    const rows = waitingOf(detail(), new Set([10]));
    expect(rows.map((row) => row.phase)).toEqual([11]);
  });

  it('holds a done-but-QA-pending dependency as unmet, named as QA', () => {
    const gatedDetail = detail();
    (gatedDetail.phases[0] as { state: string; qa?: { result: string } }).state = 'done';
    (gatedDetail.phases[0] as { state: string; qa?: { result: string } }).qa = { result: 'pending' };
    const rows = waitingOf(gatedDetail);
    expect(rows[0].deps).toContainEqual({ phase: 7, state: 'QA pending' });
  });
});

describe('WaitingPane', () => {
  it('says the phases start themselves — the claim the page existed to make', () => {
    render(<WaitingPane rows={waitingOf(detail())} />);
    expect(screen.getByText(/keeps going until the whole graph is done/)).toBeTruthy();
    expect(screen.getAllByText(/Starts by itself the moment these finish/).length).toBe(2);
    expect(screen.getByText(/P7 · in-progress/)).toBeTruthy();
    expect(screen.getByText(/phase 10 verified/)).toBeTruthy();
  });

  it('renders nothing at all when nothing waits', () => {
    const { container } = render(<WaitingPane rows={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
