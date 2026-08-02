/**
 * The Autopilot tab's phase table, and the bug it was rebuilt for.
 *
 * Reported against a real plan: phase 10 had been skipped by the autopilot and
 * then finished by a hand-run session. The tab still showed `skipped` and still
 * offered "Run only this" on a phase that was done — because the table was
 * built from `run.phases`, the runner's own bookkeeping, and presented that as
 * the phase's status. Eleven of the fifteen phases were missing entirely, since
 * the run had never touched them.
 *
 * These pin the rule the whole console rests on: the board is the only source
 * of truth for done/ready/waiting. The run record is history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mergePhases, boardCounts, phaseActions, fellOverToAnotherModel } =
  await import('../web/components/phase-model.js');

/** The real shape of the disagreement, taken from the plan that reported it. */
const PLAN = [
  { phase: 9, title: 'cart-api-endpoint: relay namespace', state: 'done' },
  { phase: 10, title: 'design-system: guide framework', state: 'done' },
  { phase: 12, title: 'storefront: market browse', state: 'ready' },
  { phase: 13, title: 'storefront: sell wizard', state: 'waiting' },
];

const RUN = {
  activePhase: null,
  phases: {
    10: { phase: 10, status: 'skipped', attempts: 9, costUsd: 0, note: 'skipped by the operator' },
    12: { phase: 12, status: 'skipped', attempts: 5, costUsd: 0 },
  },
};

test('every phase of the plan appears, not only the ones this run touched', () => {
  const rows = mergePhases(PLAN, RUN);
  assert.deepEqual(rows.map((r) => r.phase), [9, 10, 12, 13]);
  // A run that touched 2 of 4 must still describe all 4, or the tab cannot
  // answer "where is this plan up to?" — the first thing it is opened for.
  assert.equal(rows.filter((r) => r.record).length, 2);
  assert.equal(rows.find((r) => r.phase === 9).record, undefined);
});

test('a phase finished elsewhere reads as finished, whatever this run recorded', () => {
  const rows = mergePhases(PLAN, RUN);
  const ten = rows.find((r) => r.phase === 10);

  assert.equal(ten.state, 'done', 'the board is what is true');
  assert.equal(ten.record.status, 'skipped', 'the run record is kept, not overwritten');
  assert.equal(ten.elsewhere, true, 'and the disagreement is surfaced rather than hidden');
});

test('a phase this run genuinely skipped and nobody finished is not flagged', () => {
  const rows = mergePhases(PLAN, RUN);
  const twelve = rows.find((r) => r.phase === 12);
  assert.equal(twelve.state, 'ready');
  assert.equal(twelve.elsewhere, false, 'nothing has disagreed — it really is outstanding');
});

test('a run that finished the phase itself is not flagged as elsewhere', () => {
  const rows = mergePhases(
    [{ phase: 1, title: 'x', state: 'done' }],
    { phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 1 } } },
  );
  assert.equal(rows[0].elsewhere, false);
});

test('no run at all still describes the whole plan', () => {
  const rows = mergePhases(PLAN, null);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.record === undefined && r.elsewhere === false));
});

/* ------------------------------------------------------------------ *
 * What may be offered
 * ------------------------------------------------------------------ */

const opts = { live: false, allowRun: true };

test('a finished phase offers nothing at all, whatever the run recorded', () => {
  // The reported bug, stated as a rule. Phase 10 is done on the board and
  // `skipped` in the run record; the old table read the record and offered to
  // run it.
  const [, ten] = mergePhases(PLAN, RUN);
  assert.deepEqual(phaseActions(ten, opts), { runAlone: false, retry: false, skip: false });

  // Even when the record looks retryable.
  const failed = { state: 'done', record: { status: 'failed' } };
  assert.deepEqual(phaseActions(failed, opts), { runAlone: false, retry: false, skip: false });
});

test('only a phase the board calls ready can be run on its own', () => {
  assert.equal(phaseActions({ state: 'ready', record: undefined }, opts).runAlone, true);
  // Waiting means a dependency is unmet; the runner would refuse it anyway, so
  // offering it is a button that can only disappoint.
  assert.equal(phaseActions({ state: 'waiting', record: undefined }, opts).runAlone, false);
  assert.equal(phaseActions({ state: 'stuck', record: undefined }, opts).runAlone, false);
  assert.equal(phaseActions({ state: 'in-progress', record: undefined }, opts).runAlone, false);
});

test('nothing is offered while a loop is driving, except taking a phase off its list', () => {
  const live = { live: true, allowRun: true };
  const ready = { state: 'ready', record: { status: 'pending' } };
  assert.equal(phaseActions(ready, live).runAlone, false, 'one run at a time');
  assert.equal(phaseActions(ready, live).retry, false);
  assert.equal(phaseActions(ready, live).skip, true);

  // With no loop there is no list to take it off.
  assert.equal(phaseActions(ready, opts).skip, false);
});

test('retry is offered only for a record that actually stopped badly', () => {
  for (const status of ['failed', 'interrupted', 'parked']) {
    assert.equal(phaseActions({ state: 'ready', record: { status } }, opts).retry, true, status);
  }
  for (const status of ['done', 'skipped', 'pending', undefined]) {
    assert.equal(phaseActions({ state: 'ready', record: { status } }, opts).retry, false, String(status));
  }
});

test('a read-only console offers no controls whatsoever', () => {
  const readOnly = { live: false, allowRun: false };
  const ready = { state: 'ready', record: { status: 'failed' } };
  assert.deepEqual(phaseActions(ready, readOnly), { runAlone: false, retry: false, skip: false });
});

/* ------------------------------------------------------------------ *
 * Odds and ends
 * ------------------------------------------------------------------ */

test('the board counts are the board, not the run', () => {
  assert.deepEqual(boardCounts(mergePhases(PLAN, RUN)), { done: 2, ready: 1, waiting: 1 });
});

test('an in-place model failover is noticed, and an alias match is not', () => {
  assert.equal(fellOverToAnotherModel({ model: 'opus', actualModel: 'claude-sonnet-5' }), true);
  // Asked for `opus`, ran `claude-opus-5` — the same model, reported in full.
  assert.equal(fellOverToAnotherModel({ model: 'opus', actualModel: 'claude-opus-5' }), false);
  assert.equal(fellOverToAnotherModel({ model: 'opus' }), false, 'nothing to compare against');
  assert.equal(fellOverToAnotherModel(undefined), false);
});
