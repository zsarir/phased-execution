/**
 * Reads `scripts/verify.env` — the F5-style single source for the
 * verification-command vocabulary (`CWD_SENSITIVE`, `PREFLIGHT_SKIP`), shared
 * with the bash engine exactly the way `sizing.env`/`mcp.env` are: bash
 * sources the file, this module regex-parses the same lines, and a drift test
 * (`test/verify-env.test.ts`) holds the two readers — and the hardcoded
 * fallbacks — to the same sets.
 *
 * The fallback exists for a console driving an OLDER scripts directory that
 * predates the file; it must be kept identical to the file's contents, which
 * is what the drift test pins.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type VerifyEnv = {
  /** Leads whose meaning depends on the working directory. */
  cwdSensitive: ReadonlySet<string>;
  /** Names never worth a resolution warning (builtins, keywords). */
  preflightSkip: ReadonlySet<string>;
};

export const VERIFY_ENV_FALLBACK: VerifyEnv = {
  cwdSensitive: new Set([
    'docker', 'docker-compose', 'pnpm', 'npm', 'yarn', 'task', 'make', 'just',
    'pytest', 'go', 'cargo', 'alembic', 'vitest', 'jest', 'tsc', 'node',
  ]),
  preflightSkip: new Set([
    'cd', 'true', 'false', 'echo', 'printf', 'test', 'pwd', 'env', 'which',
    'bash', 'sh', 'command', 'export', 'set', 'time',
    'if', 'then', 'fi', 'elif', 'else', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  ]),
};

const cache = new Map<string, VerifyEnv>();

/** Parse one `KEY="a b c"` line into a set, or null when the file lacks it. */
function readList(text: string, key: string): Set<string> | null {
  const match = new RegExp(`^${key}="([^"]*)"`, 'm').exec(text);
  return match ? new Set(match[1].split(/\s+/).filter(Boolean)) : null;
}

export function loadVerifyEnv(scriptsDir: string): VerifyEnv {
  const hit = cache.get(scriptsDir);
  if (hit) return hit;
  let env = VERIFY_ENV_FALLBACK;
  try {
    const text = readFileSync(join(scriptsDir, 'verify.env'), 'utf8');
    env = {
      cwdSensitive: readList(text, 'CWD_SENSITIVE') ?? VERIFY_ENV_FALLBACK.cwdSensitive,
      preflightSkip: readList(text, 'PREFLIGHT_SKIP') ?? VERIFY_ENV_FALLBACK.preflightSkip,
    };
  } catch { /* an older scripts dir without the file — the fallback holds */ }
  cache.set(scriptsDir, env);
  return env;
}
