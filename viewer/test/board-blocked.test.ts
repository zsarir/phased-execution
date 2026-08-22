/**
 * The `blocked:` line — why the board is empty.
 *
 * An empty `ready` set is four unrelated situations (the plan is finished; every
 * remaining phase is in flight; the plan is closed; nothing can ever move again)
 * collapsed into one silence, and `--memory-block` is the ONLY engine command the
 * runner reads. Without this line the runner could report "6 phases are waiting"
 * and nothing more — which is what a real run did while a recorded QA failure held
 * its whole plan for ever.
 */
// First, and before anything under `server/`: `config.ts` resolves STATE_DIR at
// module load, and it is reached transitively from most of that tree. Without
// this the suite reads the operator's real push subscriptions.
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMemoryBlock } from '../server/engine.ts';

const ok = (stdout: string) => readMemoryBlock({ code: 0, stdout, stderr: '', ms: 1, timedOut: false });

test('a board with no blocked line parses as before', () => {
  const board = ok('done: 1\nready: 2, 3\nwaiting: 4\n');
  assert.deepEqual(board.ready, [2, 3]);
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
});

test('blocked names each waiting phase, its unmet deps, and why', () => {
  const board = ok([
    'done: 1, 3',
    'ready: ',
    'waiting: 2, 4',
    'blocked: 2<-1(qa:fail) 4<-2(not-done),3(qa:pending)',
  ].join('\n'));
  assert.deepEqual(board.blockedBy, { 2: [1], 4: [2, 3] });
  // Only the QA verdicts land in `qa` — "not-done" is a board word, not a verdict.
  assert.deepEqual(board.qa, { 1: 'fail', 3: 'pending' });
});

test('the QA map is keyed by the BLOCKING phase, not the blocked one', () => {
  const board = ok('done: 1\nready: \nwaiting: 2\nblocked: 2<-1(qa:fail)\n');
  assert.equal(board.qa[1], 'fail');
  assert.equal(board.qa[2], undefined);
});

test('a malformed blocked line degrades to empty, never throws', () => {
  const board = ok('done: 1\nready: \nwaiting: 2\nblocked: nonsense<-\n');
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
  assert.deepEqual(board.waiting, [2]); // the rest of the board still parses
});

test('an engine error still yields an empty, non-throwing board', () => {
  const board = readMemoryBlock({ code: 1, stdout: '', stderr: 'ERROR: no such plan', ms: 1, timedOut: false });
  assert.equal(board.phased, false);
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
});
