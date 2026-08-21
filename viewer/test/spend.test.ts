/**
 * What the console spent, and which day it spent it on.
 *
 * Two things are pinned here that a spend figure gets wrong quietly. The first
 * is the day boundary: every other day key in this tree is a UTC day, and a
 * money figure that resets at UTC midnight tells an operator nine hours east
 * that their evening's work happened tomorrow — so `dayKey` formats in a real
 * zone, and the fixtures below are timestamps that fall on DIFFERENT days
 * depending on which of the two you pick. The second is honesty: `ladderUsd`
 * reads $0.00 because nothing in the runner records what a rung cost, and the
 * test says so out loud, because the day it stops reading zero must be the day
 * somebody wrote the number down, not the day somebody invented one.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERIES_DAYS, dayKey, dayKeysEndingAt, overDayCap, rungsToday, spendSummary,
  type SpendRunView,
} from '../server/analysis/spend.ts';
import { nextRung } from '../server/runner/ladder.ts';

/** Tokyo is UTC+9 all year: a clean boundary with no DST to argue about. */
const TZ = 'Asia/Tokyo';

/** 2026-08-22 11:00 in Tokyo — comfortably mid-morning, comfortably still the 21st in UTC. */
const NOW = new Date('2026-08-22T02:00:00Z');

/** Local midnight in Tokyo is 15:00Z the day before; these two minutes straddle it. */
const JUST_BEFORE = '2026-08-21T14:59:00Z';
const JUST_AFTER = '2026-08-21T15:01:00Z';

const rung = (at: string, costUsd?: number) => ({
  situation: 'work-in-progress',
  rung: 'resume-own-session',
  at,
  ...(costUsd === undefined ? {} : { costUsd }),
});

/* ------------------------------------------------------------------ *
 * dayKey
 * ------------------------------------------------------------------ */

test('the day key is the operator\'s day, not UTC\'s — the same instant lands on two different dates', () => {
  assert.equal(dayKey(JUST_BEFORE, TZ), '2026-08-21');
  assert.equal(dayKey(JUST_AFTER, TZ), '2026-08-22');
  // Both are the 21st in UTC. If this module had used `toISOString().slice(0, 10)`
  // like every other day key in the tree, the two would be indistinguishable.
  assert.equal(dayKey(JUST_BEFORE, 'UTC'), '2026-08-21');
  assert.equal(dayKey(JUST_AFTER, 'UTC'), '2026-08-21');
});

test('a zone with DST keeps its 25-hour day whole', () => {
  // 2026-11-01, America/New_York: the clocks go back at 02:00 EDT, so the day
  // starts at 04:00Z and does not end until 05:00Z the next morning.
  assert.equal(dayKey('2026-11-01T03:59:00Z', 'America/New_York'), '2026-10-31');
  assert.equal(dayKey('2026-11-01T04:01:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(dayKey('2026-11-02T04:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(dayKey('2026-11-02T05:01:00Z', 'America/New_York'), '2026-11-02');
});

test('a timestamp nobody can read is the empty key, not an exception', () => {
  // These come out of run files this module did not write.
  assert.equal(dayKey('not a date', TZ), '');
  assert.equal(dayKey(Number.NaN, TZ), '');
  assert.equal(dayKey(new Date('nonsense'), TZ), '');
});

test('the key list is calendar arithmetic, so a DST day is never skipped or repeated', () => {
  const week = dayKeysEndingAt('2026-11-02', 7);
  assert.deepEqual(week, [
    '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
  ]);
  assert.equal(new Set(week).size, 7);
  // Month and year boundaries are just dates.
  assert.deepEqual(dayKeysEndingAt('2027-01-02', 7).slice(0, 3), ['2026-12-27', '2026-12-28', '2026-12-29']);
  assert.deepEqual(dayKeysEndingAt('', 7), [], 'no day, no history');
});

/* ------------------------------------------------------------------ *
 * rungsToday
 * ------------------------------------------------------------------ */

test('rungsToday is today\'s rungs only, across every run, oldest first', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r1', slug: 'alpha',
      recoveries: {
        '3': { rungs: [rung(JUST_BEFORE), rung('2026-08-22T01:00:00Z')] },
        '4': { rungs: [rung(JUST_AFTER)] },
      },
    },
    { id: 'r2', slug: 'beta', recoveries: { '1': { rungs: [rung('2026-08-19T10:00:00Z')] } } },
    { id: 'r3', slug: 'gamma' },
  ];
  const today = rungsToday(runs, NOW, TZ);
  assert.deepEqual(today.map((r) => r.at), [JUST_AFTER, '2026-08-22T01:00:00Z']);
  // The 19th belongs to nobody's today, in any zone.
  assert.ok(!today.some((r) => r.at.startsWith('2026-08-19')));
  // A UTC reading of the same instant picks a DIFFERENT set: JUST_AFTER is
  // still the 21st there, so the day it belongs to is one the operator finished
  // eleven hours ago.
  assert.deepEqual(rungsToday(runs, NOW, 'UTC').map((r) => r.at), ['2026-08-22T01:00:00Z']);
});

