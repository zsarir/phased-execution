/**
 * Spawning a real console, without spending the operator's own machine to do it.
 *
 * Four test files boot `server/index.ts` for real, because a console is the only
 * honest way to test static serving, access rules, the terminal socket and
 * shutdown. Each of them used to spawn it bare — inheriting the environment,
 * which means:
 *
 *   - the console read and wrote `~/.config/phase-console/config.json`, the
 *     operator's actual preferences, remembered roots and notification switches;
 *   - with no `--root`, it opened whatever plan library that config remembered —
 *     on a working machine, the operator's real one — and started a file watcher,
 *     a scheduler and a runner against it.
 *
 * A test suite that boots live machinery against real work is one accident away
 * from writing to it, and a stray phase lock in a real handoff folder blocks
 * real sessions on plans that have nothing to do with the test. (One did: a
 * `test…/test` claim, found in a real `.locks/` directory and blamed
 * on "a test run".)
 *
 * So every spawned console gets its own `XDG_CONFIG_HOME` — the whole of what a
 * console persists — and, when it needs a plan library at all, a throwaway one.
 * `--root` stays opt-in on purpose: a console started without it opens nothing,
 * which is the state several of these tests are specifically about, and handing
 * one a library by default would quietly delete that case.
 * `test/state-isolation.test.ts` keeps both rules honest.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ConsoleSandbox = {
  /** `XDG_CONFIG_HOME` — preferences, remembered roots, notification switches. */
  configHome: string;
  /**
   * `XDG_STATE_HOME` — and the one that actually reaches people. The console's
   * state directory holds `push/subscriptions.json`, the operator's real
   * subscribed browsers and phones, so a spawned console that inherits it can
   * and does deliver push notifications to them. A shutdown test's console
   * announcing its own shutdown is not a test artefact once it lands on
   * someone's phone. It also holds the notification inbox, approvals and every
   * run journal.
   */
  stateHome: string;
  /** A throwaway plan library, so the console never opens a real one. */
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
};

/**
 * A temporary home and a one-plan library for a console under test.
 *
 * The plan is minimal but real: a console pointed at an empty directory reports
 * "not a plan library" and half its routes answer 404, which is not the console
 * any of these tests mean to be testing.
 */
export function sandbox(label = 'console'): ConsoleSandbox {
  const dir = mkdtempSync(join(tmpdir(), `phase-console-${label}-`));
  const configHome = join(dir, 'config');
  const stateHome = join(dir, 'state');
  const root = join(dir, 'root');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), DEMO_PLAN);

  return {
    configHome,
    stateHome,
    root,
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Spawn `server/index.ts` inside a sandbox. `args` is whatever the test is
 * actually about; pass `withRoot` when it needs a plan library open, and the
 * sandbox's throwaway one is used — never `--root` by hand.
 */
export function spawnConsole(
  viewerDir: string,
  port: number,
  args: string[] = [],
  opts: {
    env?: NodeJS.ProcessEnv;
    sandbox?: ConsoleSandbox;
    withRoot?: boolean;
    /**
     * `'pipe'` when the test is about what the console SAYS — the port-collision
     * message is the one whose whole content is the behaviour under test, and
     * `'ignore'` would throw it away. Everything else stays silent by default:
     * a suite that prints every console's startup banner is unreadable.
     */
    stdio?: 'ignore' | 'pipe';
  } = {},
): { child: ChildProcess; box: ConsoleSandbox } {
  const box = opts.sandbox ?? sandbox();
  const child = spawn(process.execPath, [
    join(viewerDir, 'server', 'index.ts'),
    '--port', String(port), '--no-open', '--no-log-file',
    ...(opts.withRoot ? ['--root', box.root] : []),
    ...args,
  ], { stdio: opts.stdio ?? 'ignore', env: { ...box.env, ...opts.env } });
  return { child, box };
}

const DEMO_PLAN = `---
slug: demo
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/demo/
memory: project_demo
---

# Demo

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | First | — | — | demo | it works |
| 2 | Second | 1 | — | demo | it still works |

## Phases

### Phase 1 — First

- **Size:** S

### Phase 2 — Second

- **Size:** S
`;
