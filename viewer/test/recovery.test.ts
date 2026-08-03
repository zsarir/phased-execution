/**
 * Getting a stuck phase unstuck, from the console.
 *
 * The console had two verbs for a phase that stopped, and both throw something
 * away: Retry re-runs it from its boot prompt, discarding however long the
 * session had been working; Skip discards the phase. The common case fits
 * neither — a session that did the work and stopped one step short of recording
 * it — so the only honest option left was a terminal.
 *
 * A real run made that concrete. Its session died on a refusal it explained in
 * its final message; the runner halted saying "no handoff was written", and the
 * explanation sat unread in NDJSON. Before that it had asked a person to
 * hand-confirm four checks, waited for the answer, and then discarded it — the
 * board check that would have settled the whole thing instantly ran last.
 *
 * So: the cheap machine checks come first, a session that produced work gets one
 * chance to finish, and a phase that is not done always offers a way forward.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { Approvals } from '../server/runner/approvals.ts';
import { recoveryActions } from '../server/service.ts';
import { phaseActions } from '../web/components/phase-model.js';
import type { SpawnRequest } from '../server/runner/spawn.ts';
import type { VerifySummary } from '../server/runner/state.ts';

/**
 * A board whose phase 1 is done only once a handoff file exists — the same rule
 * `phase-graph.sh` really applies, which is what makes "the board still reads
 * ready" mean "nobody wrote the handoff".
 */
function harness(): { root: string; scriptsDir: string; handoff: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-recovery-'));
  const scriptsDir = join(root, 'scripts');
  const handoff = join(root, 'handoff-1');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });

  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block)
    if [ -f "${handoff}" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });

  return { root, scriptsDir, handoff, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const GREEN: VerifySummary = {
  ok: true, reason: '1 command green', notRun: [],
  ran: [{ command: 'npm test', ok: true, code: 0, ms: 5, output: '' }],
};

/** Nothing runnable — the shape that used to raise a card before the board check. */
const NOTHING_RAN: VerifySummary = {
  ok: false,
  reason: "nothing runnable in this phase's verification (4 fragments left for a human)",
  ran: [],
  notRun: [
    { text: 'cd viewer && node --test', reason: 'not a recognised command (starts with "cd")' },
    { text: '| grep -v x', reason: 'not a recognised command (starts with "|")' },
  ],
};

type SpawnLog = { prompt: string; resume?: string; maxTurns?: number | null }[];

function spawnSpy(log: SpawnLog, onCall?: (n: number) => void) {
  let calls = 0;
  return async (request: SpawnRequest) => {
    log.push({ prompt: request.prompt, resume: request.resume, maxTurns: request.maxTurns });
    onCall?.(++calls);
    return {
      signal: { subtype: 'success' as const, code: 0, text: 'done' },
      sessionId: 'sid-1', costUsd: 0, turns: 1,
      resultText: 'I could not write into that directory: it is a sensitive file.',
      durationMs: 1, argv: [],
    };
  };
}

function makeRunner(
  h: ReturnType<typeof harness>,
  spawn: ReturnType<typeof spawnSpy>,
  verification: VerifySummary = GREEN,
) {
  return new Runner({
    scriptsDir: h.scriptsDir,
    spawn,
    verify: async () => verification,
    verificationText: () => 'run those commands.',
    approvals: new Approvals(),
    origin: 'http://127.0.0.1:4123',
  });
}

/* ------------------------------------------------------------------ *
 * The machine checks come first
 * ------------------------------------------------------------------ */

test('a phase that wrote nothing halts on the board, without asking anyone', async () => {
  const h = harness();
  try {
    const log: SpawnLog = [];
    const runner = makeRunner(h, spawnSpy(log), NOTHING_RAN);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'halt-on-everything' });
    await runner.wait();

    assert.equal(state.status, 'halted');
    assert.match(state.halt?.reason ?? '', /the board still reads/);
    // The whole point: no card was raised. Under the old order this phase asked
    // a person to confirm two fragments, waited, and threw the answer away.
    assert.notEqual(state.phases['1'].status, 'awaiting-verification');
    assert.equal(state.phases['1'].verification, undefined,
      'verification should not even have been attempted on a phase that produced nothing');
  } finally { h.cleanup(); }
});

