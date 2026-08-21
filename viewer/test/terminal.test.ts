/**
 * The terminal.
 *
 * Three layers, because the failure modes are in three different places:
 *
 *  1. **The registry**, in process, against an injected fake pty — the token
 *     rules, the scrollback ring and the wire protocol, deterministically and
 *     with no native module involved.
 *  2. **The gate**, against a real server over real HTTP — that the flag, the
 *     console header and the access gate are actually consulted, in that order,
 *     on both the mint and the upgrade. A decision that is correct but never
 *     asked is worth nothing.
 *  3. **A real shell**, end to end — or, on a machine where `node-pty` did not
 *     build, the graceful refusal instead. Deliberately not a skip: "the
 *     terminal degrades and the console is unaffected" is the requirement, so
 *     it is asserted rather than stepped over.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { VIEWER_DIR, parseFlags } from '../server/config.ts';
import {
  Scrollback, Terminals, TERMINAL_PATH, healSpawnHelper, shouldReap, type LaunchSpec,
} from '../server/terminal.ts';
import { spawnConsole } from './spawn-console.ts';

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

/** A pty that does nothing but remember what it was told. */
function fakePty() {
  const pty = {
    pid: 4242,
    written: [] as string[],
    resized: [] as [number, number][],
    killed: false,
    emit: (_text: string) => {},
    exit: (_code: number) => {},
    onData(listener: (data: string) => void) { pty.emit = listener; },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      pty.exit = (code: number) => listener({ exitCode: code });
    },
    write(data: string) { pty.written.push(data); },
    resize(cols: number, rows: number) { pty.resized.push([cols, rows]); },
    kill() { pty.killed = true; },
  };
  return pty;
}

/** A socket that records frames, so the protocol can be asserted directly. */
function fakeWire() {
  const wire = {
    frames: [] as (string | Uint8Array)[],
    listeners: new Map<string, (...args: unknown[]) => void>(),
    bufferedAmount: 0,
    closed: false,
    send(data: string | Uint8Array) { wire.frames.push(data); },
    close() { wire.closed = true; wire.listeners.get('close')?.(); },
    on(event: string, listener: (...args: unknown[]) => void) { wire.listeners.set(event, listener); },
    say(text: string) { wire.listeners.get('message')?.(text, false); },
    text() {
      return wire.frames
        .filter((f) => typeof f !== 'string')
        .map((f) => Buffer.from(f as Uint8Array).toString('utf8'))
        .join('');
    },
    control() {
      return wire.frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));
    },
  };
  return wire;
}

function registry(overrides: Record<string, unknown> = {}) {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const terminals = new Terminals({
    allowed: true,
    cwd: () => VIEWER_DIR,
    spawn: () => { const pty = fakePty(); ptys.push(pty); return pty as never; },
    ...overrides,
  });
  return { terminals, ptys };
}

/* ------------------------------------------------------------------ *
 * Scrollback
 * ------------------------------------------------------------------ */

test('scrollback keeps the last N bytes and never splits a chunk', () => {
  const ring = new Scrollback(100);
  ring.push('a'.repeat(60));
  ring.push('b'.repeat(60));
  // Evicting whole chunks means the ring can sit under its limit, never over —
  // half an escape sequence renders the rest of the session in the wrong colour.
  assert.equal(ring.text(), 'b'.repeat(60));
  assert.ok(ring.bytes <= 100);
});

test('scrollback keeps the newest chunk even when it alone is over the limit', () => {
  const ring = new Scrollback(10);
  ring.push('x'.repeat(500));
  assert.equal(ring.text().length, 500, 'the live screen is more useful than an empty one');
});

test('scrollback counts bytes, not characters', () => {
  const ring = new Scrollback(1000);
  ring.push('é'.repeat(10));
  assert.equal(ring.bytes, 20);
});

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

