/**
 * Durable sessions, and the off switch.
 *
 * Three things that were previously true only by inspection:
 *
 *  1. **What a session's end is worth telling you.** The registry raises six
 *     lifecycle events; exactly three shapes of one of them earn an
 *     interruption. The rest — including every session you closed yourself —
 *     must be silent, because a channel that fires for everything is a channel
 *     that gets muted.
 *  2. **That the `sessions` event carries enough to redraw a list.** The
 *     dashboard card and the nav badge are not holding the session's socket, so
 *     the event is the only thing that tells them.
 *  3. **How the process actually stops.** Under launchd `KeepAlive` an exit is
 *     a restart, so "stop" has to be spelled `launchctl bootout`. That decision
 *     is asserted against a fake spawner rather than by booting anything out of
 *     the machine running the tests; the unsupervised path is exercised for
 *     real, end to end, because there it is safe and it is the path that must
 *     leave nothing behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';

import { VIEWER_DIR, SKILL_DIR } from '../server/config.ts';
import { bootout, stopPlan, type Supervisor } from '../server/lifecycle.ts';
import { Service } from '../server/service.ts';
import { defaultCategories, routeFor } from '../server/push/catalogue.ts';
import type { SessionEvent, SessionInfo } from '../server/terminal.ts';

/* ------------------------------------------------------------------ *
 * The announce policy
 * ------------------------------------------------------------------ */

function service(flags: Record<string, unknown> = {}): Service {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
    ...flags,
  } as never);
  // The push register is the OPERATOR's, read from their real state directory —
  // a test that announces would send actual notifications to actual phones.
  // Every other leg is exercised for real; this one is stubbed on purpose.
  sv.push.announce = (() => {}) as typeof sv.push.announce;
  return sv;
}

/** A session record as the registry describes one, with the bits a case needs. */
function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc123', label: 'Claude 1', kind: 'claude', cwd: '/tmp', shell: 'claude',
    cols: 80, rows: 24, pid: 4242, clients: 0, createdAt: 1, lastOutputAt: 1,
    ...overrides,
  };
}

/**
 * Drive one lifecycle event through the service and report both legs: what went
 * out over SSE, and what reached the inbox.
 */
function fire(sv: Service, event: SessionEvent): { events: string[]; announced: string[] } {
  const events: string[] = [];
  const off = sv.onEvent((name) => { events.push(name); });
  // Diffed by id, never by count: the inbox is a real, persisted, bounded store
  // shared with whatever ran before, so "one more than there was" is not the
  // same question as "what did this announce".
  const before = new Set(sv.inbox({ limit: 500 }).items.map((r) => r.id));
  (sv as unknown as { onSessionEvent: (e: SessionEvent) => void }).onSessionEvent(event);
  off();
  const announced = sv.inbox({ limit: 500 }).items
    .filter((r) => !before.has(r.id))
    .map((r) => r.title);
  return { events, announced };
}

test('a session ending is announced when nobody saw it, when it failed, or when it was a repair', () => {
  const sv = service();
  sv.savePreferences({ notify: defaultCategories() } as never);

  // ---- announced: it finished while you were not attached ----
  const quiet = fire(sv, {
    type: 'exited',
    session: session({ exited: { code: 0 }, exitedAt: 2 }),
    detached: true,
  });
  assert.deepEqual(quiet.announced, ['Agent session finished']);

  // ---- announced: it failed, even with a tab open on it ----
  const failed = fire(sv, {
    type: 'exited',
    session: session({ id: 'd2', label: 'Terminal 3', kind: 'shell', exited: { code: 127 }, exitedAt: 3 }),
    detached: false,
  });
  assert.deepEqual(failed.announced, ['Terminal failed']);

  // ---- announced: a recovery session, however it ended and whoever watched ----
  const repair = fire(sv, {
    type: 'exited',
    session: session({
      id: 'd3',
      exited: { code: 0 },
      exitedAt: 4,
      meta: { intent: 'recovery', recovery: { kind: 'verify-failed', slug: 'demo', phase: 3 } },
    }),
    detached: false,
  });
  assert.deepEqual(repair.announced, ['Agent session finished']);

  // ---- silent: a clean exit you were watching happen ----
  const watched = fire(sv, {
    type: 'exited',
    session: session({ id: 'd4', exited: { code: 0 }, exitedAt: 5 }),
    detached: false,
  });
  assert.deepEqual(watched.announced, [], 'you were looking at it — that is not news');

  // ---- silent: every other lifecycle moment ----
  for (const type of ['created', 'attached', 'detached', 'killed', 'dismissed'] as const) {
    const other = fire(sv, { type, session: session({ id: `x-${type}` }) });
    assert.deepEqual(other.announced, [], `${type} must not raise a notification`);
    assert.ok(other.events.includes('sessions'), `${type} must still reach the stream`);
  }
});

