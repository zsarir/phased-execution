/**
 * **Running now** — the lanes, and what they refuse to imply.
 *
 * Every fact on a lane row has a "cannot tell you" rendering, and those are
 * what these cases are mostly about. A heartbeat that keeps pulsing over a
 * wedged session, an ETA invented in the browser and a queued lane with no
 * explanation are three different ways of being confidently wrong on the page
 * an operator checks first.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ForeignSession } from '@/lib/api';
import { LiveLanes } from './live-lanes';
import type { NowLane } from './model';

const lane = (over: Partial<NowLane> = {}): NowLane => ({
  key: 'r1#4',
  slug: 'demo',
  planTitle: 'Demo plan',
  runId: 'r1',
  phase: 4,
  title: 'Wire the ingest',
  status: 'running',
  runStatus: 'running',
  model: 'opus',
  effort: 'max',
  startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  costUsd: 2.5,
  attempts: 1,
  frozen: false,
  enriched: true,
  ...over,
});

function mount(props: Partial<React.ComponentProps<typeof LiveLanes>> = {}) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/now">
        <LiveLanes
          lanes={[lane()]}
          allowRun
          signedOut={false}
          ready={0}
          needsYou={0}
          others={[]}
          {...props}
        />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('a lane row', () => {
  it('carries the state, the phase, the cost, the elapsed clock and the model', () => {
    mount();
    const row = screen.getByTestId('lane-row');
    expect(row.textContent).toContain('demo');
    expect(row.textContent).toContain('phase 4');
    expect(row.textContent).toContain('Wire the ingest');
    expect(row.textContent).toContain('$2.50');
    expect(row.textContent).toContain('opus');
  });

  it('says "no ETA" rather than computing one — the estimate is the server’s', () => {
    mount();
    expect(screen.getByText('no ETA')).toBeTruthy();
    // With one, it is shown verbatim: the label is the server's own words.
    mount({
      lanes: [lane({ eta: { phase: 4, weight: 40_000, estMs: 3_600_000, basis: 'plan', label: '1h' } })],
    });
    expect(screen.getAllByText('~1h').length).toBeGreaterThan(0);
  });

  it('stops the heartbeat pulsing once the silence passes the stall floor', () => {
    // A dot that keeps beating over a wedged session is the lie this console
    // exists not to tell — past the floor it says how long the silence is.
    mount({
      lanes: [
        lane({
          liveness: {
            phase: 4,
            lastOutputAt: new Date(Date.now() - 40 * 60_000).toISOString(),
            turnsSinceLastTool: 0,
            commitsSinceStart: 0,
            treeDirty: false,
          },
        }),
      ],
    });
    expect(screen.getByRole('status', { name: /lane: silent/ })).toBeTruthy();
  });

  it('badges a stall with the runner’s own word and its clock', () => {
    mount({
      lanes: [
        lane({
          liveness: {
            phase: 4,
            lastOutputAt: new Date(Date.now() - 40 * 60_000).toISOString(),
            turnsSinceLastTool: 7,
            commitsSinceStart: 0,
            treeDirty: false,
            stall: {
              signal: 'spinning',
              since: new Date(Date.now() - 10 * 60_000).toISOString(),
              detail: '7 turns',
            },
          },
        }),
      ],
    });
    expect(screen.getByText(/Spinning/)).toBeTruthy();
  });

  it('explains a lane that is not running instead of leaving "queued" bare', () => {
    mount({
      lanes: [lane({ status: 'queued', lockWaitSince: new Date(Date.now() - 30 * 60_000).toISOString() })],
    });
    expect(screen.getByText(/Queued behind another owner's claim/)).toBeTruthy();

    mount({
      lanes: [
        lane({
          status: 'waiting',
          parkedUntil: new Date(Date.now() + 600_000).toISOString(),
          parkReason: 'the CI image build',
          watch: ['gh:acme/widgets#run/42'],
        }),
      ],
    });
    expect(screen.getByText(/the CI image build/)).toBeTruthy();
    expect(screen.getByText(/gh:acme\/widgets#run\/42/)).toBeTruthy();
  });

  it('keeps the tail collapsed, and says so rather than looking broken when it is empty', () => {
    mount();
    expect(screen.queryByTestId('lane-tail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Tail & steer/ }));
    expect(screen.getByText(/Nothing has come through since this page opened/)).toBeTruthy();
  });
});

describe('when nothing is running', () => {
  const idle = { lanes: [] as NowLane[] };

  it('names the wall, the read-only console, the queue and the empty board differently', () => {
    const { unmount } = mount({ ...idle, signedOut: true });
    expect(screen.getByText(/signed out/)).toBeTruthy();
    unmount();

    const second = mount({ ...idle, allowRun: false });
    expect(screen.getByText(/cannot start anything/)).toBeTruthy();
    second.unmount();

    mount({ ...idle, ready: 4 });
    expect(screen.getByText(/Next up is below/)).toBeTruthy();
  });
});

describe('sessions no lane accounts for', () => {
  it('lists them under running now, because that is what they are', () => {
    const session = {
      sessionId: 'abcdef1234',
      kind: 'agent',
      cwd: '/tmp/hub',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastSeen: new Date().toISOString(),
      turns: 3,
      presence: 'live',
      user: 'sam',
      host: 'laptop',
    } as ForeignSession;
    mount({ others: [session] });
    const row = screen.getByTestId('other-session');
    expect(row.textContent).toContain('sam@laptop');
    expect(row.textContent).toContain('abcdef12');
  });
});

// The section subscribes to `run:stream` once for every row rather than once
// per row — asserted where it is decidable, at the module's own seam.
describe('the tail subscription', () => {
  it('is one subscription for the whole section', async () => {
    const sse = await import('@/lib/sse');
    const spy = vi.spyOn(sse, 'onSse');
    mount({ lanes: [lane({ key: 'r1#4', phase: 4 }), lane({ key: 'r1#5', phase: 5 })] });
    expect(spy.mock.calls.filter(([name]) => name === 'run:stream')).toHaveLength(1);
    spy.mockRestore();
  });
});
