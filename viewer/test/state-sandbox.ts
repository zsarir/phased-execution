/**
 * Redirect this test process's console state somewhere disposable.
 *
 * **Import this first.** `server/config.ts` computes `STATE_DIR` and
 * `CONFIG_DIR` once, at module load, from `XDG_STATE_HOME` / `XDG_CONFIG_HOME`.
 * A module that reads them before this one runs has already resolved the
 * operator's real directories, and nothing later can move it.
 *
 * What is at stake is not tidiness. `~/.local/state/phase-console/` holds
 * `push/subscriptions.json` — the operator's actual subscribed browsers. A test
 * that constructs a real `Service`, or spawns a real console, loads that file
 * and can deliver to those devices for real. It did: a shutdown test's console
 * announced its own shutdown, and the announcement arrived on the operator's
 * phone and laptop as a notification from a console they were not running. The
 * same directory also holds the notification inbox, approvals, and every run
 * journal — a suite pointed at it leaves thousands of fixture runs in the
 * operator's history.
 *
 * Files that already redirect inline (before their own dynamic imports) do not
 * need this; `test/state-isolation.test.ts` checks that every file does one or
 * the other.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-state-'));

process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover tmpdir is not a failure */ }
});

/** The sandbox root, for a test that wants to look at what was written. */
export const STATE_SANDBOX = dir;
