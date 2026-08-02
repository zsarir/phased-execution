/**
 * Signing in, and remembering what happened.
 *
 * Both cover failures seen on a real run in the same hour:
 *
 *   - `phase 14 started on sonnet` … `Failed to authenticate: OAuth session
 *     expired and could not be refreshed` … `success · 1 turns · $0.000`. Each
 *     phase discovered the dead token separately, at the cost of a session, and
 *     the advice offered — "run /login in this workspace" — is not something a
 *     browser can do.
 *   - The live console showed nothing at all while a run was in progress,
 *     because the only copy of a session's output lived in whichever tab
 *     happened to be open when the event fired.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAuth, shellQuote, appleScriptString, loginCommand } from '../server/runner/auth.ts';
import { Transcript, readTranscript } from '../server/runner/transcript.ts';

const AT = '2026-08-02T12:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Reading `claude auth status`
 * ------------------------------------------------------------------ */

test('a signed-in answer is read in full', () => {
  // Exactly what the CLI printed when this was built.
  const status = parseAuth(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'you@example.com',
    orgName: "you@example.com's Organization",
    subscriptionType: 'max',
  }), '', AT);

  assert.equal(status.loggedIn, true);
  assert.equal(status.email, 'you@example.com');
  assert.equal(status.subscription, 'max');
  assert.equal(status.detail, undefined, 'a clean answer needs no caveat');
});

test('a signed-out answer is believed', () => {
  const status = parseAuth(JSON.stringify({ loggedIn: false }), '', AT);
  assert.equal(status.loggedIn, false);
});

test('output nobody can parse does not become a second way to fail', () => {
  // If the CLI's format changes, the probe must degrade to "carry on" — a
  // courtesy check that starts blocking runs is worse than no check.
  const status = parseAuth('Logged in as someone <someone@example.com>', '', AT);
  assert.equal(status.loggedIn, true, 'unreadable is not the same as signed out');
  assert.match(status.detail ?? '', /could not read/);
});

test('a plainly negative message is still caught without JSON', () => {
  for (const text of ['Not logged in', 'You are logged out.', 'No credentials found']) {
    assert.equal(parseAuth(text, '', AT).loggedIn, false, `"${text}" means signed out`);
  }
});

/* ------------------------------------------------------------------ *
 * Opening a terminal on the login
 * ------------------------------------------------------------------ */

test('a path with a quote in it cannot break out of the command', () => {
  // The directory name is attacker-adjacent input in exactly one sense: it is
  // not ours, and it ends up inside two nested string languages.
  const nasty = `/tmp/it's a "dir"; rm -rf /`;
  const quoted = shellQuote(nasty);
  assert.equal(quoted.startsWith("'") && quoted.endsWith("'"), true);
  assert.ok(!/(^|[^\\'])';/.test(quoted.slice(1, -1)), 'the quote must be neutralised, not passed through');

  const applescript = appleScriptString(loginCommand(nasty));
  assert.equal(applescript.startsWith('"') && applescript.endsWith('"'), true);
  // Every interior double quote is escaped, so the AppleScript string cannot end early.
  assert.equal(/(?<!\\)"/.test(applescript.slice(1, -1)), false);
});

test('the command it offers is the one a person can also type', () => {
  assert.match(loginCommand('/home/x/code/example'), /^cd '\/home\/x\/code\/example' && claude auth login$/);
});

/* ------------------------------------------------------------------ *
 * The transcript
 * ------------------------------------------------------------------ */

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-transcript-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('what the session printed survives the process that printed it', () => {
  const dir = scratch();
  try {
    const first = new Transcript(dir.root, 'demo', 'abc12345');
    first.append('phase', { phase: 1, status: 'running', model: 'opus' });
    first.append('stream', { kind: 'tool', name: 'Bash', summary: 'npm test' });
    first.append('verify', { phase: 1, command: 'npm test', index: 0, total: 1 });

    // A different Transcript object, as a restarted console would build.
    const replayed = new Transcript(dir.root, 'demo', 'abc12345').read();
    assert.equal(replayed.length, 3);
    assert.deepEqual(replayed.map((e) => e.event), ['phase', 'stream', 'verify']);
    assert.equal(replayed[1].data.name, 'Bash');
    assert.deepEqual(replayed.map((e) => e.seq), [1, 2, 3], 'sequence must be continuous across restarts');
  } finally { dir.cleanup(); }
});

test('a reopened transcript continues the numbering rather than restarting it', () => {
  const dir = scratch();
  try {
    new Transcript(dir.root, 'demo', 'abc12345').append('phase', { phase: 1, status: 'running' });
    const second = new Transcript(dir.root, 'demo', 'abc12345');
    second.append('phase', { phase: 2, status: 'running' });
    assert.deepEqual(second.read().map((e) => e.seq), [1, 2]);
  } finally { dir.cleanup(); }
});

test('state the UI refetches anyway is not duplicated into the transcript', () => {
  const dir = scratch();
  try {
    const t = new Transcript(dir.root, 'demo', 'abc12345');
    assert.equal(t.append('journal', { event: 'phase.start' }), false);
    assert.equal(t.append('run', { state: {} }), false);
    assert.equal(t.append('stream', { kind: 'text', text: 'hello' }), true);
    assert.equal(t.read().length, 1);
  } finally { dir.cleanup(); }
});

test('one runaway line cannot turn a console into a log file', () => {
  const dir = scratch();
  try {
    const t = new Transcript(dir.root, 'demo', 'abc12345');
    t.append('stream', { kind: 'text', text: 'x'.repeat(50_000) });
    const [entry] = t.read();
    assert.ok(String(entry.data.text).length < 5_000, 'a pasted file is not a console line');
    assert.match(String(entry.data.text), /more characters\)$/, 'and it should say what was cut');
  } finally { dir.cleanup(); }
});

test('no transcript is an empty replay, not an error', () => {
  assert.deepEqual(readTranscript('/nonexistent/nothing.jsonl'), []);
});
