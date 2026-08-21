/**
 * The door: what a browser may send, and what it is told when it sends
 * something else.
 *
 * Every value tested here ends up in a child process's argv or in a run's
 * stored settings, and for a long time the answer to a bad one was to quietly
 * drop it. That is the worst of the three possible answers — the run starts,
 * looks healthy, and is not the run that was asked for. A phase asking for
 * `claude-opus-5` (the spelling the CLI's own `--help` gives as its example)
 * was discarded without a word and ran on the run's default; an effort typo
 * ran a whole plan at the wrong level.
 *
 * So the rule these tests hold: a value the console cannot honour is a 400
 * that names the field, and a value the CLI accepts is accepted here.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

type Captured = { status: number; body: unknown };

async function call(
  service: unknown, method: string, path: string, { body = {}, header = true } = {},
): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null };
  const res = {
    writeHead(status: number) { out.status = status; return this; },
    end(text: string) { try { out.body = JSON.parse(text); } catch { out.body = text; } },
    on() { return this; },
  };
  const req = {
    method,
    headers: header ? { 'x-phase-console': '1' } : {},
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {
      if (method !== 'GET') yield Buffer.from(JSON.stringify(body));
    },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** Just enough Service for the run door — no source directory needed. */
function fakeService(over: Record<string, unknown> = {}) {
  const started: { slug: string; options: Record<string, unknown> }[] = [];
  const configured: Record<string, unknown>[] = [];
  return {
    flags: { allowWrites: true, allowRun: true, maxSessions: 4 },
    store: { get: () => ({}), list: () => [] },
    startRun: async (slug: string, options: Record<string, unknown>) => {
      started.push({ slug, options });
      return { id: 'r1' };
    },
    configureRun: (_slug: string, patch: Record<string, unknown>) => {
      configured.push(patch);
      return { id: 'r1' };
    },
    verificationPreflight: async () => [],
    _started: started,
    _configured: configured,
    ...over,
  };
}

const err = (out: Captured) => String((out.body as { error?: string })?.error ?? '');

/* ------------------------------------------------------------------ *
 * Models — every spelling the CLI takes, and nothing else
 * ------------------------------------------------------------------ */

test('a run may be started on an alias, a full id, or either at the 1M window', async () => {
  for (const model of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]', 'opusplan']) {
    const service = fakeService();
    const out = await call(service, 'POST', '/api/run/demo/start', { body: { model } });
    assert.equal(out.status, 200, `${model} must be accepted`);
    assert.equal(service._started[0].options.model, model, 'and stored byte-for-byte');
  }
});

test('a model that is not a Claude model is a 400 naming the field', async () => {
  for (const model of ['gpt-4', 'bogus-model-xyz', 'llama']) {
    const service = fakeService();
    const out = await call(service, 'POST', '/api/run/demo/start', { body: { model } });
    assert.equal(out.status, 400, model);
    assert.match(err(out), /must name a Claude model/);
    assert.equal(service._started.length, 0, 'and no run was created');
  }
});

test('the same vocabulary governs a settings patch', async () => {
  const okPatch = fakeService();
  assert.equal((await call(okPatch, 'POST', '/api/run/demo/settings', { body: { model: 'sonnet[1m]' } })).status, 200);
  assert.equal(okPatch._configured[0].model, 'sonnet[1m]');

  const bad = fakeService();
  const out = await call(bad, 'POST', '/api/run/demo/settings', { body: { model: 'gpt-4' } });
  assert.equal(out.status, 400);
  assert.equal(bad._configured.length, 0, 'nothing was changed');
});

test('a per-phase model or effort is checked, and the message names the phase', async () => {
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', {
    body: { phaseOptions: { 7: { model: 'gpt-4' } } },
  });
  assert.equal(out.status, 400);
  assert.match(err(out), /phase 7 model/);

  const effort = fakeService();
  const bad = await call(effort, 'POST', '/api/run/demo/start', {
    body: { phaseOptions: { 3: { effort: 'ludicrous' } } },
  });
  assert.equal(bad.status, 400);
  assert.match(err(bad), /phase 3 effort/);
});

/* ------------------------------------------------------------------ *
 * Effort — the CLI only warns, so this is the layer that refuses
 * ------------------------------------------------------------------ */

test('every effort the CLI accepts passes, and nothing else does', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const service = fakeService();
    assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { effort } })).status, 200, effort);
    assert.equal(service._started[0].options.effort, effort);
  }
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', { body: { effort: 'ludicrous' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /effort must be one of: low, medium, high, xhigh, max/);
});

test("an empty effort means this machine's default, not a bad value", async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/settings', { body: { effort: '' } })).status, 200);
  assert.equal(service._configured[0].effort, '', 'the deliberate "no --effort at all" signal survives');
});

/* ------------------------------------------------------------------ *
 * The numbers
 * ------------------------------------------------------------------ */