test('a ticket is single-use', async () => {
  const { terminals } = registry();
  const minted = await terminals.mint();
  assert.equal(minted.ok, true);
  const token = minted.ok ? minted.token : '';

  assert.ok(terminals.consume(token), 'the first use works');
  assert.equal(terminals.consume(token), null, 'the second does not');
  terminals.close();
});

test('a forged, empty or absent token is refused', async () => {
  const { terminals } = registry();
  await terminals.mint();
  for (const token of ['', null, undefined, 'f'.repeat(64), 'short']) {
    assert.equal(terminals.consume(token as string), null, `${String(token)} must not open a shell`);
  }
  terminals.close();
});

test('a ticket dies with its session', async () => {
  const { terminals } = registry();
  const minted = await terminals.mint();
  const { sessionId, token } = minted as { sessionId: string; token: string };
  terminals.kill(sessionId);
  assert.equal(terminals.consume(token), null);
  terminals.close();
});

test('with the flag off nothing is minted, whatever else is true', async () => {
  const { terminals } = registry({ allowed: false });
  const minted = await terminals.mint();
  assert.equal(minted.ok, false);
  assert.equal(minted.ok === false && minted.status, 403);
  assert.equal(terminals.state().sessions.length, 0, 'and no shell was started');
  terminals.close();
});

test('reattaching names a session instead of opening another', async () => {
  const { terminals, ptys } = registry();
  const first = await terminals.mint() as { sessionId: string };
  await terminals.mint(first.sessionId);
  assert.equal(ptys.length, 1, 'one pty, two tickets');
  assert.equal(terminals.state().sessions.length, 1);
  terminals.close();
});

test('a ticket for a session that has ended is a 404, not a new shell', async () => {
  const { terminals, ptys } = registry();
  const first = await terminals.mint() as { sessionId: string };
  terminals.kill(first.sessionId);
  const again = await terminals.mint(first.sessionId);
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.status, 404);
  assert.equal(ptys.length, 1);
  terminals.close();
});

test('the session cap is a wall, not a suggestion', async () => {
  const { terminals } = registry();
  const limit = terminals.state().limit;
  for (let i = 0; i < limit; i++) assert.equal((await terminals.mint()).ok, true);
  const over = await terminals.mint();
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.status, 409);
  terminals.close();
});

/* ------------------------------------------------------------------ *
 * The wire protocol
 * ------------------------------------------------------------------ */

test('attaching says hello, then replays what was missed', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  assert.ok(session);

  ptys[0].emit('hello from the shell\r\n');

  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  const [hello] = wire.control();
  assert.equal(hello.t, 'hello');
  assert.equal(typeof hello.session.id, 'string');
  assert.equal(wire.text(), 'hello from the shell\r\n', 'output produced before the socket existed');
  terminals.close();
});

test('output is binary and control is text, so neither can be read as the other', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  // A shell that printed valid JSON would otherwise be indistinguishable from
  // a control frame — which is the entire reason for the split.
  ptys[0].emit('{"t":"exit","code":0}');
  assert.deepEqual(wire.control().map((c) => c.t), ['hello'], 'the shell cannot forge a control frame');
  assert.match(wire.text(), /"t":"exit"/);
  terminals.close();
});

test('input reaches the pty and a resize reaches the ioctl', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  wire.say(JSON.stringify({ t: 'i', d: 'echo hi\r' }));
  wire.say(JSON.stringify({ t: 'r', cols: 132, rows: 44 }));
  assert.deepEqual(ptys[0].written, ['echo hi\r']);
  assert.deepEqual(ptys[0].resized, [[132, 44]]);
  assert.equal(terminals.state().sessions[0].cols, 132);
  terminals.close();
});

test('a ping is answered with a pong, and touches nothing', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  // The client's heartbeat: a browser cannot see WebSocket ping/pong frames,
  // so the link asks in the envelope and a silent socket is told apart from a
  // quiet session by this answer. The pty hears nothing about it.
  wire.say(JSON.stringify({ t: 'ping' }));
  assert.deepEqual(wire.control().map((c) => c.t), ['hello', 'pong']);
  assert.deepEqual(ptys[0].written, []);
  assert.deepEqual(ptys[0].resized, []);
  terminals.close();
});

