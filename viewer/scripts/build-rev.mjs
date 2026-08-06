/**
 * The one build-rev computation, shared by the stamp (`stamp-build.mjs`) and
 * the client define (`vite.config.ts` → `__BUILD_REV__`) so the two can never
 * disagree about which commit a build is. That agreement is what makes the
 * Settings "Interface" row honest: the tab's own baked rev against the
 * server's `dist/.build-rev` is only a comparison while both come from here.
 *
 * No repository is not an error: a tarball copy answers `unknown`, and every
 * reader treats that as "cannot tell", never as stale.
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function buildRev(cwd = VIEWER_DIR) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
