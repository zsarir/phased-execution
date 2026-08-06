/**
 * Carrying a session transcript between accounts' config dirs.
 *
 * What must hold: the source file is found by SESSION ID (never by re-deriving
 * the CLI's cwd escaping), the escaped-cwd directory name crosses verbatim,
 * todos ride along best-effort, the same-dir pair is a no-op, and a missing
 * source answers false so the caller starts fresh instead of resuming into
 * nothing.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findTranscript, portTranscript } from '../server/accounts/transcripts.ts';

const SID = '11111111-2222-3333-4444-555555555555';
const ESCAPED = '-Users-someone-code-my-repo';

function configDir(withSession = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-transcript-'));
  if (withSession) {
    mkdirSync(join(dir, 'projects', ESCAPED), { recursive: true });
    writeFileSync(join(dir, 'projects', ESCAPED, `${SID}.jsonl`), '{"type":"user"}\n');
    mkdirSync(join(dir, 'todos'), { recursive: true });
    writeFileSync(join(dir, 'todos', `${SID}-agent.json`), '[]\n');
  }
  return dir;
}

test('finds a transcript by session id under any escaped-cwd directory', () => {
  const from = configDir(true);
  assert.equal(findTranscript(from, SID), join(from, 'projects', ESCAPED, `${SID}.jsonl`));
  assert.equal(findTranscript(from, '99999999-aaaa-bbbb-cccc-dddddddddddd'), null);
  assert.equal(findTranscript(from, '../../etc/passwd'), null, 'an id is an id, never a path');
  rmSync(from, { recursive: true, force: true });
});

test('ports the transcript and its todos, reusing the escaped dir name verbatim', () => {
  const from = configDir(true);
  const to = configDir(false);
  assert.equal(portTranscript(SID, from, to), true);
  const landed = join(to, 'projects', ESCAPED, `${SID}.jsonl`);
  assert.ok(existsSync(landed), 'the resumed CLI will look in the SAME escaped-cwd dir');
  assert.equal(readFileSync(landed, 'utf8'), '{"type":"user"}\n');
  assert.ok(existsSync(join(to, 'todos', `${SID}-agent.json`)), 'todos are quality-of-life, carried when present');
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

test('the same config dir is a no-op that still answers true', () => {
  const dir = configDir(true);
  assert.equal(portTranscript(SID, dir, dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test('a transcript already at the destination counts as carried', () => {
  const from = configDir(false);   // nothing here — say, an A→B→A round trip
  const to = configDir(true);
  assert.equal(portTranscript(SID, from, to), true);
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

test('a missing source answers false — the caller boots fresh instead', () => {
  const from = configDir(false);
  const to = configDir(false);
  assert.equal(portTranscript(SID, from, to), false);
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});
