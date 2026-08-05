/**
 * The halt that stopped being true.
 *
 * Both fixtures below are real state files, copied from the operator's own
 * console on 2026-08-03 — they are the two cards that had been sitting in
 * "Waiting on you" for a day and a half with nothing to press:
 *
 *  - `run-c5daafe6` (`alpha`): halted at 02:55 because "the
 *    session for phase 6 ended cleanly but the board still reads ready — no
 *    handoff was written". The handoff landed at 06:46 the same morning and the
 *    board has read 7/7 done ever since. The run record was never revisited,
 *    because nothing revisits a halted run.
 *  - `run-8134ac98` (`beta`): interrupted on an auth
 *    failure at phase 14. That plan has since finished all fourteen phases.
 *
 * The rule this file pins is deliberately narrow: **a stopped run resolves only
 * when the board can be shown to have overtaken every phase it was about.** Not
 * "it looks old", not "the plan is finished" — the specific phases it halted on
 * and, on a scoped run, the phases it was asked to do. Anything the board
 * cannot answer keeps its card, because a demand that is silently dropped is
 * worse than one that is merely stale.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  autoResolveRun, decidingPhases, newRun, phaseRecord, resolveRunsAgainst, saveRun, loadRun,
  latestRun, slugsNeedingBoard, type RunState,
} from '../server/runner/state.ts';

function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-resolve-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `run-c5daafe6`: scoped to one phase, halted because it wrote no handoff. */
function haltedOnMissingHandoff(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root, model: 'opus', onlyPhases: [6] });
  Object.assign(state, {
    status: 'halted',
    activePhase: 6,
    consecutiveFailures: 1,
    halt: {
      at: '2026-08-03T02:55:04.476Z',
      reason: 'the session for phase 6 ended cleanly but the board still reads "ready" — no handoff '
        + 'was written, or it is not marked complete',
      phase: 6,
    },
    finishedReason: 'the session for phase 6 ended cleanly but the board still reads "ready"',
    ...over,
  } satisfies Partial<RunState>);
  phaseRecord(state, 6).status = 'failed';
  return state;
}

/** `run-8134ac98`: unscoped, interrupted at phase 14 on an auth failure. */
function interruptedOnAuth(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'beta', root, model: 'sonnet' });
  Object.assign(state, {
    status: 'interrupted',
    activePhase: 14,
    halt: {
      at: '2026-08-02T12:54:14.645Z',
      reason: 'authentication failed — run /login in this workspace, then start the run again',
      phase: 14,
    },
    ...over,
  } satisfies Partial<RunState>);
  phaseRecord(state, 14).status = 'parked';
  return state;
}

/** A board where every listed phase reads `done`. */
function boardDone(...phases: number[]): Record<number, string> {
  return Object.fromEntries(phases.map((p) => [p, 'done']));
}

/* ------------------------------------------------------------------ *
 * The two live shapes
 * ------------------------------------------------------------------ */

test('the halted run whose phase the board has since finished resolves itself', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = haltedOnMissingHandoff(root);
    assert.equal(autoResolveRun(state, boardDone(1, 2, 3, 4, 5, 6, 7)), true);
    assert.equal(state.resolved?.auto, true);
    assert.match(state.resolved!.reason, /superseded/);
    assert.match(state.resolved!.reason, /phase 6 done/);
    // Annotation, never deletion: the run keeps saying what it was.
    assert.equal(state.status, 'halted');
    assert.match(state.halt!.reason, /no handoff was written/);
    assert.equal(state.phases['6'].status, 'failed');
  } finally { cleanup(); }
});

test('the interrupted run resolves on its halting phase, with no scope to check', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = interruptedOnAuth(root);
    assert.deepEqual(decidingPhases(state), [14]);
    assert.equal(autoResolveRun(state, boardDone(...Array.from({ length: 14 }, (_, i) => i + 1))), true);
    assert.equal(state.resolved?.auto, true);
    assert.equal(state.status, 'interrupted');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * What must NOT resolve
 * ------------------------------------------------------------------ */

test('a halted run whose phase is not settled keeps its card', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = haltedOnMissingHandoff(root);
    // The board moved on everywhere except the phase this run halted on, which
    // is the only phase that decides anything.
    assert.equal(autoResolveRun(state, { ...boardDone(1, 2, 3, 4, 5, 7), 6: 'ready' }), false);
    assert.equal(state.resolved, undefined);
  } finally { cleanup(); }
});

test('a scoped run needs its whole scope settled, not just the phase it halted on', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = haltedOnMissingHandoff(root, { onlyPhases: [6, 7] });
    assert.deepEqual(decidingPhases(state), [6, 7]);
    assert.equal(autoResolveRun(state, { ...boardDone(6), 7: 'waiting' }), false);
    assert.equal(autoResolveRun(state, boardDone(6, 7)), true);
    assert.match(state.resolved!.reason, /phases 6, 7 done/);
  } finally { cleanup(); }
});