test('rungsToday hands the records back untouched, so nextRung does its own exact sum', () => {
  const runs: SpendRunView[] = [
    { id: 'r1', slug: 'alpha', recoveries: { '2': { rungs: [rung(JUST_AFTER, 600)] } } },
  ];
  const dayHistory = rungsToday(runs, NOW, TZ);
  assert.equal(dayHistory[0].costUsd, 600, 'not rounded, not copied, not summarised');
  // The wiring this exists for: the same list, straight into the per-day cap.
  const refused = nextRung({ situation: 'never-started', history: [], dayHistory });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : '', /today's ladder budget is spent/);
  assert.ok(nextRung({ situation: 'never-started', history: [], dayHistory: rungsToday(runs, new Date('2026-08-25T02:00:00Z'), TZ) }).ok,
    'a new day is a new budget');
});

test('a rung with no recorded cost is still returned, and counts as zero dollars', () => {
  const runs: SpendRunView[] = [
    { id: 'r1', slug: 'alpha', recoveries: { '2': { rungs: [rung(JUST_AFTER), rung('2026-08-22T01:00:00Z')] } } },
  ];
  const dayHistory = rungsToday(runs, NOW, TZ);
  assert.equal(dayHistory.length, 2, 'a reader counting attempts wants the whole day');
  assert.ok(nextRung({ situation: 'never-started', history: [], dayHistory }).ok,
    'no cap is ever tripped by a number nobody wrote');
});

/* ------------------------------------------------------------------ *
 * spendSummary — today
 * ------------------------------------------------------------------ */

/** One run whose phases finished either side of local midnight. */
const straddling: SpendRunView[] = [
  {
    id: 'run-1', slug: 'alpha', spentUsd: 30.5, runBudgetUsd: 100, updatedAt: '2026-08-22T01:30:00Z',
    phases: {
      '1': { costUsd: 12.25, endedAt: JUST_BEFORE },
      '2': { costUsd: 18.25, endedAt: JUST_AFTER },
      '3': { costUsd: 40, endedAt: undefined },
    },
  },
];

