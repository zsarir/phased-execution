/**
 * Per-agent freeze / continue / stop — the runner's lane verbs at session size.
 *
 * Phase lanes could always be frozen and stopped one at a time; agent sessions
 * (recovery, QA, interactive) had exactly one verb, `kill()`, which is a
 * `pty.kill()` with the record deleted. These tests pin the polite trio:
 *
 *  - **Freeze is SIGSTOP to the process group**, recorded on the session so
 *    the list can say "frozen · 4m" — and injected, because a test must never
 *    signal a real pid.
 *  - **Stop is a ladder**: SIGCONT first (a stopped process cannot act on
 *    anything), SIGTERM, and SIGKILL only after a grace the process ignored.
 *    Unlike `kill()`, the record STAYS and the exit flows through `onExit` —
 *    a recovery session stopped this way still gets its outcome read against
 *    the board instead of vanishing mid-verdict.
 *  - **Refusals are truthful**: no session, already ended; and repeating a
 *    verb that already holds is an ok, not an error.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VIEWER_DIR } from '../server/config.ts';
import { Terminals } from '../server/terminal.ts';

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

function fakePty() {
  const pty = {
    pid: 4242,
    written: [] as string[],
    killed: false,
    emit: (_text: string) => {},
    exit: (_code: number) => {},
    onData(listener: (data: string) => void) { pty.emit = listener; },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      pty.exit = (code: number) => listener({ exitCode: code });
    },
    write(data: string) { pty.written.push(data); },
    resize() {},
    kill() { pty.killed = true; },
  };
  return pty;
}

function registry() {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const signals: Array<[number, string]> = [];
  const events: string[] = [];
  const terminals = new Terminals({
    allowed: true,
    cwd: () => VIEWER_DIR,
    spawn: () => { const pty = fakePty(); ptys.push(pty); return pty as never; },
    signal: (pid, sig) => { signals.push([pid, sig]); },
    onSession: (event) => { events.push(event.type); },
  });
  return { terminals, ptys, signals, events };
}

async function mintOne(terminals: Terminals): Promise<string> {
  const minted = await terminals.mint(undefined, { cols: 80, rows: 24 });
  assert.equal(minted.ok, true, 'the fixture session minted');
  return minted.ok ? minted.sessionId : '';
}

test('freeze is SIGSTOP to the group, recorded and announced', async () => {
  const { terminals, signals, events } = registry();
  const id = await mintOne(terminals);

  const out = terminals.freeze(id, 'the tab strip');
  assert.equal(out.ok, true);
  assert.deepEqual(signals, [[4242, 'SIGSTOP']]);

  const info = terminals.state().sessions.find((s) => s.id === id);
  assert.equal(info?.frozen?.by, 'the tab strip');
  assert.ok(events.includes('changed'), 'the list re-reads itself off a changed event');

  // Freezing what is already frozen holds, and signals nothing twice.
  assert.equal(terminals.freeze(id).ok, true);
  assert.equal(signals.length, 1);
});

test('thaw is SIGCONT and the frozen mark comes off', async () => {
  const { terminals, signals } = registry();
  const id = await mintOne(terminals);
  terminals.freeze(id);

  const out = terminals.thaw(id);
  assert.equal(out.ok, true);
  assert.deepEqual(signals, [[4242, 'SIGSTOP'], [4242, 'SIGCONT']]);
  assert.equal(terminals.state().sessions.find((s) => s.id === id)?.frozen, undefined);

  // Thawing the unfrozen holds too.
  assert.equal(terminals.thaw(id).ok, true);
  assert.equal(signals.length, 2);
});

test('stop is a ladder: SIGCONT first when frozen, SIGTERM, SIGKILL only after the grace', async () => {
  const { terminals, signals, ptys } = registry();
  const id = await mintOne(terminals);
  terminals.freeze(id);

  const out = terminals.stop(id, 'the agent view', 10);
  assert.equal(out.ok, true);
  assert.deepEqual(signals.slice(1), [[4242, 'SIGCONT'], [4242, 'SIGTERM']],
    'a stopped process cannot act on a SIGTERM — continue it first');
  assert.equal(ptys[0].killed, false, 'stop never reaches for pty.kill');

  const info = terminals.state().sessions.find((s) => s.id === id);
  assert.ok(info?.stopping, 'the stop in flight is visible');

  await sleep(40);
  assert.deepEqual(signals.at(-1), [4242, 'SIGKILL'], 'the grace ran out');
});

test('a session that dies inside the grace is never SIGKILLed', async () => {
  const { terminals, signals, ptys, events } = registry();
  const id = await mintOne(terminals);

  terminals.stop(id, 'console', 30);
  ptys[0].exit(0);

  await sleep(60);
  assert.ok(!signals.some(([, sig]) => sig === 'SIGKILL'));
  // The record outlives the process — that is the difference from kill().
  const info = terminals.state().sessions.find((s) => s.id === id);
  assert.ok(info?.exited, 'the exit landed on the kept record');
  assert.ok(events.includes('exited'), 'and flowed through onExit for the outcome checks');
});

test('the refusals are truthful', async () => {
  const { terminals, ptys } = registry();
  const id = await mintOne(terminals);

  assert.match(terminals.freeze('nope').reason ?? '', /no such session/);
  assert.match(terminals.thaw('nope').reason ?? '', /no such session/);
  assert.match(terminals.stop('nope').reason ?? '', /no such session/);

  ptys[0].exit(0);
  assert.match(terminals.freeze(id).reason ?? '', /already ended/);
  assert.match(terminals.stop(id).reason ?? '', /already ended/);
});

test('kill() on a frozen session continues it first — a stopped process cannot die politely', async () => {
  const { terminals, signals, ptys } = registry();
  const id = await mintOne(terminals);
  terminals.freeze(id);

  terminals.kill(id);
  assert.deepEqual(signals, [[4242, 'SIGSTOP'], [4242, 'SIGCONT']]);
  assert.equal(ptys[0].killed, true);
});
