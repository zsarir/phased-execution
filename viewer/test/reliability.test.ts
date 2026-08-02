/**
 * Reliability: the console has to outlive its own faults.
 *
 * These cover the paths that used to end the process — a watcher error with no
 * listener, a watch that silently stops delivering — plus the exit record that
 * tells you which one happened. They use a real temporary directory and real
 * `fs.watch`, because the bugs being guarded against live in the interaction
 * with the platform, not in our own logic.
 */

// The heartbeat interval is read at module load, so it has to be shortened
// before `watch.ts` is imported. That forces the dynamic import below.
process.env.PHASE_CONSOLE_HEARTBEAT_MS = '250';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DocsWatcher } = await import('../server/watch.ts');
const { configureLog, log, recent } = await import('../server/log.ts');
const { degradedState, clearDegraded, onShutdown, runShutdownHandlers } = await import('../server/lifecycle.ts');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition rather than a fixed sleep — filesystem timing varies. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

function scratch(): { root: string; plans: string; handoffs: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reliability-'));
  const plans = join(root, 'docs', 'plans');
  const handoffs = join(root, 'docs', 'handoffs');
  mkdirSync(plans, { recursive: true });
  mkdirSync(handoffs, { recursive: true });
  return { root, plans, handoffs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a file change reaches the handler', async () => {
  const dir = scratch();
  const seen: string[][] = [];
  const watcher = new DocsWatcher((paths) => seen.push(paths));
  watcher.start([dir.plans, dir.handoffs]);

  try {
    assert.equal(watcher.healthy(), true, 'watchers should be armed after start');
    writeFileSync(join(dir.plans, 'demo.md'), '# demo\n');
    assert.ok(await until(() => seen.length > 0), 'the handler should fire for a new plan file');
    assert.ok(seen.flat().some((p) => p.includes('demo.md')));
  } finally {
    watcher.stop();
    dir.cleanup();
  }
});

test('a watcher error is survived and re-armed, not thrown', async () => {
  const dir = scratch();
  clearDegraded('watcher');
  const seen: string[] = [];
  const watcher = new DocsWatcher((paths) => seen.push(...paths));
  watcher.start([dir.plans]);

  try {
    // An 'error' on an FSWatcher with no listener is an uncaught exception —
    // the exact path that used to take the process down.
    const inner = (watcher as unknown as { watchers: { watcher: { emit: (e: string, x: unknown) => void } }[] }).watchers;
    assert.equal(inner.length, 1);
    inner[0].watcher.emit('error', new Error('simulated FSEvents failure'));

    assert.equal(degradedState().healthy, false, 'the fault should be recorded as degraded');
    assert.ok(watcher.status().failures >= 1);
    // The failed watch must be dropped, or health reports a lie and the test
    // below would pass without any re-arm having happened.
    assert.equal(watcher.healthy(), false, 'a failed watch must not still count as healthy');
    assert.equal(watcher.status().watching, 0);

    // Backoff starts at 1s; the watcher should come back on its own.
    assert.ok(await until(() => watcher.healthy() && watcher.status().watching === 1, 8_000),
      're-arm should restore the watch without intervention');
    assert.equal(degradedState().healthy, true, 'recovery should clear the degraded badge');

    // And the rebuilt watch must actually deliver, not merely exist.
    seen.length = 0;
    writeFileSync(join(dir.plans, 'after-rearm.md'), '# x\n');
    assert.ok(await until(() => seen.some((p) => p.includes('after-rearm.md'))),
      'the re-armed watch should deliver events');
  } finally {
    watcher.stop();
    clearDegraded('watcher');
    dir.cleanup();
  }
});

