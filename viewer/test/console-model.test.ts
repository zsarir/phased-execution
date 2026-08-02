/**
 * How a session's stream reads once it is on screen.
 *
 * The behaviour worth pinning down is the folding. Turning on
 * `--include-partial-messages` means the same sentence arrives twice — once as
 * a stream of token-sized deltas, then again as a finished block — and the
 * naive handling of that is a console that stutters every paragraph and holds
 * fifty rows where it should hold one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toLine, fold, QUIET, KIND_LABEL } = await import('../web/components/console-model.js');

const stream = (data: Record<string, unknown>) => toLine('stream', data);

/** Push a list of events through fold the way the console does. */
function play(events: Record<string, unknown>[]): { kind: string; text: string }[] {
  let lines: { kind: string; text: string }[] = [];
  let id = 0;
  for (const data of events) {
    const line = stream(data);
    if (line?.text) lines = fold(lines, line, ++id, 1000 + id);
  }
  return lines;
}

test('streamed fragments become one growing line, not one line each', () => {
  const lines = play([
    { kind: 'partial', text: 'Wiring ' },
    { kind: 'partial', text: 'the new ' },
    { kind: 'partial', text: 'endpoint' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Wiring the new endpoint');
});

test('the finished block replaces the fragments rather than repeating them', () => {
  const lines = play([
    { kind: 'partial', text: 'Wiring ' },
    { kind: 'partial', text: 'the new endpoint' },
    { kind: 'text', text: 'Wiring the new endpoint' },
  ]);
  assert.equal(lines.length, 1, 'the same sentence must not appear twice');
  assert.equal(lines[0].kind, 'text');
  assert.equal(lines[0].text, 'Wiring the new endpoint');
});

test('a finished block with nothing streamed before it is still shown', () => {
  const lines = play([
    { kind: 'tool', name: 'Read', summary: 'src/a.ts' },
    { kind: 'text', text: 'Done.' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['tool', 'text']);
});

test('a subagent keeps its own line and does not absorb the phase text', () => {
  const lines = play([
    { kind: 'partial', text: 'delegating' },
    { kind: 'subagent', text: 'searched 40 files' },
    { kind: 'partial', text: 'back' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['partial', 'subagent', 'partial']);
  assert.equal(lines[2].text, 'back', 'the phase resumed its own voice');
});

test('thinking is folded separately from the answer', () => {
  const lines = play([
    { kind: 'thinking', text: 'the user wants ' },
    { kind: 'thinking', text: 'an endpoint' },
    { kind: 'partial', text: 'Adding it now' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['thinking', 'partial']);
  assert.equal(lines[0].text, 'the user wants an endpoint');
});

test('the noisy kinds are the ones hidden by default, and only those', () => {
  assert.ok(QUIET.has('thinking'));
  assert.ok(QUIET.has('hook'));
  assert.ok(!QUIET.has('text'), 'the answer is never hidden');
  assert.ok(!QUIET.has('subagent'), 'delegated work is the gap this was built to close');
  assert.ok(!QUIET.has('injected'), "the operator's own question is never hidden");
});

test('an operator question reads as one, and every kind has a label', () => {
  const line = stream({ kind: 'injected', text: 'why did you skip the cache?' })!;
  assert.equal(line.kind, 'injected');
  assert.equal(KIND_LABEL[line.kind], 'btw');
  for (const kind of ['partial', 'thinking', 'subagent', 'hook', 'limits', 'injected']) {
    assert.ok(KIND_LABEL[kind], `${kind} has no label, so it would show its raw name`);
  }
});

test('the usage window is reported as a percentage a person can act on', () => {
  const line = stream({ kind: 'limits', status: 'allowed_warning', window: 'seven_day', utilization: 0.81 })!;
  assert.match(line.text, /81% of the seven day window used/);
  // No figure means nothing to say — better silent than "undefined%".
  assert.equal(stream({ kind: 'limits', status: 'allowed' }), null);
});

test('a phase line says the effort it started at, when there is one', () => {
  assert.match(
    toLine('phase', { status: 'running', phase: 3, model: 'opus', effort: 'xhigh' })!.text,
    /phase 3 started on opus at xhigh effort/,
  );
  assert.match(
    toLine('phase', { status: 'running', phase: 3, model: 'opus' })!.text,
    /phase 3 started on opus$/,
  );
});

test('the window is capped, and caps by dropping the oldest', () => {
  let lines: { text: string }[] = [];
  for (let i = 0; i < 700; i++) lines = fold(lines, { kind: 'tool', text: `t${i}` }, i + 1, i);
  assert.equal(lines.length, 600);
  assert.equal(lines[0].text, 't100', 'the oldest went, not the newest');
});
