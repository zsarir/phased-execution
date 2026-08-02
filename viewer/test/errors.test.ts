/**
 * Stop-signal classification and reset-time parsing.
 *
 * These are the decisions an unattended run gets wrong expensively: sleeping
 * six hours through a model-only limit, hammering an expired login, or coming
 * back a second before a window reopens. Every message string here is a real
 * one from Claude Code's error documentation, not an invention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classify, parseResetTime, childEnv, nextModel, type StopSignal,
} from '../server/runner/errors.ts';

const at = (iso: string) => new Date(iso);

function stop(partial: Partial<StopSignal>): StopSignal {
  return { subtype: 'error_during_execution', code: 1, ...partial };
}

/* ---------------- reset-time parsing ---------------- */

test('parses the plain local clock form', () => {
  const now = at('2026-08-02T10:00:00');
  const reset = parseResetTime("You've hit your session limit · resets 3:45pm", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 15);
  assert.equal(reset.getMinutes(), 45);
  assert.equal(reset.getDate(), now.getDate(), 'still today when the time is ahead');
});

test('a time already past today rolls to tomorrow', () => {
  const now = at('2026-08-02T20:00:00');
  const reset = parseResetTime('resets 3:45pm', now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 15);
  assert.equal(reset.getDate(), now.getDate() + 1);
});

test('parses the weekday form used by the weekly window', () => {
  const now = at('2026-08-02T10:00:00'); // a Sunday
  const reset = parseResetTime("You've hit your weekly limit · resets Mon 12:00am", now);
  assert.ok(reset);
  assert.equal(reset.getDay(), 1, 'lands on Monday');
  assert.equal(reset.getHours(), 0, '12:00am is midnight, not noon');
});

test('parses the epoch form exactly', () => {
  const reset = parseResetTime('Claude AI usage limit reached|1749924000', at('2026-08-02T10:00:00'));
  assert.ok(reset);
  assert.equal(reset.getTime(), 1749924000 * 1000);
});

test('parses an explicit IANA timezone rather than assuming local', () => {
  const now = at('2026-08-02T10:00:00Z');
  const reset = parseResetTime('Your limit will reset at 3pm (America/Santiago)', now);
  assert.ok(reset, 'a zoned message must resolve');
  // Whatever the host zone, the instant must read 15:00 in Santiago.
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
  }).format(reset);
  assert.equal(Number(shown) % 24, 15);
});

test('unparseable text yields null rather than a guess', () => {
  assert.equal(parseResetTime('something went wrong'), null);
  assert.equal(parseResetTime(''), null);
});

/* ---------------- classification ---------------- */

test('success is success', () => {
  assert.equal(classify(stop({ subtype: 'success' })).kind, 'ok');
});

test('a model-only limit switches model instead of sleeping', () => {
  // The expensive confusion: this message contains "limit" and would read as a
  // plan limit, idling the run for hours when Sonnet is available right now.
  const d = classify(stop({ text: "You've hit your Opus limit · resets 3:45pm", model: 'opus' }));
  assert.equal(d.kind, 'switch-model');
});

test('a plan limit waits for the stated reset, with a margin', () => {
  const now = at('2026-08-02T10:00:00');
  const d = classify(stop({ text: "You've hit your session limit · resets 3:45pm" }), now);
  assert.equal(d.kind, 'wait-until');
  if (d.kind !== 'wait-until') return;
  assert.ok(d.at.getTime() > at('2026-08-02T15:45:00').getTime(), 'never returns exactly on the boundary');
  assert.ok(d.at.getTime() < at('2026-08-02T15:50:00').getTime(), 'but not much after');
});

test('a plan limit with no parseable time waits a conservative hour', () => {
  const now = at('2026-08-02T10:00:00');
  const d = classify(stop({ text: 'Claude usage limit reached.' }), now);
  assert.equal(d.kind, 'wait-until');
  if (d.kind !== 'wait-until') return;
  assert.equal(Math.round((d.at.getTime() - now.getTime()) / 60000), 60);
});

test('a reset further out than 12h parks for a human instead of sleeping', () => {
  const now = at('2026-08-02T10:00:00');
  const far = Math.floor(at('2026-08-06T10:00:00').getTime() / 1000);
  const d = classify(stop({ text: `Claude AI usage limit reached|${far}` }), now);
  assert.equal(d.kind, 'needs-human');
});

test('529 overload switches model — capacity is tracked per model', () => {
  const d = classify(stop({
    text: 'API Error: Repeated 529 Overloaded errors. The API is at capacity',
    model: 'opus',
  }));
  assert.equal(d.kind, 'switch-model');
});

test('429 retries later rather than switching or halting', () => {
  const d = classify(stop({ text: 'API Error: Request rejected (429) · this may be a temporary capacity issue.' }));
  assert.equal(d.kind, 'retry');
});

test('auth, org policy and billing all stop for a human', () => {
  for (const text of [
    'Please run /login · API Error: 401 Invalid authentication credentials',
    'Login expired · Please run /login',
    'Your organization has disabled Claude subscription access for Claude Code',
    'Credit balance is too low',
  ]) {
    assert.equal(classify(stop({ text })).kind, 'needs-human', text);
  }
});

test('an api_retry category is honoured even with no message text', () => {
  assert.equal(classify(stop({ retryCategories: ['authentication_failed'] })).kind, 'needs-human');
  assert.equal(classify(stop({ retryCategories: ['overloaded'] })).kind, 'switch-model');
  assert.equal(classify(stop({ retryCategories: ['billing_error'] })).kind, 'needs-human');
});

test('budget and turn caps resume the same session rather than restarting it', () => {
  const budget = classify(stop({ subtype: 'error_max_budget_usd', text: '' }));
  assert.equal(budget.kind, 'resume');
  if (budget.kind === 'resume') assert.equal(budget.raise, 'budget');

  const turns = classify(stop({ subtype: 'error_max_turns', text: '' }));
  assert.equal(turns.kind, 'resume');
  if (turns.kind === 'resume') assert.equal(turns.raise, 'turns');
});

test('a refusal is not retried', () => {
  const d = classify(stop({ subtype: 'error_during_execution', stopReason: 'refusal', text: '' }));
  assert.equal(d.kind, 'needs-human');
});

test('signals distinguish a supervisor kill from an OOM kill', () => {
  assert.equal(classify(stop({ code: 143, text: '' })).kind, 'needs-human');
  assert.equal(classify(stop({ code: 137, text: '' })).kind, 'retry');
});

test('an unrecognised failure is a phase failure, not a silent success', () => {
  const d = classify(stop({ subtype: undefined, code: 2, text: 'something unexpected' }));
  assert.equal(d.kind, 'phase-failed');
});

/* ---------------- child environment + model fallback ---------------- */

test('the child gets the documented unattended retry settings', () => {
  const env = childEnv({ PATH: '/usr/bin' });
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, '1');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '15');
  assert.equal(env.PATH, '/usr/bin', 'the caller environment survives');
});

test('an explicit retry count from the operator is not overridden', () => {
  assert.equal(childEnv({ CLAUDE_CODE_MAX_RETRIES: '3' }).CLAUDE_CODE_MAX_RETRIES, '3');
});

test('model fallback walks down the ladder and then gives up', () => {
  assert.equal(nextModel('claude-opus-5'), 'sonnet');
  assert.equal(nextModel('sonnet'), 'haiku');
  assert.equal(nextModel('haiku'), null, 'nothing below the last rung');
});
