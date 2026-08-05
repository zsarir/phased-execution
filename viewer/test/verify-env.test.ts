/**
 * Verification must not fail because launchd's environment is thin.
 *
 * The plist bakes the PATH of whatever shell ran the installer. A real run
 * halted on `"python": executable file not found in $PATH` — a red that blamed
 * the phase when only the environment had failed. The fix appends the standard
 * directories (only the ones that exist, only when missing) to the END of the
 * verification PATH: the configured toolchain keeps winning, otherwise-invisible
 * binaries are rescued, and the amendment is logged so the plist defect stays
 * visible. The durable fix remains re-running `deploy/agent.sh install` from a
 * full shell — this is the difference between that being a chore and a 3 a.m.
 * halt.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hardenedPath, verifyPhase } from '../server/runner/verify.ts';

test('hardenedPath appends only missing-and-existing standard dirs, never prepends', () => {
  const thin = hardenedPath('/nonexistent-toolchain/bin');
  assert.ok(
    thin.path.startsWith('/nonexistent-toolchain/bin:'),
    'the configured PATH still decides which toolchain wins',
  );
  assert.ok(thin.added.includes('/bin'), '/bin exists on every machine this runs on');

  const complete = hardenedPath(thin.path);
  assert.equal(complete.path, thin.path, 'a PATH that already sees everything is left byte-identical');
  assert.deepEqual(complete.added, []);
});

test('hardenedPath treats an empty PATH as "append what exists"', () => {
  const bare = hardenedPath(undefined);
  assert.ok(bare.path.split(':').includes('/bin'));
  assert.ok(!bare.path.startsWith(':'), 'no empty leading segment');
});

test('a verification survives a PATH that forgot the standard dirs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pc-verify-env-'));
  const summary = await verifyPhase('- **Verification:** `ls`', {
    cwd,
    env: { PATH: '/nonexistent' } as NodeJS.ProcessEnv,
  });
  assert.equal(summary.ok, true, summary.reason);
  assert.equal(summary.ran.length, 1);
  assert.equal(summary.ran[0].ok, true, summary.ran[0].output);
});
