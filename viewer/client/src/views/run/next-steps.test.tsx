/**
 * The "way forward" card: every stopped phase's cause in its own words, next
 * to the one action that moves it. What is pinned is the honesty contract —
 * the handoff's Outstanding text speaks for a blocked phase, the gate's own
 * conditions speak for a gated one (and nothing offers to bypass it), and a
 * failed record gets the recovery class its evidence supports.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { PhaseView, RunState } from '@/lib/api';
import { NextSteps, nextStepRows } from './next-steps';

const phase = (over: Partial<PhaseView>): PhaseView => ({
  phase: 1, title: 'A phase', state: 'ready', size: 'S', weight: 1, gated: false, bullets: [],
  ...over,
} as PhaseView);

const run = (over: Partial<RunState>): RunState => ({
  id: 'r1', slug: 'demo', root: '/repo', status: 'parked', autonomy: 'keep-going',
  model: 'opus', createdAt: '', updatedAt: '', activePhase: null, child: null,
  waitUntil: null, halt: null, pause: null, freeze: null, phases: {},
  spentUsd: 0, maxConsecutiveFailures: 2, consecutiveFailures: 0,
  ...over,
} as unknown as RunState);

describe('nextStepRows', () => {
  it('lets a blocked handoff speak for itself, and routes it to plan-repair', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 5, state: 'stuck', title: 'Rollout', handoff: {
        file: 'phase-05-x.md', status: 'blocked', title: 'x', skillsUsed: [], prompts: 0,
        outstanding: '**One exit criterion is unmet**, and it needs a human.',
      } }),
    ], null, false);

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain('One exit criterion is unmet');
    expect(rows[0].recoveryClass).toBe('plan-repair');
    expect(rows[0].retry).toBeUndefined();
  });

  it('quotes the gate for a gated phase and offers only a re-check, never a bypass', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 2, state: 'ready', gated: true, gates: 'operator confirms the auth-off rail' }),
    ], null, false);

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain('operator confirms the auth-off rail');
    expect(rows[0].retry).toBe('rechecks-gate');
    expect(rows[0].recoveryClass).toBeUndefined();
  });

  it('prefers the runner\'s own parked note when the record has one', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 2, state: 'ready', gated: true }),
    ], run({ phases: { 2: { phase: 2, status: 'parked', attempts: 0, costUsd: 0,
      note: 'gate not clear: manual — confirm the rollout window' } } } as never), false);

    expect(rows[0].why).toContain('confirm the rollout window');
  });

  it('gives a failed record its recovery class and a Retry that restarts', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 3, state: 'ready', title: 'Ship' }),
    ], run({
      halt: { at: '', reason: 'phase 3 did not verify: 1 of 1 command(s) failed — false', phase: 3 },
      phases: { 3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0 } },
    } as never), false);

    expect(rows[0].recoveryClass).toBe('halted-verification');
    expect(rows[0].retry).toBe('restarts');
    expect(rows[0].why).toContain('did not verify');
  });

  it('says nothing about phases that are done or genuinely in flight', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 1, state: 'done' }),
      phase({ phase: 2, state: 'ready' }),
    ], null, false);
    expect(rows).toHaveLength(0);
  });
});

describe('NextSteps', () => {
  function mount(node: React.ReactElement) {
    const client = new QueryClient(queryClientConfig);
    return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  }

  it('renders a stuck phase with Repair with AI, and a gated one with its confirmation chip', () => {
    const onRecover = vi.fn();
    const onRetry = vi.fn();
    mount(<NextSteps
      slug="demo"
      planPhases={[
        phase({ phase: 5, state: 'stuck', title: 'Rollout', handoff: {
          file: 'phase-05-x.md', status: 'blocked', title: 'x', skillsUsed: [], prompts: 0,
          outstanding: 'the shutdown acceptance test needs a human',
        } }),
        phase({ phase: 2, state: 'ready', gated: true, gates: 'confirm the window' }),
      ]}
      run={null}
      live={false}
      allowRun
      allowAgent
      authFailure={false}
      onRecover={onRecover}
      onRetry={onRetry}
    />);

    expect(screen.getByText(/Why this is stopped/)).toBeInTheDocument();
    expect(screen.getByText(/shutdown acceptance test needs a human/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Repair with AI/i }));
    expect(onRecover).toHaveBeenCalledWith(5, 'plan-repair');

    expect(screen.getByText(/confirm the window/)).toBeInTheDocument();
    expect(screen.getByText(/needs your confirmation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry \(re-checks the gate\)/i }));
    expect(onRetry).toHaveBeenCalledWith(2);
  });

  it('renders nothing while the run is live — the tabs are the truth then', () => {
    const { container } = mount(<NextSteps
      slug="demo"
      planPhases={[phase({ phase: 5, state: 'stuck' })]}
      run={null}
      live
      allowRun
      allowAgent
      authFailure={false}
      onRecover={() => {}}
      onRetry={() => {}}
    />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('failed here, finished elsewhere', () => {
  it('explains a red record on a green phase instead of offering to fix it', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 1, state: 'done', title: 'Editor truth' }),
    ], run({ phases: { 1: { phase: 1, status: 'failed', attempts: 1, costUsd: 0,
      note: 'no configuration file provided' } } } as never), false);

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain("this run's own attempt stopped");
    expect(rows[0].why).toContain('no configuration file provided');
    expect(rows[0].why).toContain('Nothing needs fixing');
    expect(rows[0].recoveryClass).toBeUndefined();
    expect(rows[0].retry).toBeUndefined();
  });

  it('stays quiet about done phases whose record is clean', () => {
    const rows = nextStepRows('demo', [
      phase({ phase: 1, state: 'done' }),
    ], run({ phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 } } } as never), false);
    expect(rows).toHaveLength(0);
  });
});
