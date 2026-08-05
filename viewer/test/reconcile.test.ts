/**
 * The run that says it is running, and is not.
 *
 * Every case here came off a real state file. `run-accf6aa2.json` was found on
 * disk reading `status: "running"`, `halt: null`, `child: {pid: 29069, …}` —
 * with pid 29069 long dead and the run's own journal ending, three lines
 * earlier, in `run.halt`. The console had been SIGKILLed between journalling the
 * halt and checkpointing it, so the last word on disk was a claim nobody was
 * backing. The UI believed it for an hour, offered a Stop button whose handler
 * returned immediately, and said nothing about either.
 *
 * The lesson is not "persist harder" — the writer is exactly the thing that can
 * die. It is that liveness has to be derived at read time from evidence that
 * cannot be stale: whether this is the run the loop is driving, and whether the
 * recorded pid still exists.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reconcileRun, newRun, phaseRecord, saveRun, loadRun, listRuns, latestRun, runDir,
  IN_FLIGHT, type RunState,
} from '../server/runner/state.ts';

function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reconcile-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A pid that is certainly not running. 0 and 1 are both real, so pick high. */
const DEAD_PID = 0x7ffffffe;

function crashedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  Object.assign(state, {
    status: 'running',
    activePhase: 12,
    child: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
    ...over,
  });
  const record = phaseRecord(state, 12);
  record.status = 'running';
  return state;
}

test('a run whose writer died stops claiming to be running', () => {
  const state = crashedRun('/tmp/whatever');

  assert.equal(reconcileRun(state, null), true, 'the stale claim should be reclaimed');
  assert.equal(state.status, 'interrupted');
  assert.equal(state.child, null, 'a dead child must not be left on the record');
  assert.match(state.halt?.reason ?? '', /nothing has been driving this run/);
  assert.equal(state.halt?.phase, 12, 'the halt should name the phase that was in flight');
  assert.equal(state.phases['12'].status, 'interrupted',
    'a phase cut off mid-flight is interrupted, never failed — it may have half-committed');
});

test('the run the loop is actually driving is left alone', () => {
  const state = crashedRun('/tmp/whatever');
  assert.equal(reconcileRun(state, state.id), false, 'the live run is the one thing that licenses "running"');
  assert.equal(state.status, 'running');
  assert.equal(state.phases['12'].status, 'running');
});

test('a child that outlived its console parks rather than being reclaimed', () => {
  // Two agents editing one working tree is not a state to quietly recover from.
  const state = crashedRun('/tmp/whatever', {
    child: { pid: process.pid, phase: 7, sessionId: 'x', startedAt: new Date().toISOString() },
  });

  assert.equal(reconcileRun(state, null), true);
  assert.equal(state.status, 'parked');
  assert.ok(state.child, 'the surviving child must stay on the record so it can be found');
  assert.match(state.halt?.reason ?? '', new RegExp(`pid ${process.pid}`));
});

test('an already-settled run is never rewritten', () => {
  for (const status of ['halted', 'finished', 'paused', 'parked', 'interrupted'] as const) {
    const state = crashedRun('/tmp/whatever', { status, child: null });
    assert.equal(reconcileRun(state, null), false, `${status} is terminal and must be left as it is`);
    assert.equal(state.status, status);
  }
});

test('every in-flight status is reclaimable, and the list is the one the code uses', () => {
  // A status added later that nobody adds here would silently become immortal.
  for (const status of IN_FLIGHT) {
    const state = crashedRun('/tmp/whatever', { status });
    assert.equal(reconcileRun(state, null), true, `${status} claims work in flight and must be reclaimed`);
    // A dead `halting` run DID record why it stopped — it finalizes to the
    // `halted` its drive loop never got to write. `interrupted` stays the word
    // for "nothing recorded why".
    assert.equal(state.status, status === 'halting' ? 'halted' : 'interrupted');
  }
});

test('a dead halting run keeps its own halt reason on the way to halted', () => {
  const state = crashedRun('/tmp/whatever', {
    status: 'halting',
    halt: { at: '2026-08-04T12:00:00.000Z', reason: 'phase 2 did not verify: stub', phase: 2 },
  });
  assert.equal(reconcileRun(state, null), true);
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.reason, 'phase 2 did not verify: stub', 'the reason is the run\'s own, not a reconstruction');
});

test('an existing halt reason is preserved, not overwritten', () => {
  // The journal's `run.halt` may have landed even when the checkpoint did not;
  // whatever the runner managed to record is better than our reconstruction.
  const state = crashedRun('/tmp/whatever', {
    halt: { at: '2026-08-02T12:35:08.078Z', reason: '2 phases failed in a row', phase: 12 },
  });
  reconcileRun(state, null);
  assert.equal(state.halt?.reason, '2 phases failed in a row');
  assert.equal(state.status, 'interrupted', 'the status is still corrected');
});

test('a phase waiting on a human is reclaimed too', () => {
  const state = crashedRun('/tmp/whatever');
  state.phases['12'].status = 'awaiting-verification';
  reconcileRun(state, null);
  assert.equal(state.phases['12'].status, 'interrupted');
  assert.match(state.phases['12'].note ?? '', /waiting to be verified/);
});