test('maxParallel is a whole number, clamped to this console\'s own ceiling', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { maxParallel: 3 } })).status, 200);
  assert.equal(service._started[0].options.maxParallel, 3);

  const clamped = fakeService();
  await call(clamped, 'POST', '/api/run/demo/start', { body: { maxParallel: 4 } });
  assert.equal(clamped._started[0].options.maxParallel, 4, 'the ceiling itself is allowed');

  for (const bad of [0, -1, 2.5, 'lots', 99]) {
    const s = fakeService();
    const out = await call(s, 'POST', '/api/run/demo/start', { body: { maxParallel: bad } });
    assert.equal(out.status, 400, String(bad));
    assert.match(err(out), /maxParallel must be a whole number between 1 and 4/);
  }
});

test('maxConsecutiveFailures is 1..50, and garbage never reaches the runner as NaN', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { maxConsecutiveFailures: 5 } })).status, 200);
  assert.equal(service._started[0].options.maxConsecutiveFailures, 5);

  for (const bad of [0, 51, 'many', 1.5]) {
    const s = fakeService();
    const out = await call(s, 'POST', '/api/run/demo/settings', { body: { maxConsecutiveFailures: bad } });
    assert.equal(out.status, 400, String(bad));
    assert.match(err(out), /maxConsecutiveFailures must be a whole number between 1 and 50/);
  }

  // The bug this replaced: `Number(undefined)` is NaN, and a run compared its
  // failure count against NaN forever.
  const empty = fakeService();
  await call(empty, 'POST', '/api/run/demo/settings', { body: { maxConsecutiveFailures: '' } });
  assert.ok(!('maxConsecutiveFailures' in empty._configured[0]), 'an empty value changes nothing');
});

test('autoRecover and onlyPhases reach a settings patch', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/settings', {
    body: { autoRecover: false, onlyPhases: [3, 3, 0, -1, '4', 'x'] },
  })).status, 200);
  const patch = service._configured[0];
  assert.equal(patch.autoRecover, false);
  assert.deepEqual(patch.onlyPhases, [3, 4], 'only whole positive phases survive');
});

/* ------------------------------------------------------------------ *
 * The read endpoints Phase 4 adds
 * ------------------------------------------------------------------ */

test('spend answers with no source directory open, and takes no flag', async () => {
  const service = fakeService({ store: null, spend: () => ({ today: { settledUsd: 0 }, runs: [], series: [] }) });
  const out = await call(service, 'GET', '/api/spend', { header: false });
  assert.equal(out.status, 200, 'a read needs neither the console header nor a capability');
  assert.deepEqual((out.body as { series: unknown[] }).series, []);
});

test('the attention inbox answers with no source directory open', async () => {
  // Above the wall on purpose: a sign-in, an unreachable MCP server and a dead
  // watcher all need a person whether or not a plan directory is open.
  const service = fakeService({ store: null, attention: async () => ({ items: [], counts: {} }) });
  const out = await call(service, 'GET', '/api/inbox');
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as { items: unknown[] }).items, []);
});

test('?all=1 is passed through to the builder', async () => {
  const seen: boolean[] = [];
  const service = fakeService({ store: null, attention: async (all: boolean) => { seen.push(all); return { items: [] }; } });
  await call(service, 'GET', '/api/inbox');
  await call(service, 'GET', '/api/inbox?all=1');
  assert.deepEqual(seen, [false, true]);
});

test('acking takes the cross-site check but NOT --allow-writes', async () => {
  const acked: string[] = [];
  const base = { store: null, ackInbox: (id: string) => { acked.push(id); return true; }, unackInbox: () => true };

  const noHeader = fakeService({ ...base, flags: { allowWrites: false, allowRun: false, maxSessions: 4 } });
  assert.equal((await call(noHeader, 'POST', '/api/inbox/ack', { body: { id: 'x' }, header: false })).status, 403);

  // A read-only console is exactly where someone would want to tidy a list
  // they cannot otherwise act on, so `--allow-writes` is deliberately not it.
  const readOnly = fakeService({ ...base, flags: { allowWrites: false, allowRun: false, maxSessions: 4 } });
  assert.equal((await call(readOnly, 'POST', '/api/inbox/ack', { body: { id: 'errand:demo:4' } })).status, 200);
  assert.deepEqual(acked, ['errand:demo:4']);
});

test('an ack with no id is a 400, and a DELETE with no id never clears everything', async () => {
  const service = fakeService({ store: null, ackInbox: () => true, unackInbox: () => true });
  const post = await call(service, 'POST', '/api/inbox/ack', { body: {} });
  assert.equal(post.status, 400);
  assert.match(err(post), /id/);

  // The most destructive reading must never be the default.
  const del = await call(service, 'DELETE', '/api/inbox/ack');
  assert.equal(del.status, 400);
  assert.match(err(del), /id/);

  const one = await call(service, 'DELETE', '/api/inbox/ack?id=errand%3Ademo%3A4');
  assert.equal(one.status, 200);
});

test('starting a run still needs --allow-run', async () => {
  const service = fakeService({ flags: { allowWrites: true, allowRun: false, maxSessions: 4 } });
  const out = await call(service, 'POST', '/api/run/demo/start', { body: { model: 'opus' } });
  assert.equal(out.status, 403);
  assert.match(err(out), /--allow-run/);
});
