/**
 * Recovery write-back — the run record moves when the board says fixed.
 *
 * The "Fix with AI" session is a pty outside the run state machine, and for a
 * while its success was computed and then thrown away into a notification: the
 * phase stayed `failed`, the run stayed `halted`, and the button that had just
 * worked was offered again. These tests pin the correction:
 *
 *  1. **A fixed outcome is a state transition, not a headline.** The phase
 *     record flips to `done`, the halt clears, the streak resets, and the run
 *     lands on `parked` with the same wording `Runner.recover`'s own success
 *     writes — one vocabulary for both recovery paths.
 *  2. **The write goes where the readers read.** `runFor` prefers a pooled
 *     runner's in-memory state over disk, so a sync against a run whose Runner
 *     object is still in the pool must move THAT object — a disk-only edit
 *     would be shadowed forever. And a BUSY runner is never written under.
 *  3. **A fixed run continues by itself.** The same resume `retryPhase` and the
 *     limit clock use, gated on the automation pref and the console's flags.
 *
 * Nothing here spawns `claude`; the recovery outcome is stubbed where needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirected before the imports below — every state-dir consumer reads these at
// module load, and an un-redirected run writes into the operator's real state.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-writeback-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api endpoint
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

/** See recovery-sessions.test.ts: close every Service before deleting its root. */
const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-writeback-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string, flags: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: SCRIPTS, logFile: null, ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

/** A run that halted on phase 2's verification, exactly as the runner writes one. */
function haltedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.activePhase = 2;
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed — npm test',
    phase: 2,
  };
  state.finishedReason = state.halt.reason;
  state.consecutiveFailures = 2;
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  record.note = 'phase 2 did not verify';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

/** A run that parked at the verification preflight, exactly as the drive loop writes one. */
function verificationParkedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 is parked (the plan states no verification '
      + 'for phase 1 — nothing would prove the work. Add a §Verification command to the plan, then '
      + 'Retry.). an unrunnable §Verification takes a plan edit or Repair with AI, then Retry.',
    phase: 1,
    kind: 'verification-preflight',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.note = 'the plan states no verification for phase 1 — nothing would prove the work. '
    + 'Add a §Verification command to the plan, then Retry.';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

function drives(
  svc: ReturnType<typeof service>, slug: string, runId: string,
  queued: { phase: number; outcome: string; by: string }[] = [],
): void {
  (svc as never as { runners: Map<string, unknown> }).runners.set(slug, {
    busy: () => true,
    current: () => ({ slug, status: 'running', id: runId }),
    note: () => {},
    park: () => {},
    enqueueResolution: (resolution: { phase: number; outcome: string; by: string }) => {
      queued.push(resolution);
    },
  });
}

const SESSION = {
  id: 'sess-1', label: 'Recover alpha P2', kind: 'claude', cwd: '/tmp', shell: '/bin/sh',
  cols: 80, rows: 24, pid: 4242, clients: 0, createdAt: Date.now(),
} as never;

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The transition itself
 * ------------------------------------------------------------------ */

test('a fixed outcome moves the record: phase done, halt cleared, streak reset, parked', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: true, headline: 'alpha P2 is done', detail: 'The board now reads done' },
    );

    assert.ok(synced, 'the sync found its run');
    assert.equal(synced.status, 'parked', 'same landing state as Runner.recover');
    assert.equal(synced.halt, null);
    assert.equal(synced.phases['2'].status, 'done');
    assert.ok(synced.phases['2'].endedAt, 'a finished phase has an end');
    assert.equal(synced.consecutiveFailures, 0);
    assert.equal(synced.resolved, null);
    assert.match(synced.finishedReason ?? '', /phase 2 was closed by/);
    assert.match(synced.finishedReason ?? '', /Continue to carry on/);

    // And the disk agrees — the next read must not resurrect the halt.
    const disk = loadRun(root, 'alpha', run.id, null);
    assert.equal(disk?.status, 'parked');
    assert.equal(disk?.halt, null);
    assert.equal(disk?.phases['2'].status, 'done');
  } finally { cleanup(); }
});