test('a session you closed yourself is never announced, even though its pty exits', () => {
  const sv = service();
  sv.savePreferences({ notify: defaultCategories() } as never);

  // This is the shape `kill()` produces — and the reason it reports `killed`
  // rather than `exited`. If the operator's own close arrived here as an exit,
  // every deliberate ✕ would buzz a phone.
  const closed = fire(sv, {
    type: 'killed',
    session: session({ exited: { code: 0, closedByOperator: true }, exitedAt: 9 }),
  });
  assert.deepEqual(closed.announced, []);
});

test('the session category obeys the global switch like every other', () => {
  const sv = service();
  sv.savePreferences({ notify: { ...defaultCategories(), session: false } } as never);
  const off = fire(sv, {
    type: 'exited',
    session: session({ exited: { code: 3 }, exitedAt: 2 }),
    detached: true,
  });
  assert.deepEqual(off.announced, [], 'switched off means no inbox record — the P1 gate covers this one too');
  assert.ok(off.events.includes('sessions'), 'the live stream is not a notification and is unaffected');
});

test('the sessions event carries the whole list, so a surface that has no socket can redraw', () => {
  const sv = service();
  const seen: unknown[] = [];
  sv.onEvent((name, data) => { if (name === 'sessions') seen.push(data); });
  (sv as unknown as { onSessionEvent: (e: SessionEvent) => void })
    .onSessionEvent({ type: 'created', session: session() });

  const payload = seen[0] as { type: string; session: SessionInfo; sessions: SessionInfo[]; live: number };
  assert.equal(payload.type, 'created');
  assert.equal(payload.session.id, 'abc123');
  assert.ok(Array.isArray(payload.sessions), 'the list rides along rather than forcing a refetch');
  assert.equal(typeof payload.live, 'number');
});

test('a session notification deep-links to the session, and degrades to its page', () => {
  assert.equal(routeFor('session', { sessionId: 'abc123', sessionKind: 'claude' }), '/#/agent/abc123');
  assert.equal(routeFor('session', { sessionId: 'abc123', sessionKind: 'shell' }), '/#/terminal/abc123');
  // The record may be long gone by the time a push is tapped; the page is a
  // real destination, `/#/agent/undefined` is not.
  assert.equal(routeFor('session'), '/#/terminal');
  assert.equal(routeFor('session', { sessionKind: 'claude' }), '/#/agent');
  assert.equal(routeFor('session', { sessionId: 'a/b?c', sessionKind: 'claude' }), '/#/agent/a%2Fb%3Fc');
});

/* ------------------------------------------------------------------ *
 * The inventory
 * ------------------------------------------------------------------ */

test('the inventory counts live processes by kind, and ended records separately', async () => {
  const sv = service({ allowTerminal: true, allowAgent: true });
  const ptys: { exit: (code: number) => void }[] = [];
  // The registry's own spawn seam — the same one `test/terminal.test.ts` uses,
  // so no native module is involved.
  (sv.terminals as unknown as { options: { spawn?: unknown } }).options.spawn = (() => {
    const pty = {
      pid: 1, exit: (_code: number) => {},
      onData() {}, onExit(fn: (e: { exitCode: number }) => void) { pty.exit = (code) => fn({ exitCode: code }); },
      write() {}, resize() {}, kill() {},
    };
    ptys.push(pty);
    return pty;
  }) as never;

  const shell = await sv.terminals.mint();
  await sv.terminals.mint(undefined, undefined, {
    kind: 'claude', file: 'claude', args: [], label: 'Claude 1',
  });
  assert.ok(shell.ok, 'the shell minted');

  const both = sv.sessionInventory();
  assert.deepEqual(
    { live: both.live, agent: both.agent, terminal: both.terminal, ended: both.ended },
    { live: 2, agent: 1, terminal: 1, ended: 0 },
  );
  assert.equal(both.sessions.length, 2);

  // One dies: it leaves the live count and the inventory of what a shutdown
  // would stop, but stays listed as an ended record.
  ptys[0].exit(0);
  const after = sv.sessionInventory();
  assert.deepEqual(
    { live: after.live, agent: after.agent, terminal: after.terminal, ended: after.ended },
    { live: 1, agent: 1, terminal: 0, ended: 1 },
  );
  assert.equal(after.sessions.length, 1, 'a dialog says what it will stop, not what already stopped');

  sv.terminals.close();
});

/* ------------------------------------------------------------------ *
 * How the process stops
 * ------------------------------------------------------------------ */

const LAUNCHD: Supervisor = {
  supervised: true, kind: 'launchd', detail: 'launchd · com.example.console · KeepAlive is on',
};

test('under launchd, stopping means booting the job out — not exiting', () => {
  const plan = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501);
  assert.equal(plan.via, 'launchctl');
  assert.equal(plan.via === 'launchctl' && plan.file, 'launchctl');
  // `stop` under KeepAlive is a restart with extra steps; `bootout` on the
  // service target is the sentence that means "and stay off".
  assert.deepEqual(plan.via === 'launchctl' && plan.args, ['bootout', 'gui/501/com.example.console']);
  assert.match(plan.detail, /stays off/);
});