test('a nonsense frame is ignored rather than interpreted', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  for (const junk of ['not json', '[]', 'null', '{"t":"i"}', '{"t":"r","cols":"wide"}', '{"t":"eval"}']) {
    wire.say(junk);
  }
  assert.deepEqual(ptys[0].written, []);
  assert.deepEqual(ptys[0].resized, []);
  terminals.close();
});

test('an absurd size is clamped, never passed through', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  wire.say(JSON.stringify({ t: 'r', cols: 100_000, rows: -5 }));
  assert.deepEqual(ptys[0].resized, [[500, 5]]);
  terminals.close();
});

test('the shell exiting is announced, and typing afterwards goes nowhere', async () => {
  const { terminals, ptys } = registry();
  const minted = await terminals.mint() as { token: string };
  const session = terminals.consume(minted.token);
  const wire = fakeWire();
  terminals.attach(session as never, wire as never);

  ptys[0].exit(3);
  const exit = wire.control().find((c) => c.t === 'exit');
  assert.equal(exit?.code, 3);

  wire.say(JSON.stringify({ t: 'i', d: 'still here?' }));
  assert.deepEqual(ptys[0].written, [], 'a dead pty must not be written to');
  terminals.close();
});

test('closing the registry kills every child', async () => {
  const { terminals, ptys } = registry();
  await terminals.mint();
  await terminals.mint();
  terminals.close();
  assert.deepEqual(ptys.map((p) => p.killed), [true, true]);
  assert.equal(terminals.state().sessions.length, 0);
});

/* ------------------------------------------------------------------ *
 * The prebuild that ships un-executable
 * ------------------------------------------------------------------ */

test('the node-pty spawn helper is executable', () => {
  // node-pty 1.1.0 publishes `prebuilds/<platform>/spawn-helper` as 0644. The
  // failure is `Error: posix_spawnp failed.` from inside the addon — nothing in
  // it says "chmod", and reinstalling reproduces it exactly.
  const healed = healSpawnHelper();
  const path = healed ?? join(
    VIEWER_DIR, 'node_modules', 'node-pty', 'prebuilds',
    `${process.platform}-${process.arch}`, 'spawn-helper',
  );
  let mode: number;
  try { mode = statSync(path).mode; } catch { return; } // no prebuild for this platform
  assert.ok(mode & 0o111, `${path} is not executable (${(mode & 0o777).toString(8)})`);
});

/* ------------------------------------------------------------------ *
 * The gate, over real HTTP
 * ------------------------------------------------------------------ */

const HOST = 'console.example.ts.net';
const USER = 'operator@example.com';

type Reply = { status: number; body: string };

function http(
  port: number, path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    call.on('error', reject);
    call.end(opts.body);
  });
}

/**
 * A WebSocket handshake by hand.
 *
 * `ws` builds its own Host header from the URL, and Host is exactly what these
 * cases need to lie about — so the handshake is written out. 101 means the
 * upgrade was accepted; anything else is the refusal, with its status.
 */
function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port, path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    call.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    call.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    call.on('error', reject);
    call.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(port: number, headers: Record<string, string> = {}, tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state', { headers })).status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function console_(t: { after(fn: () => void): void }, ...args: string[]): Promise<number> {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, args);
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });
  return port;
}

const CONSOLE_HEADERS = { 'x-phase-console': '1', 'content-type': 'application/json' };

