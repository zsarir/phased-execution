/**
 * How long is left.
 *
 * The estimator is small, which is exactly why it is worth pinning: a figure
 * this cheap to produce is one somebody will read off the screen and plan an
 * evening around. What is asserted here is mostly what it *refuses* to say —
 * nothing at all without evidence, nothing precise with a little, and never a
 * countdown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emaRate, estimateEta, etaFrom, etaSamples, phaseEtaFor, rateFor,
  ETA_ALPHA, HEURISTIC_RATE_PER_WEIGHT,
} from '../server/analysis/stats.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

/** 15K / 40K / 90K, the S/M/L weights from `scripts/sizing.env`. */
const S = 15_000;
const M = 40_000;
const L = 90_000;

test('with no finished phase there is no estimate at all', () => {
  assert.equal(emaRate([]), null);
  assert.equal(estimateEta([], { weight: L * 3, phases: 3 }), null);
});

test('with nothing left to do there is nothing to estimate', () => {
  const samples = [{ weight: M, durationMs: 40 * MIN }];
  assert.equal(estimateEta(samples, { weight: 0, phases: 0 }), null);
});

test('one sample sets the rate outright', () => {
  // 40 minutes for an M is one minute per thousand weight.
  const rate = emaRate([{ weight: M, durationMs: 40 * MIN }])!;
  assert.equal(rate, (40 * MIN) / M);
});

test('the rate is weight-normalised, so a small phase does not read as fast', () => {
  // Same throughput, very different wall-clocks: an S in 15 min and an L in
  // 90 min are the same rate, and a naive per-phase average would call the
  // second one six times slower.
  const rate = emaRate([
    { weight: S, durationMs: 15 * MIN },
    { weight: L, durationMs: 90 * MIN },
  ])!;
  assert.equal(rate, MIN / 1000, 'both phases agree, so smoothing changes nothing');
});

test('the newest phase carries alpha of the estimate, and the rest decays', () => {
  // A run that switches from haiku/low to opus/xhigh halfway is the case this
  // exists for: a plain mean would hold the fast early phases forever.
  const fast = { weight: M, durationMs: 10 * MIN };
  const slow = { weight: M, durationMs: 60 * MIN };
  const rate = emaRate([fast, fast, slow], ETA_ALPHA)!;

  const fastRate = (10 * MIN) / M;
  const slowRate = (60 * MIN) / M;
  assert.equal(rate, ETA_ALPHA * slowRate + (1 - ETA_ALPHA) * fastRate);
  assert.ok(rate > fastRate && rate < slowRate, 'it moved toward the new evidence without jumping to it');
});

test('order is the whole behaviour, so reversing the samples changes the answer', () => {
  const a = { weight: M, durationMs: 10 * MIN };
  const b = { weight: M, durationMs: 60 * MIN };
  assert.notEqual(emaRate([a, b]), emaRate([b, a]));
});

test('a fixed sequence produces a labelled range, and never a countdown', () => {
  // Three M phases at 40 minutes each, three M phases left.
  const samples = [
    { weight: M, durationMs: 40 * MIN },
    { weight: M, durationMs: 40 * MIN },
    { weight: M, durationMs: 40 * MIN },
  ];
  const eta = estimateEta(samples, { weight: M * 3, phases: 3 })!;

  assert.equal(eta.samples, 3);
  assert.equal(eta.remainingPhases, 3);
  // 2 hours of work, banded and snapped: the point estimate must sit inside it.
  assert.ok(eta.lowMs < 2 * HOUR && eta.highMs > 2 * HOUR, `${eta.label} does not contain 2h`);
  assert.match(eta.label, /^~.+ left$/);
  assert.match(eta.label, /h|min/);
  assert.doesNotMatch(eta.label, /\ds\b/, 'never to the second');
});