test('a not-fixed outcome leaves the halt standing and records the attempt', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: false, headline: 'alpha P2 is still ready', detail: 'the board did not move' },
    );

    assert.ok(synced);
    assert.equal(synced.status, 'halted', 'nothing pretends a failed recovery worked');
    assert.ok(synced.halt, 'the halt still says why');
    assert.equal(synced.phases['2'].status, 'failed');
    // The attempt is bookkeeping the auto-recovery budget reads later.
    assert.equal(synced.recoveries?.['2']?.lastReason, run.halt?.reason);
    assert.ok(synced.recoveries?.['2']?.lastAt);
    assert.notEqual(synced.recoveries?.['2']?.fixed, true);
  } finally { cleanup(); }
});

test('a second halted phase is not touched by another phase’s recovery', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root, {});
    // Phase 1 failed earlier in the same run.
    const withTwo = loadRun(root, 'alpha', run.id, null)!;
    phaseRecord(withTwo, 1).status = 'failed';
    saveRun(withTwo);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: true, headline: '', detail: '' },
    );

    assert.equal(synced?.phases['2'].status, 'done');
    assert.equal(synced?.phases['1'].status, 'failed', 'phase 1 keeps its own record');
  } finally { cleanup(); }
});

test('an interrupted run is resolvable the same way', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root, { status: 'interrupted', halt: null });

    const synced = svc.syncRecoveredRun(
      { kind: 'interrupted-resume', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: true, headline: '', detail: '' },
    );

    assert.equal(synced?.status, 'parked');
    assert.equal(synced?.phases['2'].status, 'done');
  } finally { cleanup(); }
});

test('a run that is not stopped is refused — a live status is never rewritten', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root, { status: 'finished', halt: null });

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: true, headline: '', detail: '' },
    );

    assert.equal(synced, null);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.phases['2'].status, 'failed');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Where the write lands: pool first, disk second, busy never
 * ------------------------------------------------------------------ */

test('a busy runner is handed the write instead of being skipped', () => {
  // Returning null under a live loop is how records stayed `failed` forever:
  // auto-continue restarts the run inside the same exit handler, so the
  // write-back raced its own resume STRUCTURALLY. The loop now takes the
  // verdict as a queued resolution and applies it under its own ownership;
  // the disk is still never written from here.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);
    const queued: { phase: number; outcome: string; by: string }[] = [];
    drives(svc, 'alpha', run.id, queued);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: true, headline: '', detail: '' },
    );

    assert.ok(synced, 'the loop-owned state is what the caller is handed back');
    assert.deepEqual(queued.map((q) => ({ phase: q.phase, outcome: q.outcome })),
      [{ phase: 2, outcome: 'done' }]);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.status, 'halted',
      'the disk is still never written from under a live loop');
  } finally { cleanup(); }
});

test('a true miss under a live loop queues nothing — the halt stands', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);
    const queued: { phase: number; outcome: string; by: string }[] = [];
    drives(svc, 'alpha', run.id, queued);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: false, headline: '', detail: '' },
    );

    assert.equal(synced, null, 'a failed recovery clears nothing, wherever the state lives');
    assert.deepEqual(queued, []);
  } finally { cleanup(); }
});

test('a no-defect verdict under a live loop is queued as such', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);
    const queued: { phase: number; outcome: string; by: string }[] = [];
    drives(svc, 'alpha', run.id, queued);

    svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: false, noDefect: true, headline: '', detail: 'verification passes' },
    );

    assert.deepEqual(queued.map((q) => ({ phase: q.phase, outcome: q.outcome })),
      [{ phase: 2, outcome: 'no-defect' }]);
  } finally { cleanup(); }
});

