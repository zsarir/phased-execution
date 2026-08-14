/**
 * The log's own discipline: bounded on disk, whatever the process lifetime.
 *
 * Rotation used to run only at `open()` — once per process — so a long-lived
 * console grew the live file without bound, and the rename at the NEXT boot
 * turned all of it into a `.1` as large as the process was long (522 MB was
 * found in the wild, under an 8 MB cap). The write path now counts bytes and
 * rotates itself, the rename replaces the previous `.1` so the pair stays
 * bounded at ~2 × cap, and an oversized relic from the old bug is removed once
 * at open — with a line saying so, because half a gigabyte should not vanish
 * silently either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before the dynamic import below: MAX_BYTES is read once at module load, and
// a test that rotates megabytes to prove a point is a slow test about nothing.
process.env.PHASE_CONSOLE_LOG_MAX_BYTES = '2048';
// Sandbox BOTH homes before anything under ../server resolves them — the
// belt in shared/instances.mjs throws on a test reaching the real dirs.
const SANDBOX = mkdtempSync(join(tmpdir(), 'pc-logrot-'));
process.env.XDG_STATE_HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = join(SANDBOX, 'config');

const { configureLog, log } = await import('../server/log.ts');

const CAP = 2048;
/** Generous slack: rotation triggers on the write AFTER the cap is crossed. */
const SLACK = 512;

test('the write path rotates at the cap and the pair stays bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-log-'));
  const target = join(dir, 'console.log');
  configureLog(target);

  const filler = 'x'.repeat(120);
  for (let i = 0; i < 80; i += 1) log.info('fill', { filler, i });

  const live = statSync(target).size;
  assert.ok(live <= CAP + SLACK, `live file is ${live} bytes — the write path never let it run away`);
  assert.ok(existsSync(`${target}.1`), 'crossing the cap produced a rotation');
  const relic = statSync(`${target}.1`).size;
  assert.ok(
    relic <= CAP + SLACK,
    `rotated file is ${relic} bytes — rename REPLACES the previous .1, it never accumulates`,
  );
});

test('an oversized `.1` from the pre-cap era is removed once, with a line saying so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-log-relic-'));
  const target = join(dir, 'console.log');
  // More than twice the cap cannot be a product of the current code — rotation
  // replaces `.1` with a live file the write path keeps under the cap.
  writeFileSync(`${target}.1`, 'y'.repeat(3 * CAP));

  configureLog(target);

  assert.ok(!existsSync(`${target}.1`), 'the relic is gone');
  const entries = readFileSync(target, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { event: string; data?: { bytes?: number } });
  const note = entries.find((entry) => entry.event === 'log.relic-removed');
  assert.ok(note, 'the removal wrote itself down');
  assert.equal(note?.data?.bytes, 3 * CAP);
});

test('a normal-sized `.1` is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-log-keep-'));
  const target = join(dir, 'console.log');
  writeFileSync(`${target}.1`, 'z'.repeat(CAP));

  configureLog(target);
  log.info('boot');

  assert.ok(existsSync(`${target}.1`), 'one rotation\'s worth of history is history, not a relic');
  assert.equal(statSync(`${target}.1`).size, CAP);
});