test('an unreadable board resolves nothing — uncertainty keeps the card', () => {
  const { root, cleanup } = scratchRoot();
  try {
    // What `Service.board()` returns when the engine fails: `states` empty.
    assert.equal(autoResolveRun(haltedOnMissingHandoff(root), {}), false);
  } finally { cleanup(); }
});

test('a run that recorded no phase is a question for a person, not the board', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = interruptedOnAuth(root, { activePhase: null, halt: null });
    assert.deepEqual(decidingPhases(state), []);
    assert.equal(autoResolveRun(state, boardDone(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)), false);
  } finally { cleanup(); }
});

test('only halted and interrupted runs resolve — a live orphan never does', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const board = boardDone(1, 2, 3, 4, 5, 6, 7);
    for (const status of ['running', 'paused', 'waiting', 'frozen', 'finished', 'stopping'] as const) {
      const state = haltedOnMissingHandoff(root, { status });
      assert.equal(autoResolveRun(state, board), false, `${status} must not auto-resolve`);
    }
    // `parked` is the reconciler's word for "a child from a dead console is
    // STILL RUNNING". Resolving that would stop mentioning a live session
    // editing the working tree — the one case where silence is dangerous.
    const parked = haltedOnMissingHandoff(root, { status: 'parked' });
    assert.equal(autoResolveRun(parked, board), false);
  } finally { cleanup(); }
});

test('resolving is done once — a second read changes nothing', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = haltedOnMissingHandoff(root);
    assert.equal(autoResolveRun(state, boardDone(6)), true);
    const first = state.resolved!.at;
    assert.equal(autoResolveRun(state, boardDone(6)), false);
    assert.equal(state.resolved!.at, first);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The batch — what the read path actually calls
 * ------------------------------------------------------------------ */

test('a batch asks for one board per plan, and only for runs a board could settle', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const finished = newRun({ slug: 'alpha', root });
    finished.status = 'finished';
    const already = haltedOnMissingHandoff(root, {
      resolved: { at: '2026-08-03T09:00:00.000Z', auto: true, reason: 'superseded' },
    });
    const reopened = haltedOnMissingHandoff(root, { reopenedAt: '2026-08-03T09:00:00.000Z' });

    const runs = [
      haltedOnMissingHandoff(root),        // wants a board
      haltedOnMissingHandoff(root),        // same plan — still one read
      interruptedOnAuth(root),             // a second plan
      finished, already, reopened,         // none of these can be settled by one
    ];

    assert.deepEqual(slugsNeedingBoard(runs).sort(), ['alpha', 'beta']);
  } finally { cleanup(); }
});

test('a batch resolves what its boards cover and leaves the rest alone', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const settled = haltedOnMissingHandoff(root);
    const stillStuck = interruptedOnAuth(root);
    // Only one plan's board could be read — the other plan's engine call failed.
    const boards = new Map([['alpha', boardDone(1, 2, 3, 4, 5, 6, 7)]]);

    const changed = resolveRunsAgainst([settled, stillStuck], boards);
    assert.deepEqual(changed.map((r) => r.slug), ['alpha']);
    assert.equal(settled.resolved?.auto, true);
    assert.equal(stillStuck.resolved, undefined);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Durability — the annotation has to survive a console restart
 * ------------------------------------------------------------------ */

test('a manual dismissal survives a restart, and the board cannot undo an unresolve', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = haltedOnMissingHandoff(root);
    saveRun(state);

    // A person dismisses it — no board involved, and it does not have to agree.
    const reloaded = loadRun(root, state.slug, state.id)!;
    reloaded.resolved = {
      at: new Date().toISOString(), auto: false, reason: 'dismissed by the operator', by: 'console',
    };
    reloaded.reopenedAt = null;
    saveRun(reloaded);

    const afterRestart = latestRun(root, state.slug)!;
    assert.equal(afterRestart.resolved?.auto, false);
    assert.equal(afterRestart.resolved?.by, 'console');
    // And the auto-resolver leaves a person's decision alone.
    assert.equal(autoResolveRun(afterRestart, boardDone(6)), false);

    // Unresolve puts the card back — and it has to STAY back, even though the
    // board still reads done. Without `reopenedAt` the next read would resolve
    // it again and the button would look broken.
    afterRestart.resolved = null;
    afterRestart.reopenedAt = new Date().toISOString();
    saveRun(afterRestart);

    const reopened = latestRun(root, state.slug)!;
    assert.equal(reopened.resolved, null);
    assert.equal(autoResolveRun(reopened, boardDone(1, 2, 3, 4, 5, 6, 7)), false);
  } finally { cleanup(); }
});