test('a no-defect verdict on a stopped run clears the halt without inventing done', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id },
      { fixed: false, noDefect: true, headline: 'nothing to fix', detail: 'verification passes' },
    );

    assert.ok(synced);
    assert.equal(synced.halt, null, 'the halt is stood down');
    assert.ok(synced.resolved, 'the stop is resolved, with the reason recorded');
    assert.match(synced.resolved?.reason ?? '', /found nothing wrong/);
    assert.notEqual(synced.phases['2']?.status, 'done',
      'no phase is invented done when the board does not show it');
    assert.equal(synced.recoveries?.['2']?.lastOutcome, 'no-defect');
  } finally { cleanup(); }
});

test('an idle pooled runner’s in-memory state is the object that moves', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const held = haltedRun(root);
    // The pool still holds the Runner whose loop halted; runFor() prefers its
    // current() over disk, so THIS object must be the one the sync rewrites.
    (svc as never as { runners: Map<string, unknown> }).runners.set('alpha', {
      busy: () => false,
      current: () => held,
      note: () => {},
      park: () => {},
    });

    const synced = svc.syncRecoveredRun(
      { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: held.id },
      { fixed: true, headline: '', detail: '' },
    );

    assert.equal(synced, held, 'the pooled object itself was synced, not a disk copy');
    assert.equal(held.status, 'parked');
    assert.equal(held.halt, null);
    assert.equal(loadRun(root, 'alpha', held.id, null)?.status, 'parked', 'and it was persisted');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Plan repair
 * ------------------------------------------------------------------ */

test('a fixed plan repair clears a lint halt — and only a lint halt', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const lintHalted = haltedRun(root, {
      activePhase: null,
      halt: {
        at: new Date().toISOString(),
        reason: 'phase 2 left the plan failing validate.sh: LINT FAIL',
        kind: 'plan-lint',
      } as never,
    });

    const synced = svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', runId: lintHalted.id },
      { fixed: true, headline: 'alpha validates', detail: 'validate.sh exits 0' },
    );
    assert.equal(synced?.status, 'parked');
    assert.equal(synced?.halt, null);
    assert.match(synced?.finishedReason ?? '', /Continue/);

    // A halt about something else entirely is not a repair's to clear.
    const otherHalted = haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'claude is signed out — sign in and continue',
        kind: 'needs-human',
      } as never,
    });
    const refused = svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', runId: otherHalted.id },
      { fixed: true, headline: '', detail: '' },
    );
    assert.equal(refused, null);
    assert.equal(loadRun(root, 'alpha', otherHalted.id, null)?.status, 'halted');
  } finally { cleanup(); }
});

test('an old record without a halt kind is read by its words', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const legacy = haltedRun(root, {
      activePhase: null,
      halt: {
        at: new Date().toISOString(),
        reason: 'phase 2 left the plan failing validate.sh: LINT FAIL',
      },
    });

    const synced = svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', runId: legacy.id },
      { fixed: true, headline: '', detail: '' },
    );
    assert.equal(synced?.status, 'parked', 'the regex fallback covers records written before kinds');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Auto-continue
 * ------------------------------------------------------------------ */

type Announcer = {
  announceRecoveryOutcome: (session: unknown, link: unknown, failed: boolean) => Promise<void>;
};

function fixedOutcome(svc: ReturnType<typeof service>): void {
  svc.recoveryOutcome = (async () => ({
    fixed: true, headline: 'alpha P2 is done', detail: 'The board now reads done',
  })) as typeof svc.recoveryOutcome;
}

function spyStartRun(svc: ReturnType<typeof service>): Array<[string, Record<string, unknown>]> {
  const calls: Array<[string, Record<string, unknown>]> = [];
  svc.startRun = (async (slug: string, opts: Record<string, unknown> = {}) => {
    calls.push([slug, opts]);
    return {} as never;
  }) as typeof svc.startRun;
  return calls;
}