test('without --allow-terminal there is no ticket and no socket', async (t) => {
  const port = await console_(t);
  if (!await waitFor(port)) assert.fail('the console did not come up');

  const minted = await http(port, '/api/terminal', { method: 'POST', headers: CONSOLE_HEADERS, body: '{}' });
  assert.equal(minted.status, 403);
  assert.match(minted.body, /--allow-terminal/);

  // Refused on the flag, before the token is even looked at: whether a token is
  // valid must not be discoverable on a console with the terminal turned off.
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${'f'.repeat(64)}`), 403);
  assert.equal(await upgrade(port, TERMINAL_PATH), 403);

  // And the page still exists, so a deep link explains itself rather than 404ing.
  assert.equal((await http(port, '/api/terminal')).status, 200);
  assert.equal(JSON.parse((await http(port, '/api/terminal')).body).allowed, false);
});

test('a ticket needs the console header and the same origin', async (t) => {
  const port = await console_(t, '--allow-terminal');
  if (!await waitFor(port)) assert.fail('the console did not come up');

  assert.equal((await http(port, '/api/terminal', { method: 'POST', body: '{}' })).status, 403,
    'no console header');
  assert.equal((await http(port, '/api/terminal', {
    method: 'POST', body: '{}', headers: { ...CONSOLE_HEADERS, origin: 'https://evil.example' },
  })).status, 403, 'another origin');
});

test('an upgrade without a good token is refused, whatever Origin claims', async (t) => {
  const port = await console_(t, '--allow-terminal');
  if (!await waitFor(port)) assert.fail('the console did not come up');

  // Origin is not consulted on an upgrade — CORS does not apply to one and the
  // header is forgeable — so a *correct-looking* Origin must not help either.
  assert.equal(await upgrade(port, TERMINAL_PATH), 401, 'no token');
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=`), 401, 'empty token');
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${'f'.repeat(64)}`), 401, 'forged token');
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=x`, {
    origin: `http://127.0.0.1:${port}`,
  }), 401, 'a same-origin claim buys nothing');
  assert.equal(await upgrade(port, '/ws/anything-else'), 404, 'and no other socket exists');
});

