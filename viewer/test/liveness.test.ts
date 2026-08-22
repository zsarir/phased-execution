/**
 * The pure half of stall detection: fold the stream, then decide.
 *
 * Everything here is arithmetic on numbers that are passed in — no clock, no
 * filesystem, no runner — which is the whole reason `runner/liveness.ts` was
 * split out. The runner-side behaviour (the 60-second ticker, `git`, the
 * journal, the announcement, the once-per-episode rule) is driven by a fake
 * clock in `runner.test.ts`; this file pins what those are driving.
 */

// Redirects XDG_STATE_HOME before anything under `server/` resolves it. Static
// imports evaluate in source order, so this has to stay first.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent, evaluateStall, livenessOf, newLaneSignals, oldestOpenTool, stallThresholds,
  type LaneSignals,
} from '../server/runner/liveness.ts';
import { STALL_DEFAULTS, STALL_SIGNALS } from '../shared/attention-model.js';
import type { StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

/** Fold a list of `[event, at]` pairs into a fresh accumulator. */
function fold(events: [StreamEvent, number][], start = T0): LaneSignals {
  const signals = newLaneSignals(start);
  for (const [event, at] of events) applyEvent(signals, event, at);
  return signals;
}

const step = (tools: number): StreamEvent => ({ kind: 'step', tools });
const tool = (id: string, name = 'Bash'): StreamEvent => ({ kind: 'tool', id, name, summary: name });
const result = (id: string): StreamEvent => ({ kind: 'tool-result', id, ok: true });

/* ------------------------------------------------------------------ *
 * The thresholds
 * ------------------------------------------------------------------ */

test('the shipped thresholds are the shared ones, and nonsense falls back to them', () => {
  assert.deepEqual(stallThresholds(), { ...STALL_DEFAULTS });
  assert.deepEqual(stallThresholds(null), { ...STALL_DEFAULTS });
  assert.equal(stallThresholds({ stallSilentMs: 90_000 }).stallSilentMs, 90_000);
  // Zero is not "off" here — it would flag every lane on its first tick.
  assert.equal(stallThresholds({ stallSilentMs: 0 }).stallSilentMs, STALL_DEFAULTS.stallSilentMs);
  assert.equal(stallThresholds({ stallSpinTurns: -1 }).stallSpinTurns, STALL_DEFAULTS.stallSpinTurns);
  assert.equal(
    stallThresholds({ stallStalemateAttempts: Number.NaN }).stallStalemateAttempts,
    STALL_DEFAULTS.stallStalemateAttempts,
  );
});

/* ------------------------------------------------------------------ *
 * Folding the stream
 * ------------------------------------------------------------------ */

test('every event is output, so a lane that only ever wrote to stderr is not silent', () => {
  const signals = fold([[{ kind: 'stderr', text: 'npm warn' }, T0 + MINUTE]]);
  assert.equal(signals.lastOutputAt, T0 + MINUTE);
});

test('a turn with tool calls resets the spin counter; a turn without one advances it', () => {
  const signals = fold([
    [step(0), T0 + 1], [step(0), T0 + 2], [step(0), T0 + 3],
  ]);
  assert.equal(signals.turnsSinceLastTool, 3);

  applyEvent(signals, step(2), T0 + 4);
  assert.equal(signals.turnsSinceLastTool, 0, 'a turn that called something is not spinning');
});

test('a tool call opens, a result closes, and the OLDEST unanswered one is the one named', () => {
  const signals = fold([
    [tool('a', 'Bash'), T0 + MINUTE],
    [tool('b', 'Read'), T0 + 2 * MINUTE],
  ]);
  assert.equal(oldestOpenTool(signals)?.name, 'Bash');
  assert.equal(signals.lastToolUseAt, T0 + 2 * MINUTE);

  applyEvent(signals, result('a'), T0 + 3 * MINUTE);
  assert.equal(oldestOpenTool(signals)?.name, 'Read', 'closing the oldest promotes the next');

  applyEvent(signals, result('b'), T0 + 4 * MINUTE);
  assert.equal(oldestOpenTool(signals), undefined);
});

test("a subagent's calls are its own — they never reset the phase's spin counter", () => {
  // The measured shape: a delegating turn calls `Task`, then the phase's own
  // conversation stops while the subagent works. Counting the subagent's tool
  // traffic as the phase's would make the lane look busy at exactly the moment
  // it is worth asking whether the delegation is coming back.
  const signals = fold([[step(0), T0 + 1], [step(0), T0 + 2]]);
  applyEvent(signals, { kind: 'tool', id: 'x', name: 'Grep', summary: 'g', parent: 'call-1' }, T0 + 3);
  assert.equal(signals.turnsSinceLastTool, 2, "a subagent's call is not the phase acting");
  assert.equal(signals.lastToolUseAt, undefined);
  assert.equal(oldestOpenTool(signals), undefined, 'and it opens no call on this lane');
});

test('an operator steering the session buys it a fair hearing', () => {
  const signals = fold([[step(0), T0 + 1], [step(0), T0 + 2], [step(0), T0 + 3]]);
  applyEvent(signals, { kind: 'injected', text: 'try the other route', mark: 'm1' }, T0 + 4);
  assert.equal(signals.turnsSinceLastTool, 0, 'a nudge must not trip the same card on the next turn');
});

test('the open-call list is bounded, so a session that leaks ids costs bounded memory', () => {
  const signals = newLaneSignals(T0);
  for (let i = 0; i < 200; i++) applyEvent(signals, tool(`id-${i}`), T0 + i);
  assert.ok(signals.openTools.length <= 64, `bounded, got ${signals.openTools.length}`);
});

/* ------------------------------------------------------------------ *
 * Deciding
 * ------------------------------------------------------------------ */

test('a lane that has just spoken is not stalled', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 2 * MINUTE), null);
});