test('a fixed recovery resumes the run: same passthrough as retryPhase', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root, { onlyPhases: [2, 3], skills: ['qa'] });
    fixedOutcome(svc);
    const calls = spyStartRun(svc);

    await (svc as never as Announcer).announceRecoveryOutcome(
      SESSION, { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id }, false);

    assert.equal(calls.length, 1, 'the run was continued');
    assert.equal(calls[0][0], 'alpha');
    assert.equal(calls[0][1].resumeRunId, run.id);
    assert.deepEqual(calls[0][1].onlyPhases, [2, 3], 'a scoped run stays scoped');
    assert.deepEqual(calls[0][1].skills, ['qa'], 'sticky skills survive the resume');
  } finally { cleanup(); }
});

test('the automation pref turns auto-continue off — the sync still happens', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);
    (svc as never as { prefs: Record<string, unknown> }).prefs.autoContinueRecovery = false;
    fixedOutcome(svc);
    const calls = spyStartRun(svc);

    await (svc as never as Announcer).announceRecoveryOutcome(
      SESSION, { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id }, false);

    assert.equal(calls.length, 0, 'nothing was started');
    assert.equal(loadRun(root, 'alpha', run.id, null)?.status, 'parked', 'but the record still moved');
  } finally { cleanup(); }
});

test('without --allow-run the fix is recorded and nothing is spawned', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root, { allowRun: false });
    const run = haltedRun(root);
    fixedOutcome(svc);
    const calls = spyStartRun(svc);

    await (svc as never as Announcer).announceRecoveryOutcome(
      SESSION, { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id }, false);

    assert.equal(calls.length, 0);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.status, 'parked');
  } finally { cleanup(); }
});

test('a not-fixed outcome never auto-continues', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = haltedRun(root);
    svc.recoveryOutcome = (async () => ({
      fixed: false, headline: 'alpha P2 is still ready', detail: 'inspect it',
    })) as typeof svc.recoveryOutcome;
    const calls = spyStartRun(svc);

    await (svc as never as Announcer).announceRecoveryOutcome(
      SESSION, { kind: 'halted-verification', slug: 'alpha', phase: 2, runId: run.id }, false);

    assert.equal(calls.length, 0);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.status, 'halted');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The verification-preflight park: repaired phases go back to PENDING
 * ------------------------------------------------------------------ */

test('a repaired verification park resets its phases to pending — never to done', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = verificationParkedRun(root);

    const synced = svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', phase: 1, runId: run.id },
      { fixed: true, headline: 'alpha verifies', detail: 'every open phase extracts a command' },
    );

    assert.ok(synced, 'the sync found its run');
    // The generic phase branch writes `done` on a fixed outcome; this park's
    // phase never ran a minute, so `done` would be a lie the board repeats.
    assert.equal(synced.phases['1'].status, 'pending');
    assert.equal(synced.phases['1'].note, undefined);
    assert.equal(synced.halt, null);
    assert.equal(synced.status, 'parked', 'parked is what auto-continue resumes');
    assert.match(synced.finishedReason ?? '', /runnable again/);
    assert.equal(synced.recoveries?.['1']?.fixed, true);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.phases['1'].status, 'pending');
  } finally { cleanup(); }
});

test('a missed verification repair records the reason and leaves the park standing', () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = verificationParkedRun(root);

    const synced = svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', phase: 1, runId: run.id },
      { fixed: false, headline: 'still unrunnable', detail: 'phase 1 has no §Verification' },
    );

    assert.ok(synced);
    assert.equal(synced.phases['1'].status, 'parked', 'a miss moves nothing');
    assert.ok(synced.halt, 'the halt keeps standing with its words');
    // The miss is what the identical-failure refusal reads on the next pass —
    // recorded under the SAME slot the launcher bumps, or the budget forks.
    assert.equal(synced.recoveries?.['1']?.lastReason, synced.halt?.reason);
    assert.equal(synced.recoveries?.['1']?.fixed, undefined);
  } finally { cleanup(); }
});