test('the access gate runs on the upgrade itself, not only on the page', async (t) => {
  const port = await console_(t, '--allow-terminal', '--remote', HOST, '--remote-user', USER);
  if (!await waitFor(port)) assert.fail('the console did not come up');

  const allowed = { host: HOST, 'tailscale-user-login': USER };

  // A valid ticket, obtained the legitimate way, through the proxy.
  const minted = await http(port, '/api/terminal', {
    method: 'POST', headers: { ...CONSOLE_HEADERS, ...allowed, origin: `https://${HOST}` }, body: '{}',
  });
  if (minted.status === 503) {
    // No pty on this machine — the gate is still the thing under test, so
    // assert it with a forged token instead of skipping the case.
    assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=x`, { host: 'attacker.example' }), 400);
    assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=x`, { host: HOST }), 403);
    return;
  }
  assert.equal(minted.status, 200, minted.body);
  const { token } = JSON.parse(minted.body) as { token: string };

  // That same good token gets nowhere without an identity the console knows.
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${token}`, { host: 'attacker.example' }), 400,
    'an unknown Host');
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${token}`, { host: HOST }), 403,
    'the right Host with no identity');
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${token}`, {
    host: HOST, 'tailscale-user-login': 'someone-else@example.com',
  }), 403, 'an identity that is not on the list');

  // Unspent through all of that, and still good for the caller it was minted for.
  assert.equal(await upgrade(port, `${TERMINAL_PATH}?token=${token}`, allowed), 101);
});

/* ------------------------------------------------------------------ *
 * A real shell — or a clean refusal
 * ------------------------------------------------------------------ */

test('a real shell runs and reattaches — or says why it cannot, leaving the console intact', async (t) => {
  // A sandbox root, never the operator's plan library: this console runs a real
  // shell and a real watcher, and the test needs neither pointed at real work.
  const port = await console_(t, '--allow-terminal');
  if (!await waitFor(port)) assert.fail('the console did not come up');

  const minted = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ cols: 90, rows: 30 }),
  });

  if (minted.status === 503) {
    // The whole point of the lazy import: no pty, but a console that still works.
    assert.match(minted.body, /node-pty/);
    assert.equal((await http(port, '/api/state')).status, 200);
    assert.equal(JSON.parse((await http(port, '/api/terminal')).body).available, 'no');
    return;
  }

  assert.equal(minted.status, 200, minted.body);
  const ticket = JSON.parse(minted.body) as { sessionId: string; token: string; path: string };
  assert.equal(ticket.path, TERMINAL_PATH);

  const { default: WebSocket } = await import('ws');
  const open = (token: string) => new Promise<{
    socket: import('ws').WebSocket; out: () => string; control: unknown[];
  }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_PATH}?token=${token}`);
    let out = '';
    const control: unknown[] = [];
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) out += data.toString('utf8');
      else control.push(JSON.parse(data.toString('utf8')));
    });
    socket.on('open', () => resolve({ socket, out: () => out, control }));
    socket.on('error', reject);
  });

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean, ms = 8_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await settle(50);
    }
    return false;
  };

  const first = await open(ticket.token);
  t.after(() => first.socket.close());
  first.socket.send(JSON.stringify({ t: 'i', d: 'echo MARKER_ONE_$((6*7))\r' }));
  assert.ok(await until(() => first.out().includes('MARKER_ONE_42')),
    `the shell did not run the command; saw: ${JSON.stringify(first.out().slice(-200))}`);

  // Reattach: drop the socket, mint again for the same session, expect the
  // scrollback — this is what makes a phone locking its screen survivable.
  first.socket.close();
  await settle(150);
  const again = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ sessionId: ticket.sessionId }),
  });
  assert.equal(again.status, 200, again.body);
  const second = await open((JSON.parse(again.body) as { token: string }).token);
  t.after(() => second.socket.close());
  assert.ok(await until(() => second.out().includes('MARKER_ONE_42')),
    'reattaching replayed no scrollback');

  // The pty is resized for real, not just recorded.
  second.socket.send(JSON.stringify({ t: 'r', cols: 132, rows: 44 }));
  await settle(150);
  second.socket.send(JSON.stringify({ t: 'i', d: 'echo WIDTH_IS_$(tput cols)\r' }));
  assert.ok(await until(() => second.out().includes('WIDTH_IS_132')),
    `the resize never reached the pty; saw: ${JSON.stringify(second.out().slice(-200))}`);

  const listed = JSON.parse((await http(port, '/api/terminal')).body) as {
    available: string; sessions: { id: string }[];
  };
  assert.equal(listed.available, 'yes');
  assert.equal(listed.sessions.length, 1);

  const closed = await http(port, `/api/terminal?id=${ticket.sessionId}`, {
    method: 'DELETE', headers: CONSOLE_HEADERS,
  });
  assert.equal(closed.status, 200);
  assert.equal(JSON.parse(closed.body).closed, true);
  assert.equal(JSON.parse((await http(port, '/api/terminal')).body).sessions.length, 0);
});

/* ------------------------------------------------------------------ *
 * Agent sessions (kind: 'claude')
 * ------------------------------------------------------------------ */

/** A resolved claude launch — the shape `agent.ts` produces. */
function claudeLaunch(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    kind: 'claude',
    file: 'claude',
    args: ['--session-id', '00000000-0000-4000-8000-000000000000', '--model', 'opus', 'hello'],
    meta: { model: 'opus', claudeSessionId: '00000000-0000-4000-8000-000000000000' },
    ...overrides,
  };
}