test('with nothing supervising, stopping is just exiting', () => {
  const plan = stopPlan(
    { supervised: false, kind: 'none', detail: 'nothing is supervising this process' },
    {}, 501,
  );
  assert.equal(plan.via, 'exit');

  // A launchd job whose label this process cannot read cannot be booted out by
  // name — exiting is the honest fallback, not a guessed label.
  assert.equal(stopPlan(LAUNCHD, {}, 501).via, 'exit');
  // A platform with no uid (Windows) cannot name a `gui/<uid>/…` target.
  assert.equal(stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, null).via, 'exit');

  // systemd is supervision this process cannot unload; it says so rather than
  // pretending an exit is a stop.
  const systemd = stopPlan(
    { supervised: true, kind: 'systemd', detail: 'systemd started this unit', assumed: true },
    { INVOCATION_ID: 'x' }, 501,
  );
  assert.equal(systemd.via, 'exit');
  assert.match(systemd.detail, /may be brought back/);
});

test('bootout spawns detached, and a spawn that throws does not take the shutdown with it', () => {
  const calls: { file: string; args: string[]; options: unknown }[] = [];
  const plan = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501);

  const ok = bootout(plan, (file, args, options) => {
    calls.push({ file, args, options });
    return { unref() {} };
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'launchctl');
  assert.deepEqual(calls[0].args, ['bootout', 'gui/501/com.example.console']);
  // Detached with no stdio: the command outlives this process on purpose — it
  // is the thing that ends it.
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore' });

  assert.equal(bootout(plan, () => { throw new Error('launchctl: not found'); }), false,
    'a missing launchctl is a false, so the caller falls through to exiting');
  assert.equal(bootout({ via: 'exit', detail: '' }, () => { throw new Error('must not spawn'); }), false);
});

/* ------------------------------------------------------------------ *
 * The endpoint, against a real console
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function http(
  port: number, path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    call.on('error', reject);
    call.end(opts.body);
  });
}

async function waitFor(port: number, tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const CONSOLE_HEADERS = { 'x-phase-console': '1', 'content-type': 'application/json' };

test('POST /api/shutdown stops an unsupervised console, and refuses to do it by accident', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    join(VIEWER_DIR, 'server', 'index.ts'),
    '--port', String(port), '--no-open', '--no-log-file', '--allow-terminal',
  ], {
    stdio: 'ignore',
    // Nothing supervising: the graceful path, and the one that is safe to run
    // for real on the machine running the tests.
    env: { ...process.env, PHASE_CONSOLE_SUPERVISED: '0', XPC_SERVICE_NAME: '' },
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  try {
    if (!await waitFor(port)) assert.fail('the console did not come up');

    // The readiness read is what the confirm dialog renders — an inventory, and
    // never a refusal: a console you cannot turn off because it is busy is the
    // bug this endpoint exists to fix.
    const readiness = JSON.parse((await http(port, '/api/shutdown')).body);
    assert.equal(readiness.stop.via, 'exit');
    assert.equal(readiness.sessions.live, 0);
    assert.ok('busy' in readiness && 'run' in readiness);
    assert.match(String(readiness.restartHint), /start it again/);

    // Same-origin + console header, like every other mutation.
    assert.equal((await http(port, '/api/shutdown', { method: 'POST', body: '{"confirm":true}' })).status, 403);
    assert.equal((await http(port, '/api/shutdown', {
      method: 'POST', headers: { ...CONSOLE_HEADERS, origin: 'https://evil.example' }, body: '{"confirm":true}',
    })).status, 403);

    // A bare POST — a stray curl, a replayed request — must not end a console.
    const bare = await http(port, '/api/shutdown', { method: 'POST', headers: CONSOLE_HEADERS, body: '{}' });
    assert.equal(bare.status, 400);
    assert.match(bare.body, /confirm/);
    assert.ok(await waitFor(port, 10), 'and it is still serving');

    const done = await http(port, '/api/shutdown', {
      method: 'POST', headers: CONSOLE_HEADERS, body: '{"confirm":true,"by":"a test"}',
    });
    assert.equal(done.status, 200);
    assert.equal(JSON.parse(done.body).ok, true);

    // The response reaches the browser BEFORE the socket it arrived on closes —
    // that is what the 250ms delay in `onShutdownRequest` buys — and then the
    // process actually goes, cleanly, after its drain.
    const code = await Promise.race([
      exited,
      // `.unref()`, or the losing timer holds the test runner open for its full
      // 20 seconds after the console has already gone.
      new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), 20_000).unref(); }),
    ]);
    assert.equal(code, 0, 'an unsupervised shutdown exits 0 after the drain');
  } finally {
    child.kill('SIGKILL');
  }
});
