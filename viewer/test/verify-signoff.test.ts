/**
 * "Nothing ran" is a question, not a verdict.
 *
 * A real run stopped on this, twice, and left nothing to press:
 *
 *   phase 10  failed  9 tries  $0.00   session exited with code 1
 *     nothing runnable in this phase's verification (1 fragment left for a human)
 *     1 step(s) a person must check
 *       those commands. — no command in the plan text — verify by hand
 *     [Retry] [Skip]
 *
 * Neither control fitted. Retry re-runs a session that was never at fault and
 * arrives at the same non-result; Skip discards a phase that may well have
 * succeeded. The missing option was the only one that made sense — a person
 * saying "I checked it" — so the runner had no way to be told, and the run sat
 * there with a `running` badge and nothing holding it.
 *
 * These cover the distinction the runner now makes: a command that ran and
 * failed is a failure, and a check nobody could run is a card.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { Approvals } from '../server/runner/approvals.ts';
import type { VerifySummary } from '../server/runner/state.ts';

/**
 * An approvals broker that can be awaited rather than polled for.
 *
 * These tests used to spin on `pending()` for a fixed two seconds, which is not
 * an assertion about anything — it is a guess about how fast this machine is,
 * and it failed the first time the suite got busy enough to make the guess
 * wrong. The broker already announces a new card to a callback, so waiting on
 * that is both exact and immune to load.
 */
function watchedApprovals() {
  let announce: (approval: { id: string }) => void = () => {};
  const first = new Promise<{ id: string }>((resolve) => { announce = resolve; });
  const approvals = new Approvals((approval) => announce(approval));
  return { approvals, first };
}

/**
 * A scripts directory whose `phase-graph.sh` reports one ready phase that is
 * done the moment it is asked a second time, so the loop reaches verification
 * without a model anywhere near it.
 */
function harness(): { root: string; scriptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-signoff-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });

  // The board flips to done only after the phase has actually been handed out,
  // because the runner re-reads it afterwards and refuses to take the session's
  // word for the result. A stub that always says "ready" fails that check —
  // correctly — and would make every test here look like a runner bug.
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
ran="${join(root, '.phase-served')}"
case "$2" in
  --memory-block)
    if [ -f "$ran" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1"; touch "$ran" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });

  return { root, scriptsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A session that always succeeds without spending anything. */
const happySpawn = async () => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId: 'sid', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

function makeRunner(h: ReturnType<typeof harness>, verification: VerifySummary, approvals?: Approvals) {
  return new Runner({
    scriptsDir: h.scriptsDir,
    spawn: happySpawn,
    verify: async () => verification,
    verificationText: () => 'run those commands.',
    approvals,
    origin: 'http://127.0.0.1:4123',
  });
}

const NOTHING_RAN: VerifySummary = {
  ok: false,
  reason: "nothing runnable in this phase's verification (1 fragment left for a human)",
  ran: [],
  notRun: [{ text: 'those commands.', reason: 'no command in the plan text — verify by hand' }],
};

const A_COMMAND_FAILED: VerifySummary = {
  ok: false,
  reason: '1 command failed',
  ran: [{ command: 'npm test', ok: false, code: 1, ms: 10, output: '3 failing' }],
  notRun: [],
};

test('a command that ran and failed still halts the run', async () => {
  const h = harness();
  try {
    const runner = makeRunner(h, A_COMMAND_FAILED, new Approvals());
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(state.status, 'halted', 'a real failure must still stop the run');
    assert.equal(state.phases['1'].status, 'failed');
    assert.match(state.halt?.reason ?? '', /npm test/, 'the halt should name what failed');
  } finally { h.cleanup(); }
});

test('a verification that ran nothing raises a card instead of failing the phase', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const runner = makeRunner(h, NOTHING_RAN, approvals);
    void runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });

    // The loop parks here, waiting on a person, rather than marking it failed.
    await first;
    const pending = approvals.pending();

    assert.equal(pending.length, 1, 'the unrunnable checks should become one card');
    const card = pending[0];
    assert.equal(card.kind, 'verify');
    assert.equal(card.phase, 1);
    assert.match(card.title, /only you can make/);
    assert.ok(
      card.evidence.some((e) => e.body.includes('those commands.')),
      "the card must carry the plan's own words — a bare yes/no is a rubber stamp",
    );
    assert.ok(
      Date.parse(card.expiresAt) - Date.now() > 60 * 60 * 1000,
      'a human check has no hook waiting on it and must not expire in minutes',
    );

    // And the phase says so, rather than reading `failed`.
    assert.equal(runner.current()?.phases['1'].status, 'awaiting-verification');

    approvals.settle(card.id, 'allow', 'a reviewer', 'checked the gate stack in the browser');
    await runner.wait();

    const state = runner.current()!;
    assert.equal(state.phases['1'].status, 'done', 'a confirmed check should let the phase finish');
    assert.equal(state.phases['1'].verification?.ok, true);
    assert.match(state.phases['1'].verification?.reason ?? '', /confirmed by a reviewer/,
      'who confirmed it belongs on the record');
  } finally { h.cleanup(); }
});

test('saying the manual check failed halts, and says who said so', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const runner = makeRunner(h, NOTHING_RAN, approvals);
    void runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });

    await first;
    const pending = approvals.pending();
    assert.equal(pending.length, 1);

    approvals.settle(pending[0].id, 'deny', 'a reviewer', 'the gate box never rendered');
    await runner.wait();

    const state = runner.current()!;
    assert.equal(state.status, 'halted');
    assert.equal(state.phases['1'].status, 'failed');
    assert.match(state.halt?.reason ?? '', /the gate box never rendered/);
  } finally { h.cleanup(); }
});

test('with no way to ask, it halts saying exactly that', async () => {
  const h = harness();
  try {
    // No approvals broker: the honest outcome is to stop and say why, not to
    // wait forever on a question nobody can be shown.
    const runner = makeRunner(h, NOTHING_RAN, undefined);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(state.status, 'halted');
    assert.match(state.halt?.reason ?? '', /no way to ask/);
  } finally { h.cleanup(); }
});