test('an agent session needs its own flag, and a shell still needs its own', async () => {
  // The shell capability alone does not admit a claude session…
  const shellOnly = registry({ agentAllowed: false });
  const refusedClaude = await shellOnly.terminals.mint(undefined, undefined, claudeLaunch());
  assert.equal(refusedClaude.ok, false);
  assert.equal(refusedClaude.ok === false && refusedClaude.status, 403);
  assert.match(refusedClaude.ok === false ? refusedClaude.error : '', /--allow-agent/);
  assert.equal(shellOnly.terminals.state().sessions.length, 0, 'and nothing was spawned');
  shellOnly.terminals.close();

  // …and the agent capability alone does not admit a shell.
  const agentOnly = registry({ allowed: false, agentAllowed: true });
  const refusedShell = await agentOnly.terminals.mint();
  assert.equal(refusedShell.ok, false);
  assert.match(refusedShell.ok === false ? refusedShell.error : '', /--allow-terminal/);

  // A claude session works there, and a reattach names it rather than
  // opening another — the reattach is judged by the SESSION's kind.
  const claude = await agentOnly.terminals.mint(undefined, undefined, claudeLaunch());
  assert.equal(claude.ok, true);
  const again = await agentOnly.terminals.mint(claude.ok ? claude.sessionId : '');
  assert.equal(again.ok, true);
  assert.equal(agentOnly.terminals.state().sessions.length, 1);
  agentOnly.terminals.close();
});

test('a claude session spawns exactly what the launch spec resolved, in the shell env', async () => {
  const spawns: { file: string; args: string[]; options: { cwd: string; env: Record<string, string | undefined> } }[] = [];
  const { terminals } = registry({
    agentAllowed: true,
    spawn: (file: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => {
      spawns.push({ file, args, options });
      return fakePty() as never;
    },
  });

  const spec = claudeLaunch({ label: 'Claude: hello' });
  const minted = await terminals.mint(undefined, { cols: 100, rows: 31 }, spec);
  assert.equal(minted.ok, true);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, 'claude');
  assert.deepEqual(spawns[0].args, spec.args, 'argv is the spec — nothing added, nothing lost');
  assert.equal(spawns[0].options.cwd, VIEWER_DIR);
  assert.equal(spawns[0].options.env.TERM, 'xterm-256color');
  assert.equal(
    spawns[0].options.env.CLAUDE_CODE_RETRY_WATCHDOG,
    process.env.CLAUDE_CODE_RETRY_WATCHDOG,
    'the runner’s unattended-retry env is inherited at most, never added',
  );

  const session = terminals.state().sessions[0];
  assert.equal(session.kind, 'claude');
  assert.equal(session.label, 'Claude: hello');
  assert.equal(session.shell, 'claude');
  assert.equal(session.meta?.claudeSessionId, '00000000-0000-4000-8000-000000000000');
  terminals.close();
});

test('claude sessions and shells count on separate label counters', async () => {
  const { terminals } = registry({ agentAllowed: true });
  const c1 = await terminals.mint(undefined, undefined, claudeLaunch({ label: undefined }));
  const s1 = await terminals.mint();
  const c2 = await terminals.mint(undefined, undefined, claudeLaunch({ label: undefined }));
  assert.equal(c1.ok && c1.session.label, 'Claude 1');
  assert.equal(s1.ok && s1.session.label, 'Terminal 1');
  assert.equal(c2.ok && c2.session.label, 'Claude 2');
  terminals.close();
});

test('a living session is never reaped — shell or claude, watched or not', () => {
  const MIN = 60_000;
  const retainMs = 24 * 60 * MIN;
  const now = 1_000 * MIN;
  const longAgo = now - 400 * MIN; // detached, and silent, for most of a day

  // The whole matrix of live sessions: both kinds, attached and detached,
  // talkative and silent. Every one of these used to be reapable after 30
  // idle minutes; none of them is now. This is the assertion the durability
  // requirement rests on, so it is written out rather than parameterised away.
  for (const wires of [0, 1]) {
    for (const lastOutputAt of [longAgo, now - MIN]) {
      assert.equal(
        shouldReap({ wires, exitedAt: lastOutputAt }, now, retainMs), false,
        `a live session (wires=${wires}) must never be reaped`,
      );
    }
  }

  // What IS collectable: a record whose process is gone, nobody is reading,
  // and nobody dismissed within the retention window.
  assert.equal(shouldReap({ wires: 0, exited: { code: 0 }, exitedAt: longAgo }, now, retainMs), false,
    'inside the window it is kept — "until you dismiss it" means it is still there tomorrow morning');
  assert.equal(shouldReap({ wires: 0, exited: { code: 0 }, exitedAt: now - retainMs - 1 }, now, retainMs), true);
  // …unless someone is attached to it, reading what it said before it died.
  assert.equal(shouldReap({ wires: 1, exited: { code: 0 }, exitedAt: now - retainMs - 1 }, now, retainMs), false);
  // A missing timestamp is treated as "just now", never as 1970.
  assert.equal(shouldReap({ wires: 0, exited: { code: 1 } }, now, retainMs), false);
});

