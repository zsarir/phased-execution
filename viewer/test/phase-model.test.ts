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
  await import('../shared/phase-model.js');

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
  assert.deepEqual(phaseActions(ten, opts), {
    runAlone: false, retry: false, skip: false, diagnose: false,
    heldBy: null, staleLock: false,
  });

  // Even when the record looks retryable, no CONTROL is offered — but the
  // record's own story stays readable. "A done phase has nothing left to
  // explain" was the old rule, and a real page disproved it: two red `failed`
  // chips on phases finished outside the run, with nothing to click. What
  // failed HERE is exactly what such a row still owes.
  const failed = { state: 'done', record: { status: 'failed' } };
  assert.deepEqual(phaseActions(failed, opts), {
    runAlone: false, retry: false, skip: false, diagnose: true,
    heldBy: null, staleLock: false,
  });
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

test('a live claim by someone else refuses the two verbs that start work', () => {
  const lock = { owner: 'someone/else', expired: false, leaseUntil: Date.now() + 600_000 };
  const ready = { state: 'ready', record: { status: 'failed' }, lock };
  const actions = phaseActions(ready, opts);

  assert.equal(actions.runAlone, false, 'a claimed phase cannot be started');
  assert.equal(actions.retry, false, 'nor retried into a session');
  assert.deepEqual(actions.heldBy, lock, 'and the row can name who holds it');

  // The two that do not start anything are untouched. Refusing to EXPLAIN a
  // phase because someone holds it would withhold the very thing that tells
  // you whether their session is still alive.
  assert.equal(actions.diagnose, true, 'reading evidence is not starting work');
  assert.equal(
    phaseActions({ ...ready, record: { status: 'running' } }, { live: true, allowRun: true }).skip,
    true,
    'taking a phase off a running loop is not starting work either',
  );
});

test('a LAPSED claim blocks nothing — that is what a lease running out means', () => {
  // The bug this pins: an expired claim used to read as a holder, so a session
  // that died without releasing blocked its phase for the whole lease and then
  // kept blocking it, because nothing renews a dead claim.
  const lock = { owner: 'someone/else', expired: true, leaseUntil: Date.now() - 60_000 };
  const actions = phaseActions({ state: 'ready', record: { status: 'failed' }, lock }, opts);

  assert.equal(actions.runAlone, true);
  assert.equal(actions.retry, true);
  assert.equal(actions.heldBy, null, 'nobody is working a phase whose claim lapsed');
  assert.equal(actions.staleLock, true, 'but the debris is still worth saying out loud');
});

test('your own claim is not somebody else’s', () => {
  // The autopilot claims phases in its own name. Without this a run would
  // refuse to board the very phase it just claimed.
  const lock = { owner: 'autopilot/run-7', expired: false, leaseUntil: Date.now() + 600_000 };
  const ready = { state: 'ready', record: undefined, lock };

  assert.equal(phaseActions(ready, opts).runAlone, false, 'a stranger by default');
  assert.equal(
    phaseActions(ready, { ...opts, owner: 'autopilot/run-7' }).runAlone,
    true,
    'but not when the claim is ours',
  );
});

test('a phase with no claim at all reports none', () => {
  const actions = phaseActions({ state: 'ready', record: undefined }, opts);
  assert.equal(actions.heldBy, null);
  assert.equal(actions.staleLock, false);
  assert.equal(actions.runAlone, true);
});

test('a read-only console offers no controls — but will still say what went wrong', () => {
  const readOnly = { live: false, allowRun: false };
  const ready = { state: 'ready', record: { status: 'failed' } };
  // Every control is off, and `diagnose` is deliberately not one: reading why a
  // phase stopped changes nothing, and withholding it is what sent people to a
  // terminal to grep NDJSON. The buttons inside the panel are gated on
  // `allowRun` in the view, and the server refuses all of them without it.
  const actions = phaseActions(ready, readOnly);
  assert.deepEqual(actions, {
    runAlone: false, retry: false, skip: false, diagnose: true,
    heldBy: null, staleLock: false,
  });
});

test('there is always a way forward from a phase that stopped', () => {
  // The dead end this closes: a run halted with its approval card expired
  // offered Retry (re-runs a session that was probably fine) and Skip (throws
  // the phase away) and nothing else. Every stopped state must open the panel,
  // which is where the three non-destructive verbs live.
  for (const status of ['failed', 'interrupted', 'parked', 'awaiting-verification']) {
    assert.equal(phaseActions({ state: 'ready', record: { status } }, opts).diagnose, true, status);
  }
  // Nothing to diagnose about a phase that never ran, or one still going.
  assert.equal(phaseActions({ state: 'ready', record: undefined }, opts).diagnose, false);
  assert.equal(phaseActions({ state: 'ready', record: { status: 'running' } }, opts).diagnose, false);
  assert.equal(phaseActions({ state: 'ready', record: { status: 'failed' } }, { live: true, allowRun: true }).diagnose,
    false, 'a driving loop owns the phase; the panel is for when nothing does');
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