test('silence past the threshold is `silent`, and it names the call open longest', () => {
  const signals = fold([[tool('a', 'Bash'), T0 + MINUTE]]);
  const now = T0 + MINUTE + 14 * MINUTE;
  const stall = evaluateStall(signals, stallThresholds(), now);
  assert.equal(stall?.signal, 'silent');
  assert.match(stall!.detail, /no output for 14 min/);
  assert.match(stall!.detail, /oldest open tool call is Bash/);
  // The episode starts when the silence began, NOT when the tick noticed it —
  // otherwise the card's clock restarts every minute and never ages.
  assert.equal(stall!.since, new Date(T0 + MINUTE).toISOString());
});

test('with nothing open, `silent` says so rather than naming a call it does not have', () => {
  const signals = fold([[step(1), T0]]);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 11 * MINUTE);
  assert.match(stall!.detail, /no tool call is open/);
});

test('turns without a tool call past the threshold are `spinning`', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 6; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 7_000);
  assert.equal(stall?.signal, 'spinning');
  assert.match(stall!.detail, /6 turns with no tool call/);
});

test('idle attempts past the threshold are `stalemate`, the strongest of the three', () => {
  const signals = newLaneSignals(T0, { idleAttempts: 3 });
  const stall = evaluateStall(signals, stallThresholds(), T0 + 1_000);
  assert.equal(stall?.signal, 'stalemate');
  assert.match(stall!.detail, /3 attempts in a row/);
});

test('worst-first: a lane that is both silent and spinning reports the newer, harder fact', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 8; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  // Spinning holds already...
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 9_000)?.signal, 'spinning');
  // ...and then it goes quiet, which is a stronger statement about the same lane.
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 20 * MINUTE)?.signal, 'silent');
  // A stalemate outranks both.
  signals.idleAttempts = 3;
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 20 * MINUTE)?.signal, 'stalemate');
  // ...and the order it reports in is the vocabulary's own.
  assert.deepEqual([...STALL_SIGNALS], ['stalemate', 'silent', 'spinning']);
});

test('`verifying` suppresses every signal — a build is silent and fine', () => {
  const signals = newLaneSignals(T0, { idleAttempts: 9 });
  for (let i = 1; i <= 20; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  const now = T0 + 3 * 60 * MINUTE;
  assert.ok(evaluateStall(signals, stallThresholds(), now), 'all three would otherwise hold');
  signals.verifying = true;
  assert.equal(evaluateStall(signals, stallThresholds(), now), null);
});

test('a shorter threshold fires sooner — the knob is the knob', () => {
  const signals = fold([[step(1), T0]]);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 2 * MINUTE), null);
  assert.equal(
    evaluateStall(signals, stallThresholds({ stallSilentMs: MINUTE }), T0 + 2 * MINUTE)?.signal,
    'silent',
  );
});

/* ------------------------------------------------------------------ *
 * The wire view
 * ------------------------------------------------------------------ */

test('the wire view carries every field the run payload promises, and omits what it has not got', () => {
  const signals = fold([[step(0), T0 + MINUTE]]);
  const bare = livenessOf(4, signals);
  assert.deepEqual(bare, {
    phase: 4,
    lastOutputAt: new Date(T0 + MINUTE).toISOString(),
    turnsSinceLastTool: 1,
    commitsSinceStart: 0,
    treeDirty: false,
  });
  assert.ok(!('lastToolUseAt' in bare), 'a lane that has called nothing has no last-call time');
  assert.ok(!('openTool' in bare) && !('stall' in bare));

  applyEvent(signals, tool('a', 'Edit'), T0 + 2 * MINUTE);
  signals.commitsSinceStart = 2;
  signals.treeDirty = true;
  signals.stall = { signal: 'silent', since: 'x', detail: 'y' };
  const full = livenessOf(4, signals);
  assert.equal(full.lastToolUseAt, new Date(T0 + 2 * MINUTE).toISOString());
  assert.equal(full.openTool?.name, 'Edit');
  assert.equal(full.commitsSinceStart, 2);
  assert.equal(full.treeDirty, true);
  assert.equal(full.stall?.signal, 'silent');
});
