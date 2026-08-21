/**
 * How an estimate reads.
 *
 * The arithmetic is the server's and is tested there. What is pinned here is the
 * half that is easy to get wrong and impossible to notice: the HEDGE. Five
 * surfaces render the same estimate, and a plan that has never run borrows a
 * number from other plans or falls back to a constant — so the difference
 * between "we measured this" and "we guessed this" exists only in these words.
 * Drop the suffix and the console states a guess as a measurement.
 */

import { describe, expect, it } from 'vitest';
import { etaLabel, etaPoint, etaTitle } from './format';
import type { EtaEstimate } from './api';

const MIN = 60_000;
const HOUR = 3_600_000;

function estimate(over: Partial<EtaEstimate> = {}): EtaEstimate {
  return {
    ratePerWeight: 60,
    samples: 4,
    basis: 'plan',
    remainingWeight: 120_000,
    remainingPhases: 3,
    lowMs: HOUR,
    highMs: 3 * HOUR,
    label: '~1 h–3 h left',
    ...over,
  };
}

describe('etaLabel', () => {
  it('says where the number came from, every time', () => {
    expect(etaLabel(HOUR, 3 * HOUR, 'plan')).toContain('(estimate)');
    expect(etaLabel(HOUR, 3 * HOUR, 'portfolio')).toContain('(from other plans)');
    expect(etaLabel(HOUR, 3 * HOUR, 'heuristic')).toContain('(rough guess)');
  });

  it('hedges even its strongest reading', () => {
    // The best evidence available is still a model's throughput on work nobody
    // has looked at yet. There is no basis that renders bare.
    for (const basis of ['plan', 'portfolio', 'heuristic'] as const) {
      expect(etaLabel(HOUR, 3 * HOUR, basis)).toMatch(/\(.+\)$/);
    }
  });

  it('prints a collapsed range once rather than as a repeated bound', () => {
    expect(etaLabel(5 * MIN, 5 * MIN, 'plan')).toBe('~5 min (estimate)');
  });

  it('never renders to the second', () => {
    expect(etaLabel(90_000, 150_000, 'plan')).not.toMatch(/\ds\b/);
  });

  it('reads in the units a person would say out loud', () => {
    expect(etaLabel(20 * MIN, 40 * MIN, 'plan')).toBe('~20 min–40 min (estimate)');
    expect(etaLabel(2 * HOUR, 5 * HOUR, 'plan')).toBe('~2 h–5 h (estimate)');
    expect(etaLabel(90 * MIN, 90 * MIN, 'plan')).toBe('~1.5 h (estimate)');
    expect(etaLabel(2 * 86_400_000, 3 * 86_400_000, 'plan')).toBe('~2.0 d–3.0 d (estimate)');
  });

  it('falls back to the weakest hedge rather than none for an unknown basis', () => {
    // A server that grows a fourth basis must not silently render unhedged.
    expect(etaLabel(HOUR, HOUR, 'made-up' as never)).toContain('(rough guess)');
  });
});

describe('etaPoint', () => {
  it('is a point with no hedge and no "left" — a phase not started has none', () => {
    expect(etaPoint(40 * MIN)).toBe('~40 min');
    expect(etaPoint(40 * MIN)).not.toMatch(/left|–|\(/);
  });
});

describe('etaTitle', () => {
  it('names this plan when the evidence is this plan', () => {
    expect(etaTitle(estimate({ basis: 'plan', samples: 4 }))).toContain('4 finished phases of this plan');
  });

  it('says out loud that it borrowed the number', () => {
    const title = etaTitle(estimate({ basis: 'portfolio', samples: 9 }));
    expect(title).toContain('other plans');
    expect(title).toContain('this one has none yet');
  });

  it('admits outright when there is no evidence at all', () => {
    const title = etaTitle(estimate({ basis: 'heuristic', samples: 0 }));
    expect(title).toContain('no finished phase anywhere');
    expect(title).not.toContain('0 finished phases');
  });
});