/* ------------------------------------------------------------------ *
 * Reading it back off disk
 * ------------------------------------------------------------------ */

test('loading a crashed run corrects it, and the correction is written down', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root);
    saveRun(state);

    const loaded = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(loaded?.status, 'interrupted', 'the reader must not report a corpse as running');

    // Written back, or every read re-derives it and `/api/runs` never settles.
    const onDisk = JSON.parse(readFileSync(join(runDir(dir.root, 'demo'), `run-${state.id}.json`), 'utf8')) as RunState;
    assert.equal(onDisk.status, 'interrupted');
    assert.equal(onDisk.child, null);
  } finally { dir.cleanup(); }
});

test('listRuns and latestRun reconcile too — the UI reads through both', () => {
  const dir = scratchRoot();
  try {
    saveRun(crashedRun(dir.root));
    assert.equal(listRuns(dir.root, 'demo', null)[0].status, 'interrupted');
    assert.equal(latestRun(dir.root, 'demo', null)?.status, 'interrupted');
  } finally { dir.cleanup(); }
});

test('a live run read through listRuns keeps its status', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root);
    saveRun(state);
    assert.equal(listRuns(dir.root, 'demo', state.id)[0].status, 'running');
  } finally { dir.cleanup(); }
});

test('an unreadable run directory is empty, not an exception', () => {
  const dir = scratchRoot();
  try {
    mkdirSync(runDir(dir.root, 'demo'), { recursive: true });
    writeFileSync(join(runDir(dir.root, 'demo'), 'run-deadbeef.json'), '{ truncated', 'utf8');
    assert.deepEqual(listRuns(dir.root, 'demo', null), []);
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Several lanes, one crashed console
 * ------------------------------------------------------------------ */

test('every lane is reconciled, not just the one the mirror named', () => {
  const dir = scratchRoot();
  try {
    // Three lanes recorded, plus the mirror pointing at one of them — exactly
    // what the runner writes while a run drives three phases at once.
    const state = crashedRun(dir.root, {
      children: {
        7: { pid: DEAD_PID, phase: 7, sessionId: 's7', startedAt: new Date().toISOString() },
        9: { pid: DEAD_PID, phase: 9, sessionId: 's9', startedAt: new Date().toISOString() },
        12: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
      },
    });
    for (const phase of [7, 9]) phaseRecord(state, phase).status = 'running';

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'interrupted');
    // All three, not one. A lane left `running` on a run nothing is driving is
    // a phase the console goes on reporting as in flight forever.
    for (const phase of [7, 9, 12]) {
      const record = state.phases[String(phase)];
      assert.equal(record.status, 'interrupted', `phase ${phase}`);
      assert.equal(record.resumeSessionId, record.sessionId, `phase ${phase} keeps a session to resume`);
    }
    assert.equal(state.child, null);
    assert.equal(state.children, undefined, 'nothing is left claiming to be alive');
  } finally { dir.cleanup(); }
});

test('a run whose OTHER lane is still alive parks rather than being reclaimed', () => {
  const dir = scratchRoot();
  try {
    // The mirror's child is gone; a second lane's is this very process, which
    // is certainly alive. Reading only `child` would reclaim a run that still
    // has a session editing the working tree — the exact failure `parked` is for.
    const state = crashedRun(dir.root, {
      children: {
        7: { pid: process.pid, phase: 7, sessionId: 's7', startedAt: new Date().toISOString() },
        12: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
      },
    });

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'parked');
    assert.match(state.halt!.reason, /still running/);
    assert.match(state.halt!.reason, new RegExp(String(process.pid)), 'and names the pid to look at');
  } finally { dir.cleanup(); }
});

test('a run written before lanes reconciles exactly as it always did', () => {
  const dir = scratchRoot();
  try {
    // No `children` key at all — which is every run file on disk today. The two
    // recordings have to reconcile identically, or the upgrade is a regression.
    const state = crashedRun(dir.root);
    assert.equal(state.children, undefined);
    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'interrupted');
    assert.equal(state.phases['12'].status, 'interrupted');
    assert.equal(state.child, null);
  } finally { dir.cleanup(); }
});

test('a live-run SET keeps every one of its runs, and reclaims the rest', () => {
  const dir = scratchRoot();
  try {
    const a = crashedRun(dir.root);
    const b = crashedRun(dir.root);
    const c = crashedRun(dir.root);
    // A single id was the whole answer with one runner. With a pool it is a
    // Set — and a Set compared with `===` would mark every live run as dead
    // and reconcile a working fleet into `interrupted`.
    const live = new Set([a.id, b.id]);
    assert.equal(reconcileRun(a, live), false, 'still driving');
    assert.equal(reconcileRun(b, live), false, 'also still driving');
    assert.equal(reconcileRun(c, live), true, 'and this one genuinely is not');
    assert.equal(c.status, 'interrupted');
  } finally { dir.cleanup(); }
});
