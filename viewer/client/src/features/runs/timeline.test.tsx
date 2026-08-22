/**
 * The timeline's whole claim is arithmetic: a phase's wall clock, split three
 * ways, from clocks the runner already wrote. So the tests are mostly about
 * `spansOf` — the part that can be wrong silently.
 *
 * The two that matter most are the CLAMPS. A `frozenMs` or a park that
 * outlived its phase would paint a bar wider than the run, and both are real:
 * a console restart across a park leaves `parkedUntil` in the future with a
 * `startedAt` from before the restart.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Timeline, spansOf } from './timeline';
import type { PhaseRecord } from '@/lib/api';

const T0 = Date.parse('2026-08-22T10:00:00.000Z');
const MIN = 60_000;

function record(over: Partial<PhaseRecord> & { phase: number }): PhaseRecord {
  return { status: 'done', attempts: 1, costUsd: 0, ...over } as PhaseRecord;
}

describe('spansOf', () => {
  it('splits a finished phase into working, waiting and frozen', () => {
    const [span] = spansOf(
      [
        record({
          phase: 1,
          startedAt: new Date(T0).toISOString(),
          endedAt: new Date(T0 + 10 * MIN).toISOString(),
          durationMs: 10 * MIN,
          frozenMs: 2 * MIN,
          parkedUntil: new Date(T0 + 3 * MIN).toISOString(),
        }),
      ],
      T0 + 20 * MIN,
    );
    expect(span!.totalMs).toBe(10 * MIN);
    expect(span!.frozenMs).toBe(2 * MIN);
    expect(span!.waitingMs).toBe(3 * MIN);
    // The remainder, never a fourth independently-measured figure — the three
    // must sum to the duration or the bar lies about its own width.
    expect(span!.workingMs).toBe(5 * MIN);
    expect(span!.workingMs + span!.frozenMs + span!.waitingMs).toBe(span!.totalMs);
    expect(span!.live).toBe(false);
  });

  it('clamps a frozen clock that outran the phase', () => {
    // `frozenMs` is written by the runner and the duration by the closeout;
    // a restart between them can leave the first larger. The bar must not
    // grow past the run.
    const [span] = spansOf(
      [
        record({
          phase: 2,
          startedAt: new Date(T0).toISOString(),
          durationMs: 5 * MIN,
          frozenMs: 99 * MIN,
          endedAt: new Date(T0 + 5 * MIN).toISOString(),
        }),
      ],
      T0 + 10 * MIN,
    );
    expect(span!.frozenMs).toBe(5 * MIN);
    expect(span!.workingMs).toBe(0);
  });

  it('counts a park that is still running only up to now', () => {
    // `parkedUntil` is in the FUTURE while parked. Subtracting it from
    // anything is how a phase ends up with negative working time.
    const [span] = spansOf(
      [
        record({
          phase: 3,
          status: 'waiting',
          startedAt: new Date(T0).toISOString(),
          parkedUntil: new Date(T0 + 60 * MIN).toISOString(),
        }),
      ],
      T0 + 20 * MIN,
    );
    expect(span!.waitingMs).toBe(20 * MIN);
    expect(span!.totalMs).toBe(20 * MIN);
    expect(span!.live).toBe(true);
  });

  it('measures an open phase against the clock, and marks it live', () => {
    const [span] = spansOf(
      [record({ phase: 4, status: 'running', startedAt: new Date(T0).toISOString() })],
      T0 + 7 * MIN,
    );
    expect(span!.totalMs).toBe(7 * MIN);
    expect(span!.live).toBe(true);
  });

  it('drops phases that never started, and orders by phase', () => {
    const spans = spansOf(
      [
        record({
          phase: 9,
          startedAt: new Date(T0).toISOString(),
          durationMs: MIN,
          endedAt: new Date(T0 + MIN).toISOString(),
        }),
        record({
          phase: 2,
          startedAt: new Date(T0).toISOString(),
          durationMs: MIN,
          endedAt: new Date(T0 + MIN).toISOString(),
        }),
        record({ phase: 5 }),
      ],
      T0,
    );
    expect(spans.map((s) => s.phase)).toEqual([2, 9]);
  });
});

describe('<Timeline>', () => {
  it('draws a bar per phase, with the three segments in its accessible name', () => {
    render(
      <Timeline
        now={T0 + 30 * MIN}
        phases={[
          record({
            phase: 1,
            startedAt: new Date(T0).toISOString(),
            endedAt: new Date(T0 + 10 * MIN).toISOString(),
            durationMs: 10 * MIN,
            frozenMs: 2 * MIN,
          }),
        ]}
      />,
    );
    const bar = screen.getByRole('img');
    expect(bar).toHaveAccessibleName(/phase 1/);
    expect(bar).toHaveAccessibleName(/working/);
    expect(bar).toHaveAccessibleName(/frozen/);
  });

  it('says so rather than drawing an empty chart when nothing has run', () => {
    render(<Timeline phases={[]} now={T0} />);
    expect(screen.getByText(/Nothing has taken any time yet/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
