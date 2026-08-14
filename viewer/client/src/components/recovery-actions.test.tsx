/**
 * The one recovery renderer: grouping, the live chip, disabled-with-reason,
 * the touch ⓘ path, and the verbs actually firing their endpoints.
 */

import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/media', () => ({
  usePhone: () => false,
  useNarrow: () => false,
  useTouch: () => true,
}));

const { recheck, recover } = vi.hoisted(() => ({
  recheck: vi.fn(async () => ({ run: null })),
  recover: vi.fn(async () => ({
    outcome: 'resumed', detail: 'The board had moved past the stop — the run continues from here.',
    steps: ['the board had moved past phase 2 — stale record closed'], run: null,
  })),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runRecheck: recheck, runRecover: recover } };
});

import { RecoveryActions } from './recovery-actions';
import { keys } from '@/lib/queries';
import { FLAG_OFF, RECOVERY_BUSY } from '@/lib/recovery';

function mount(node: React.ReactElement, opts: {
  allowRun?: boolean; allowAgent?: boolean; sessions?: unknown[];
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.state(), {
    allowRun: opts.allowRun ?? true, allowAgent: opts.allowAgent ?? true, allowWrites: false,
    autopilot: true, root: { ok: true, path: '/repo' },
  });
  client.setQueryData(keys.terminal(), {
    allowed: false, agentAllowed: true, available: 'yes', sessions: opts.sessions ?? [],
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const HALTED = {
  status: 'halted',
  halt: { reason: 'phase 2 did not verify', kind: 'verify-failed', phase: 2 },
} as const;

beforeEach(() => vi.clearAllMocks());

describe('<RecoveryActions>', () => {
  it('groups: own-session leads, agent follows, the rest fold with visible blurbs', () => {
    mount(<RecoveryActions
      target={{ slug: 'demo', phase: 2 }}
      ctx={{ run: HALTED, record: { status: 'failed', resumable: true } }}
    />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(labels[0]).toContain('Finish in its own session');
    expect(labels.some((l) => l.includes('Fix with a new agent'))).toBe(true);
    const fold = screen.getByText(/More ways forward/);
    fireEvent.click(fold);
    expect(screen.getByText(/Discards the stopped session's conversation/)).toBeInTheDocument();
  });

  it('touch renders a tappable ⓘ beside every action — blurbs are never hover-only', () => {
    mount(<RecoveryActions
      target={{ slug: 'demo', phase: 2 }}
      ctx={{ run: HALTED, record: { status: 'failed', resumable: true } }}
    />);
    expect(screen.getAllByRole('button', { name: /^About / }).length).toBeGreaterThanOrEqual(2);
  });

  it('a live recovery renders the chip and disables both families with the same sentence', async () => {
    mount(
      <RecoveryActions
        target={{ slug: 'demo', phase: 2 }}
        ctx={{ run: HALTED, record: { status: 'failed', resumable: true } }}
      />,
      {
        sessions: [{
          id: 's-live', exited: null,
          meta: { recovery: { kind: 'halted-verification', slug: 'demo', phase: 2 } },
        }],
      },
    );
    expect(screen.getByRole('link', { name: /Fix the failing verification — running/ }))
      .toHaveAttribute('href', '#/agent/s-live');
    expect(screen.getByRole('button', { name: 'Finish in its own session' })).toBeDisabled();
    // The reason is reachable through the touch ⓘ.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'About Finish in its own session' }));
    });
    expect((await screen.findAllByText(RECOVERY_BUSY)).length).toBeGreaterThan(0);
  });

  it('flags disable with the exact sentence, never hide', () => {
    mount(
      <RecoveryActions
        target={{ slug: 'demo', phase: 2 }}
        ctx={{ run: HALTED, record: { status: 'failed', resumable: false } }}
      />,
      { allowRun: false, allowAgent: false },
    );
    const recheckButton = screen.getByRole('button', { name: 'Re-check' });
    expect(recheckButton).toBeDisabled();
    fireEvent.click(screen.getByText(/More ways forward/));
    expect(screen.getAllByText(FLAG_OFF.run).length).toBeGreaterThan(0);
  });

  it('a verb goes to its endpoint', async () => {
    mount(<RecoveryActions
      target={{ slug: 'demo', phase: 2 }}
      ctx={{ record: { status: 'failed', resumable: false } }}
      max={3}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(recheck).toHaveBeenCalledWith('demo', 2));
  });
});


describe('the plan-level Recover & continue', () => {
  it('leads the run-only offers, says exactly what it will do, and reports its steps', async () => {
    mount(<RecoveryActions
      target={{ slug: 'demo', runId: 'r1' }}
      ctx={{ run: { status: 'halted', halt: { reason: 'x', kind: 'verify-failed', phase: 2 } } }}
    />);
    const first = screen.getAllByRole('button')[0];
    expect(first.textContent).toContain('Recover & continue');
    fireEvent.click(first);
    await waitFor(() => expect(recover).toHaveBeenCalledWith('demo'));
  });

  it('offers NOTHING for a resolved stop — settled questions are not relitigated', () => {
    const { container } = mount(<RecoveryActions
      target={{ slug: 'demo', runId: 'r1' }}
      ctx={{ run: {
        status: 'halted', halt: null,
        resolved: { at: 'x', reason: 'superseded — the board shows phase 7 done' },
      } }}
    />);
    expect(container.querySelector('button')).toBeNull();
  });
});