test('less evidence widens the band rather than hiding the doubt', () => {
  const one = estimateEta([{ weight: M, durationMs: 40 * MIN }], { weight: M * 4, phases: 4 })!;
  const many = estimateEta(
    Array.from({ length: 5 }, () => ({ weight: M, durationMs: 40 * MIN })),
    { weight: M * 4, phases: 4 },
  )!;
  assert.ok(
    one.highMs - one.lowMs > many.highMs - many.lowMs,
    'one sample must not read as confidently as five',
  );
});

test('the range snaps to a scale a person would say out loud', () => {
  const eta = estimateEta(
    Array.from({ length: 4 }, () => ({ weight: M, durationMs: 40 * MIN })),
    { weight: M * 6, phases: 6 },
  )!;
  // 4 hours ± 35% → snapped to whole or half hours, nothing like "2h 37m".
  assert.equal(eta.lowMs % (HOUR / 2), 0);
  assert.equal(eta.highMs % (HOUR / 2), 0);
});

test('a tiny remainder still reads as a floor rather than as zero', () => {
  const eta = estimateEta([{ weight: M, durationMs: 40 * MIN }], { weight: 500, phases: 1 })!;
  assert.equal(eta.lowMs, 5 * MIN);
  assert.match(eta.label, /5 min/);
});

/* ---------------- gathering the samples ---------------- */

const weights = new Map([[1, S], [2, M], [3, L]]);

test('only phases that finished are evidence of how long a phase takes', () => {
  const samples = etaSamples([{
    phases: {
      1: { phase: 1, status: 'done', durationMs: 15 * MIN, endedAt: '2026-08-01T10:00:00Z' },
      2: { phase: 2, status: 'interrupted', durationMs: 90 * MIN, endedAt: '2026-08-01T11:00:00Z' },
      3: { phase: 3, status: 'done', durationMs: 0, endedAt: '2026-08-01T12:00:00Z' },
    },
  }], weights);
  // An interrupted phase measures when somebody pressed Stop; a zero-length one
  // measures nothing at all.
  assert.deepEqual(samples.map((s) => s.weight), [S]);
});

test('samples come from every run of the plan, oldest first', () => {
  // This is what lets an estimate exist before the CURRENT run's first phase
  // has finished — the reason to look across runs at all.
  const samples = etaSamples([
    { phases: { 2: { phase: 2, status: 'done', durationMs: 50 * MIN, endedAt: '2026-08-02T09:00:00Z' } } },
    { phases: { 1: { phase: 1, status: 'done', durationMs: 20 * MIN, endedAt: '2026-08-01T09:00:00Z' } } },
  ], weights);
  assert.deepEqual(samples.map((s) => s.durationMs), [20 * MIN, 50 * MIN]);
});

test('a phase the plan no longer sizes is not a sample', () => {
  // A phase number the graph does not carry has no weight, and a rate needs one.
  const samples = etaSamples([{
    phases: { 9: { phase: 9, status: 'done', durationMs: 30 * MIN, endedAt: '2026-08-01T09:00:00Z' } },
  }], weights);
  assert.deepEqual(samples, []);
});

/* ---------------- the fallback chain ----------------
 * Suppression used to be the answer to "no evidence", and it was worst exactly
 * where the question is loudest: a plan that has never run showed nothing at
 * all. These pin that the weaker links exist, that they are LABELLED, and that
 * a stronger link is never passed over for a weaker one. */

const ownSample = { weight: M, durationMs: 40 * MIN };
const poolSample = { weight: M, durationMs: 80 * MIN };

test("this plan's own phases win over the pool, however big the pool", () => {
  const rate = rateFor([ownSample], Array.from({ length: 50 }, () => poolSample));
  assert.equal(rate.basis, 'plan');
  assert.equal(rate.ratePerWeight, (40 * MIN) / M);
});

test('with nothing of its own a plan borrows the pool, and says so', () => {
  const rate = rateFor([], [poolSample, poolSample]);
  assert.equal(rate.basis, 'portfolio');
  assert.equal(rate.ratePerWeight, (80 * MIN) / M);
  assert.equal(rate.samples, 2);
});