test('the halt quotes what the session actually said', async () => {
  const h = harness();
  try {
    const runner = makeRunner(h, spawnSpy([]));
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    // Without this the operator reads "no handoff was written" and has to grep
    // NDJSON to find out that the session was blocked from writing at all.
    assert.match(state.halt?.reason ?? '', /sensitive file/);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * One closeout, and only when there is something to close
 * ------------------------------------------------------------------ */

test('a session that changed nothing is not resumed — that would just fail twice', async () => {
  const h = harness();
  try {
    const log: SpawnLog = [];
    const runner = makeRunner(h, spawnSpy(log));
    await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(log.length, 1, 'the phase ran once and was not resumed');
    assert.equal(log.filter((c) => c.resume).length, 0);
  } finally { h.cleanup(); }
});

test('a session that did the work is asked once to finish the closeout', async () => {
  const h = harness();
  try {
    // `producedWork` asks git, so the dirty-tree branch only exists in a real
    // repository. Without this the test passes while proving nothing — git
    // fails, the runner reads "changed nothing", and no closeout is attempted.
    execFileSync('git', ['init', '-q'], { cwd: h.root });
    writeFileSync(join(h.root, 'scratch.txt'), 'work the session did');

    const log: SpawnLog = [];
    // The phase itself writes no handoff; the closeout is what writes it, which
    // is what flips the board.
    const spawn = spawnSpy(log, (n) => { if (n === 2) writeFileSync(h.handoff, 'status: complete'); });
    const runner = makeRunner(h, spawn);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    const resumed = log.filter((c) => c.resume);
    assert.equal(resumed.length, 1, 'exactly one closeout, never a loop');
    assert.equal(resumed[0].resume, 'sid-1', 'it resumes the phase\'s own session');
    assert.match(resumed[0].prompt, /Finish the closeout, and nothing else/);
    assert.match(resumed[0].prompt, /Never write a `complete` handoff on red verification/);
    assert.match(resumed[0].prompt, /Do not start new work/);
    assert.ok((resumed[0].maxTurns ?? 0) > 0, 'a closeout is capped');
    assert.equal(state.phases['1'].closeout?.ok, true);
    assert.equal(state.phases['1'].status, 'done', 'and the phase actually closes');
  } finally { h.cleanup(); }
});

test('the closeout is attempted once, not once per pass', async () => {
  const h = harness();
  try {
    execFileSync('git', ['init', '-q'], { cwd: h.root });
    writeFileSync(join(h.root, 'scratch.txt'), 'work');

    const log: SpawnLog = [];
    // A closeout that does not write the handoff either. The run must halt
    // rather than resume the session again and again.
    const runner = makeRunner(h, spawnSpy(log));
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(log.filter((c) => c.resume).length, 1);
    assert.equal(state.status, 'halted');
    assert.match(state.halt?.reason ?? '', /the board still reads/);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The three verbs
 * ------------------------------------------------------------------ */

test('recheck starts no session at all', async () => {
  const h = harness();
  try {
    const log: SpawnLog = [];
    const runner = makeRunner(h, spawnSpy(log));
    const started = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    const runId = started.id;
    const before = log.length;

    // Someone writes the handoff by hand, then asks the console to look again.
    writeFileSync(h.handoff, 'status: complete');
    const state = await runner.recover({
      slug: 'demo', root: h.root, runId, phase: 1, mode: 'recheck', by: 'operator',
    });
    await runner.wait();

    assert.equal(log.length, before, 'recheck must spawn nothing');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.halt, null, 'the halt is cleared once the phase actually closes');
  } finally { h.cleanup(); }
});

test('resume carries the operator\'s words to the session that stalled', async () => {
  const h = harness();
  try {
    const log: SpawnLog = [];
    const runner = makeRunner(h, spawnSpy(log, (n) => {
      if (n === 2) writeFileSync(h.handoff, 'status: complete');
    }));
    const started = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    await runner.recover({
      slug: 'demo', root: h.root, runId: started.id, phase: 1, mode: 'resume',
      instruction: 'the scrub grep still matches README.fa.md — fix that first',
      by: 'operator',
    });
    await runner.wait();

    const resumed = log.filter((c) => c.resume);
    assert.equal(resumed.length, 1);
    assert.match(resumed[0].prompt, /scrub grep still matches README\.fa\.md/);
    // The instruction leads; the closeout checklist follows it, so a session
    // told to fix something still knows what it is fixing it FOR.
    assert.ok(
      resumed[0].prompt.indexOf('scrub grep') < resumed[0].prompt.indexOf('Finish the closeout'),
      'the operator speaks first',
    );
    assert.equal(resumed[0].resume, 'sid-1');
  } finally { h.cleanup(); }
});

test('recovery refuses a phase no run ever reached', async () => {
  const h = harness();
  try {
    const runner = makeRunner(h, spawnSpy([]));
    const started = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    await assert.rejects(
      () => runner.recover({ slug: 'demo', root: h.root, runId: started.id, phase: 9, mode: 'closeout' }),
      /never reached phase 9/,
    );
  } finally { h.cleanup(); }
});

test('a closeout cannot mark a phase done that the board still disputes', async () => {
  const h = harness();
  try {
    const log: SpawnLog = [];
    // The session says it finished and writes no handoff. Recovery must not
    // take its word for it — this is the whole reason the board is re-read.
    const runner = makeRunner(h, spawnSpy(log));
    const started = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    const state = await runner.recover({
      slug: 'demo', root: h.root, runId: started.id, phase: 1, mode: 'closeout', by: 'operator',
    });
    await runner.wait();

    assert.notEqual(state.phases['1'].status, 'done');
    assert.equal(state.status, 'halted');
    assert.ok(!existsSync(h.handoff), 'the console never writes the handoff itself');
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * No dead ends
 * ------------------------------------------------------------------ */

test('every stopped phase offers at least one way forward', () => {
  // The invariant. A run that halted with its approval card expired offered
  // Retry and Skip and nothing else — one re-runs a session that was probably
  // fine, the other throws the phase away. Neither is "finish it".
  for (const status of ['failed', 'interrupted', 'parked', 'awaiting-verification']) {
    for (const allowRun of [true, false]) {
      const actions = phaseActions({ state: 'ready', record: { status } }, { live: false, allowRun });
      const forward = Object.entries(actions).filter(([, on]) => on).map(([id]) => id);
      assert.ok(forward.length > 0, `phase in ${status} (allowRun=${allowRun}) has no way forward`);
      assert.ok(actions.diagnose, `${status} must be explainable`);
    }
  }
});

test('the API offers a way forward for every unfinished status, resumable or not', () => {
  // Same invariant, server-side — this is the list the page actually renders.
  for (const status of ['failed', 'interrupted', 'parked', 'awaiting-verification', 'pending', 'verifying']) {
    for (const resumable of [true, false]) {
      const actions = recoveryActions(status, resumable);
      assert.ok(actions.length > 0, `${status} (resumable=${resumable}) is a dead end`);
      // Re-check is the one that is always safe: it starts nothing and costs
      // nothing, so it is offered even when no session survives to resume.
      assert.ok(actions.some((a) => a.id === 'recheck'), status);
      assert.equal(
        actions.some((a) => a.id === 'closeout'), resumable,
        'finishing a phase means resuming its session — offer it only when there is one',
      );
      // Every button states what it costs. The old Retry did not, which is how
      // it kept being pressed on sessions that were nearly done.
      for (const action of actions) assert.ok(action.detail.length > 20, `${action.id} has no detail`);
    }
  }
  // Nothing to offer once it is genuinely finished.
  assert.deepEqual(recoveryActions('done', true), []);
  assert.deepEqual(recoveryActions('skipped', true), []);
});

test('retry says out loud that it discards the session', () => {
  // The information that was missing from the button for its whole life.
  const retry = recoveryActions('failed', true).find((a) => a.id === 'retry')!;
  assert.match(retry.detail, /[Dd]iscards/);
});