test('the registry keeps ended sessions, frees their slot, and dismisses only the dead', async () => {
  const { terminals, ptys } = registry({ agentAllowed: true });
  const first = await terminals.mint();
  assert.ok(first.ok);
  const id = first.ok ? first.sessionId : '';

  ptys[0].exit(3);

  // The record survives its process, exit status and all — this is what used
  // to disappear ~30 seconds after the shell died.
  const after = terminals.state();
  assert.equal(after.sessions.length, 1);
  assert.deepEqual(after.sessions[0].exited, { code: 3, signal: undefined });
  assert.ok(after.sessions[0].exitedAt);
  // …and it no longer occupies one of the eight.
  assert.equal(after.live, 0);

  // Dismiss removes it; dismissing a live one is refused rather than obeyed.
  const live = await terminals.mint();
  assert.ok(live.ok);
  const liveId = live.ok ? live.sessionId : '';
  const refused = terminals.dismiss(liveId);
  assert.equal(refused.ok, false);
  assert.match(String(refused.reason), /still running/);
  assert.equal(terminals.state().sessions.length, 2);

  assert.deepEqual(terminals.dismiss(id), { ok: true });
  assert.deepEqual(terminals.state().sessions.map((s) => s.id), [liveId]);
  assert.deepEqual(terminals.dismiss('nope'), { ok: false, reason: 'no such session' });

  terminals.close();
});

test('the live cap counts processes, not records', async () => {
  const { terminals, ptys } = registry();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const minted = await terminals.mint();
    assert.ok(minted.ok, `session ${i} should mint`);
    if (minted.ok) ids.push(minted.sessionId);
  }
  // Eight live: the ninth is refused.
  const ninth = await terminals.mint();
  assert.equal(ninth.ok, false);
  if (!ninth.ok) assert.equal(ninth.status, 409);

  // One exits. Its record stays, but the slot is free again.
  ptys[0].exit(0);
  assert.equal(terminals.state().sessions.length, 8);
  assert.equal(terminals.state().live, 7);
  const tenth = await terminals.mint();
  assert.equal(tenth.ok, true);
  assert.equal(terminals.state().sessions.length, 9);

  terminals.close();
});

test('lifecycle events narrate every session moment, and a kill is not an exit', async () => {
  const seen: { type: string; id: string; detached?: boolean }[] = [];
  const { terminals, ptys } = registry({
    onSession: (event: { type: string; session: { id: string }; detached?: boolean }) =>
      seen.push({ type: event.type, id: event.session.id, detached: event.detached }),
  });

  const minted = await terminals.mint();
  assert.ok(minted.ok);
  const id = minted.ok ? minted.sessionId : '';
  assert.deepEqual(seen.map((e) => e.type), ['created']);

  // Attach, then let the socket go: both are events, and the detach is what
  // makes the exit that follows worth announcing.
  const wire = fakeWire();
  const session = terminals.consume(minted.ok ? minted.token : '');
  assert.ok(session);
  terminals.attach(session!, wire as never);
  assert.equal(seen.at(-1)?.type, 'attached');
  wire.close();
  assert.equal(seen.at(-1)?.type, 'detached');

  ptys[0].exit(1);
  assert.deepEqual(seen.at(-1), { type: 'exited', id, detached: true });

  // A session the operator closes reports `killed` — and the pty's own exit,
  // which arrives a moment later, must not turn it into a second, announceable
  // event. That is what would notify you about a session you just closed.
  const second = await terminals.mint();
  const secondId = second.ok ? second.sessionId : '';
  terminals.kill(secondId);
  ptys[1].exit(0);
  assert.deepEqual(
    seen.filter((e) => e.id === secondId).map((e) => e.type),
    ['created', 'killed'],
  );

  terminals.close();
});