test('with nothing anywhere the heuristic answers, labelled as the guess it is', () => {
  const rate = rateFor([], []);
  assert.equal(rate.basis, 'heuristic');
  assert.equal(rate.samples, 0);
  assert.equal(rate.ratePerWeight, HEURISTIC_RATE_PER_WEIGHT);
});

test('the heuristic constant lands the three size tags where sizing.md says', () => {
  // The whole reason for that number: S ≈ 15 min, M ≈ 40 min, L ≈ 90 min.
  const rate = rateFor([], []);
  assert.equal(S * rate.ratePerWeight, 15 * MIN);
  assert.equal(M * rate.ratePerWeight, 40 * MIN);
  assert.equal(L * rate.ratePerWeight, 90 * MIN);
});

test('the band never tightens as the evidence weakens', () => {
  const strong = rateFor(Array.from({ length: 5 }, () => ownSample), []);
  const borrowed = rateFor([], Array.from({ length: 5 }, () => poolSample));
  const guessed = rateFor([], []);

  assert.ok(borrowed.spread > strong.spread, 'another plan is weaker evidence than this one');
  assert.ok(guessed.spread >= 0.5, 'a guess is never presented as tight');
  // Five samples of the pool is still the pool: the count says how well the
  // POOL is measured, not how well it applies here.
  assert.ok(borrowed.spread >= 0.5);
});

test('a borrowed rate still refuses to estimate a plan with nothing left', () => {
  assert.equal(etaFrom(rateFor([], [poolSample]), { weight: 0, phases: 0 }), null);
});

test('the estimate carries its basis all the way to the render site', () => {
  const eta = etaFrom(rateFor([], [poolSample]), { weight: M * 2, phases: 2 })!;
  assert.equal(eta.basis, 'portfolio');
  const guess = etaFrom(rateFor([], []), { weight: M * 2, phases: 2 })!;
  assert.equal(guess.basis, 'heuristic');
  assert.match(guess.label, /^~.+ left$/);
});

test('estimateEta stays plan-evidence-only, so the old contract is unchanged', () => {
  // The chain is opt-in. A caller that wants "what this plan has actually shown
  // us and nothing weaker" still gets null rather than a borrowed number.
  assert.equal(estimateEta([], { weight: M * 3, phases: 3 }), null);
  assert.ok(estimateEta([ownSample], { weight: M * 3, phases: 3 }));
});

/* ---------------- one phase at a time ---------------- */

test('a phase estimate is the same rate applied to that phase alone', () => {
  const rate = rateFor([ownSample], []);
  const one = phaseEtaFor(4, M, rate);
  assert.equal(one.phase, 4);
  assert.equal(one.weight, M);
  assert.equal(one.estMs, 40 * MIN);
  assert.equal(one.basis, 'plan');
  // A point, not a range, and never "left" — a phase that has not started has none.
  assert.equal(one.label, '~40 min');
  assert.doesNotMatch(one.label, /left|–/);
});

test('a phase estimate is bucketed like every other figure here', () => {
  // 37 minutes is not a thing anyone says; the bucket is five-minute steps.
  const rate = { ratePerWeight: (37 * MIN) / M, basis: 'plan' as const, samples: 3, spread: 0.35 };
  assert.equal(phaseEtaFor(1, M, rate).estMs % (5 * MIN), 0);
});

test('a plan and its phases cannot disagree about how fast it goes', () => {
  // The one property that makes it safe to show both on one page: the header
  // total and the rows are the same reading, so they add up.
  const rate = rateFor([ownSample, ownSample], []);
  const plan = etaFrom(rate, { weight: M * 3, phases: 3 })!;
  const rows = [1, 2, 3].map((phase) => phaseEtaFor(phase, M, rate));
  const summed = rows.reduce((total, row) => total + row.estMs, 0);
  assert.ok(plan.lowMs <= summed && summed <= plan.highMs, `${summed} outside ${plan.label}`);
  assert.equal(plan.basis, rows[0].basis);
});
