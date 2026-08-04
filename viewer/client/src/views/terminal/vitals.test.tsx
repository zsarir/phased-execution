/**
 * The session vitals bar: plan · phase · time passed · ETA.
 *
 * What is pinned is attribution honesty — the linkage comes only from the
 * session's own meta (recovery/QA sessions name a `(slug, phase)`); a plain
 * shell shows a clock and claims nothing; the estimate is the plan's own
 * per-phase ETA and reads "over" past it rather than counting to zero.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { TerminalSession } from '@/lib/api';

const { plan } = vi.hoisted(() => ({ plan: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, plan } };
});

import { SessionVitals, sessionLinkage } from './vitals';

beforeEach(() => { plan.mockReset(); });

const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 't1',
  label: 'a session',
  kind: 'claude',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 4242,
  clients: 1,
  createdAt: Date.now() - 2 * 60_000,
  ...over,
});

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('sessionLinkage', () => {
  it('reads the recovery meta, then the QA meta, and otherwise claims nothing', () => {
    expect(sessionLinkage(session({ meta: { recovery: { kind: 'halted-verification', slug: 'alpha', phase: 3 } } })))
      .toEqual({ slug: 'alpha', phase: 3 });
    expect(sessionLinkage(session({ meta: { qa: { slug: 'beta', phase: 5 } } })))
      .toEqual({ slug: 'beta', phase: 5 });
    expect(sessionLinkage(session())).toEqual({});
  });
});

describe('SessionVitals', () => {
  it('shows plan · phase · elapsed · the phase\'s own estimate for a linked session', async () => {
    plan.mockResolvedValue({
      eta: {
        plan: null,
        perPhase: [{ phase: 3, weight: 1, estMs: 10 * 60_000, basis: 'plan', label: '~10m (estimate)' }],
      },
    });
    mount(<SessionVitals
      session={session({ meta: { recovery: { kind: 'halted-verification', slug: 'alpha', phase: 3 } } })}
    />);

    expect(screen.getByText('alpha · P3')).toBeInTheDocument();
    expect(screen.getByText('2:00')).toBeInTheDocument();
    expect(await screen.findByText(/10:00/)).toBeInTheDocument();
    expect(screen.getByText(/est/)).toBeInTheDocument();
  });

  it('a plain shell gets its clock and no invented attribution', () => {
    mount(<SessionVitals session={session({ kind: 'shell', meta: undefined })} />);
    expect(screen.getByText('2:00')).toBeInTheDocument();
    expect(plan).not.toHaveBeenCalled();
    expect(screen.queryByText(/P\d/)).toBeNull();
  });

  it('says "over" past the estimate instead of counting to a fictitious zero', async () => {
    plan.mockResolvedValue({
      eta: {
        plan: null,
        perPhase: [{ phase: 3, weight: 1, estMs: 60_000, basis: 'plan', label: '~1m (estimate)' }],
      },
    });
    mount(<SessionVitals
      session={session({ meta: { recovery: { kind: 'halted-verification', slug: 'alpha', phase: 3 } } })}
    />);
    expect(await screen.findByText(/over the ~/)).toBeInTheDocument();
    expect(screen.getByText(/estimate/)).toBeInTheDocument();
  });
});