test('a run that straddles local midnight books each phase on the day it ended', () => {
  const view = spendSummary({ runs: straddling, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 18.25, 'only the phase that ended after local midnight');
  const series = new Map(view.series.map((d) => [d.day, d.settledUsd]));
  assert.equal(series.get('2026-08-21'), 12.25);
  assert.equal(series.get('2026-08-22'), 18.25);
  // In UTC the whole $30.50 would have landed on the 21st and today would read $0.
  const utc = spendSummary({ runs: straddling, capUsd: 600, tz: 'UTC' }, NOW);
  assert.equal(utc.today.settledUsd, 0);
  assert.equal(new Map(utc.series.map((d) => [d.day, d.settledUsd])).get('2026-08-21'), 30.5);
});

test('a phase still in flight has spent money that belongs to no date yet', () => {
  const view = spendSummary({ runs: straddling, tz: TZ }, NOW);
  const total = view.series.reduce((sum, d) => sum + d.settledUsd, 0);
  assert.equal(total, 30.5, 'the $40 phase with no endedAt is in no bucket at all');
  assert.equal(view.runs[0].spentUsd, 30.5);
});

test('ladderUsd is an honest zero: the runner does not record what a rung costs', () => {
  const runs: SpendRunView[] = [
    {
      id: 'run-1', slug: 'alpha', spentUsd: 90, updatedAt: '2026-08-22T01:30:00Z',
      // Exactly what `accountRung` writes and nothing ever settles: no costUsd.
      recoveries: { '2': { rungs: [rung(JUST_AFTER), rung('2026-08-22T01:00:00Z')] } },
      phases: { '2': { costUsd: 90, endedAt: JUST_AFTER } },
    },
  ];
  const view = spendSummary({ runs, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 90, 'the session money is real and is reported');
  assert.equal(view.today.ladderUsd, 0, 'the rung money is not recorded, so it is reported as nothing');
});

/* ------------------------------------------------------------------ *
 * spendSummary — the cap
 * ------------------------------------------------------------------ */

test('the day cap comparison is nextRung\'s: >=, and no cap when none is set', () => {
  const spent = (costUsd: number): SpendRunView[] => [
    { id: 'r', slug: 'alpha', recoveries: { '1': { rungs: [rung(JUST_AFTER, costUsd)] } } },
  ];
  const under = spendSummary({ runs: spent(599.99), capUsd: 600, tz: TZ }, NOW);
  assert.equal(under.today.ladderUsd, 599.99);
  assert.equal(under.today.capUsd, 600);
  assert.equal(overDayCap(under.today), false);

  const exactly = spendSummary({ runs: spent(600), capUsd: 600, tz: TZ }, NOW);
  assert.equal(overDayCap(exactly.today), true, 'reaching the cap is spending it, exactly as nextRung reads it');

  // No cap set at all — the view says null and nothing is ever over it.
  const uncapped = spendSummary({ runs: spent(5_000), tz: TZ }, NOW);
  assert.equal(uncapped.today.capUsd, null);
  assert.equal(overDayCap(uncapped.today), false);

  // Zero is a cap, not an absence: it is what an operator sets to stop the
  // ladder spending anything, and `nextRung` refuses at it immediately.
  const zero = spendSummary({ runs: [], capUsd: 0, tz: TZ }, NOW);
  assert.equal(zero.today.capUsd, 0);
  assert.equal(overDayCap(zero.today), true);
});

/* ------------------------------------------------------------------ *
 * spendSummary — runs and series
 * ------------------------------------------------------------------ */

test('each run stands against its own budget, dearest first; unlimited is null', () => {
  const runs: SpendRunView[] = [
    { id: 'b', slug: 'beta', spentUsd: 5, runBudgetUsd: 50 },
    { id: 'a', slug: 'alpha', spentUsd: 120, runBudgetUsd: null },
    { id: 'c', slug: 'gamma', spentUsd: 0, runBudgetUsd: 20, updatedAt: '2026-08-22T01:00:00Z' },
    { id: 'd', slug: 'delta', spentUsd: 0, runBudgetUsd: 20, updatedAt: '2026-07-01T01:00:00Z' },
  ];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.deepEqual(view.runs, [
    { runId: 'a', slug: 'alpha', spentUsd: 120, budgetUsd: null },
    { runId: 'b', slug: 'beta', spentUsd: 5, budgetUsd: 50 },
    { runId: 'c', slug: 'gamma', spentUsd: 0, budgetUsd: 20 },
  ]);
  // `delta` spent nothing and was last touched in July: not a fact about spending.
});

test('the series is exactly seven buckets, oldest first, with the empty days present as zeros', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r', slug: 'alpha', spentUsd: 7,
      phases: {
        '1': { costUsd: 4, endedAt: '2026-08-16T06:00:00Z' },  // Tokyo 2026-08-16, the oldest bucket
        '2': { costUsd: 3, endedAt: JUST_AFTER },              // Tokyo 2026-08-22, today
        '3': { costUsd: 99, endedAt: '2026-08-10T06:00:00Z' }, // older than the window: not shown
      },
    },
  ];
  const view = spendSummary({ runs, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.series.length, SERIES_DAYS);
  assert.equal(view.series.length, 7);
  assert.deepEqual(view.series.map((d) => d.day), [
    '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22',
  ]);
  assert.deepEqual(view.series.map((d) => d.settledUsd), [4, 0, 0, 0, 0, 0, 3]);
  assert.deepEqual(view.series.map((d) => d.ladderUsd), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(view.series.at(-1)!.day, dayKey(NOW, TZ), 'today is always the last bucket');
  assert.equal(view.series.at(-1)!.settledUsd, view.today.settledUsd);
  // A wider window is still all-days-present.
  assert.equal(spendSummary({ runs, tz: TZ, days: 30 }, NOW).series.length, 30);
});

test('nothing on disk is an empty answer, not a missing one', () => {
  const view = spendSummary({ runs: [], capUsd: 600, tz: TZ }, NOW);
  assert.deepEqual(view.today, { settledUsd: 0, ladderUsd: 0, capUsd: 600 });
  assert.deepEqual(view.runs, []);
  assert.equal(view.series.length, 7);
  assert.ok(view.series.every((d) => d.settledUsd === 0 && d.ladderUsd === 0));
});

test('float dust is not a spend figure', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r', slug: 'alpha', spentUsd: 0.1 + 0.2,
      phases: { '1': { costUsd: 0.1, endedAt: JUST_AFTER }, '2': { costUsd: 0.2, endedAt: JUST_AFTER } },
    },
  ];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 0.3);
  assert.equal(view.runs[0].spentUsd, 0.3);
});

test('a run file missing every optional field is read, not thrown at', () => {
  const runs = [
    { id: 'r', slug: 'alpha' },
    { id: 'x', slug: 'beta', spentUsd: 3, phases: { '1': { endedAt: 'garbage', costUsd: 5 } }, recoveries: {} },
  ] as SpendRunView[];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.deepEqual(view.runs, [{ runId: 'x', slug: 'beta', spentUsd: 3, budgetUsd: null }]);
  assert.equal(view.today.settledUsd, 0, 'an unreadable endedAt lands in no bucket');
});