test('a watch that goes deaf is detected by the heartbeat and rebuilt', async () => {
  const dir = scratch();
  clearDegraded('watcher');
  let handlerCalls = 0;
  const watcher = new DocsWatcher(() => { handlerCalls++; });
  watcher.start([dir.handoffs]);

  try {
    // Simulate the macOS failure mode: the watch stops delivering, but nothing
    // errors and the object still looks alive. Closing behind its back is the
    // closest faithful reproduction.
    const inner = (watcher as unknown as { watchers: { watcher: { close: () => void } }[] }).watchers;
    assert.ok(inner.length > 0, 'precondition: something is being watched');
    for (const entry of inner) entry.watcher.close();

    const before = handlerCalls;
    mkdirSync(join(dir.handoffs, 'some-plan'), { recursive: true });
    writeFileSync(join(dir.handoffs, 'some-plan', 'phase-01-x.md'), '---\nstatus: complete\n---\n');

    // The heartbeat (250ms here) should notice the tree moved with no event.
    assert.ok(await until(() => handlerCalls > before, 5_000),
      'the heartbeat should force a re-read after a deaf watch');
    assert.ok(await until(() => watcher.healthy(), 5_000), 'the watch should be rebuilt');
  } finally {
    watcher.stop();
    clearDegraded('watcher');
    dir.cleanup();
  }
});

test('stopping is idempotent and leaves nothing armed', () => {
  const dir = scratch();
  const watcher = new DocsWatcher(() => {});
  watcher.start([dir.plans]);
  watcher.stop();
  watcher.stop();
  assert.equal(watcher.healthy(), false);
  assert.equal(watcher.status().watching, 0);
  dir.cleanup();
});

test('the log records structured entries and unwraps errors', () => {
  const dir = scratch();
  const file = join(dir.root, 'console.log');
  configureLog(file);

  log.info('unit.test', { a: 1 });
  log.error('unit.failure', { error: new Error('boom') });

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].event, 'unit.test');
  assert.equal(lines[0].data.a, 1);
  assert.equal(lines[1].level, 'error');
  // An Error survives JSON.stringify as `{}` unless it is unwrapped first.
  assert.equal(lines[1].data.error.message, 'boom');
  assert.ok(lines[1].data.error.stack.includes('Error'));

  assert.ok(recent(10).some((e) => e.event === 'unit.failure'));

  configureLog(null);
  dir.cleanup();
});

test('shutdown handlers all run, and one that hangs cannot block the rest', async () => {
  const order: string[] = [];
  onShutdown('fast', () => { order.push('fast'); });
  onShutdown('async', async () => { await wait(10); order.push('async'); });
  onShutdown('hung', () => new Promise<void>(() => { /* never resolves */ }));

  const started = Date.now();
  await runShutdownHandlers(200);
  const elapsed = Date.now() - started;

  assert.ok(order.includes('fast') && order.includes('async'), 'well-behaved handlers must complete');
  assert.ok(elapsed < 2_000, `a hung handler must not extend shutdown (took ${elapsed}ms)`);

  // The registry is drained, so a second shutdown is a no-op rather than a repeat.
  await runShutdownHandlers(50);
  assert.equal(order.filter((o) => o === 'fast').length, 1);
});

/* ------------------------------------------------------------------ *
 * SSE — the client that is already gone
 * ------------------------------------------------------------------ */

const { handleApi } = await import('../server/api/routes.ts');

/**
 * A browser can vanish between the response header and the first write — a
 * closed laptop, a killed tab, a reload landing mid-handshake. The stream then
 * retires itself on that very first write, which used to reach the interval
 * timer and the listener handle before either existed. That is a ReferenceError
 * thrown from the one handler whose entire job is surviving dead clients.
 */
test('an SSE client that dies before the first write does not throw', async () => {
  let unsubscribed = false;
  const service = {
    generation: 1,
    eventCursor: 7,
    eventsSince: () => [{ id: 8, event: 'changed', data: {} }],
    onEvent: () => () => { unsubscribed = true; },
  };

  const res = {
    // Already finished: every send() call takes the retire-immediately path.
    writableEnded: true,
    destroyed: false,
    writeHead() { return this; },
    write() { throw new Error('write after end'); },
    end() {},
    on() { return this; },
  };
  const req = { headers: { 'last-event-id': '7' }, on() { return this; } };

  const handled = await handleApi(
    { service } as never,
    req as never,
    res as never,
    new URL('http://127.0.0.1/events'),
  );

  assert.equal(handled, true, 'the route still owns the request');
  assert.equal(unsubscribed, true, 'the listener must be released, not leaked');
});