test('a claude ticket is gated by --allow-agent, and refusals spawn nothing', async (t) => {
  const port = await console_(t, '--allow-agent');
  if (!await waitFor(port)) assert.fail('the console did not come up');

  // The shell flag is still its own decision…
  const shell = await http(port, '/api/terminal', { method: 'POST', headers: CONSOLE_HEADERS, body: '{}' });
  assert.equal(shell.status, 403);
  assert.match(shell.body, /--allow-terminal/);

  // …and both capabilities are reported, each under its own name.
  const state = JSON.parse((await http(port, '/api/state')).body) as Record<string, unknown>;
  assert.equal(state.allowAgent, true);
  assert.equal(state.allowTerminal, false);
  const listed = JSON.parse((await http(port, '/api/terminal')).body) as Record<string, unknown>;
  assert.equal(listed.agentAllowed, true);
  assert.equal(listed.allowed, false);

  // Refusals that must not spawn: an unknown kind, an off-list model, a plan
  // brief with no source directory open.
  const kind = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ kind: 'root-shell' }),
  });
  assert.equal(kind.status, 400);
  const model = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ kind: 'claude', model: 'gpt-4' }),
  });
  assert.equal(model.status, 400);
  assert.match(model.body, /model must be one of/);
  const plan = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ kind: 'claude', intent: 'plan', brief: 'a thing' }),
  });
  assert.equal(plan.status, 409, plan.body);
  assert.match(plan.body, /No source directory/);

  assert.equal(
    (JSON.parse((await http(port, '/api/terminal')).body) as { sessions: unknown[] }).sessions.length,
    0,
    'no refusal left a session behind',
  );
});

test('without --allow-agent a claude ticket is refused by name', async (t) => {
  const port = await console_(t, '--allow-terminal');
  if (!await waitFor(port)) assert.fail('the console did not come up');
  const refused = await http(port, '/api/terminal', {
    method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ kind: 'claude' }),
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /--allow-agent/);
});

test('the flag is reported to the client so the nav can offer what exists', async (t) => {
  const off = await console_(t);
  if (!await waitFor(off)) assert.fail('the console did not come up');
  const offState = JSON.parse((await http(off, '/api/state')).body);
  assert.equal(offState.allowTerminal, false);
  assert.equal(offState.allowAgent, false);

  const on = await console_(t, '--allow-terminal');
  if (!await waitFor(on)) assert.fail('the console did not come up');
  assert.equal(JSON.parse((await http(on, '/api/state')).body).allowTerminal, true);
});

test('--allow-terminal is off unless asked for, and is its own decision', () => {
  assert.equal(parseFlags([]).allowTerminal, false);
  assert.equal(parseFlags(['--allow-run']).allowTerminal, false, 'a run is not a shell');
  assert.equal(parseFlags(['--allow-writes']).allowTerminal, false, 'a write is not a shell');
  assert.equal(parseFlags(['--allow-terminal']).allowTerminal, true);
  assert.equal(parseFlags(['--allow-terminal']).allowRun, false, 'and a shell is not a run');
});

test('--allow-agent is off unless asked for, and is a fourth decision', () => {
  assert.equal(parseFlags([]).allowAgent, false);
  assert.equal(parseFlags(['--allow-terminal']).allowAgent, false, 'a shell is not an agent session');
  assert.equal(parseFlags(['--allow-run']).allowAgent, false, 'the autopilot is not an agent session');
  const agent = parseFlags(['--allow-agent']);
  assert.equal(agent.allowAgent, true);
  assert.equal(agent.allowTerminal, false, 'and an agent session is not a shell');
  assert.equal(agent.allowRun, false, 'nor a run');
  assert.equal(agent.allowWrites, false, 'nor a write');
});
