/**
 * Auto-recovery — the console launches the fix agent itself, bounded.
 *
 * One click on autopilot should carry a plan to the end. The halts that used
 * to stop it dead fall into two piles: the ones only a person can clear (auth,
 * budget, a denied tool), and the ones the recovery agent clears every time a
 * person pressed the button for it (a red verification, a missing handoff, a
 * crashed phase). This is the console pressing that button by itself — with
 * every guard a person would have applied:
 *
 *  - only halts whose **named kind** is auto-recoverable (old records fall
 *    back to the unmistakable sentences, never the generic ones);
 *  - only within budget: per-phase attempts, a per-run cap, and never twice
 *    against the *identical* failure;
 *  - only when the console may spawn agents at all (`--allow-agent`, node-pty);
 *  - bumped **at launch** and persisted, so a console that dies mid-recovery
 *    relaunches at most what the budget still allows.
 *
 * Nothing here spawns `claude`; the mint is stubbed and everything up to it is
 * real — the guards, the briefing resolution, the bookkeeping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-autorecover-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service, autoRecoveryClass } = await import('../server/service.ts');
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

const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-autorecover-'));
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
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null, ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

/** Stub the pty layer: everything up to the mint is real, the mint records. */
function stubMint(svc: ReturnType<typeof service>, availability = 'yes'): Array<Record<string, unknown>> {
  const minted: Array<Record<string, unknown>> = [];
  const t = svc.terminals as never as Record<string, unknown>;
  t.availability = () => availability;
  t.mint = async (_sid: unknown, _size: unknown, launch: Record<string, unknown>) => {
    minted.push(launch);
    return { ok: true, sessionId: 'sess-auto', token: 'tok' };
  };
  return minted;
}

function haltedRun(root: string, over: Partial<RunState> = {}): RunState {
  // Phase 1 finished, so the board reads phase 2 — the phase every run below
  // halts on — as `ready`. A run cannot reach phase 2 with phase 1 unfinished:
  // 2 depends on 1. Leaving it out described an impossible run, which stopped
  // mattering only because nothing consulted the board; the healer's candidate
  // list does now, and it correctly refuses to work a phase still `waiting`.
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'halted';
  state.activePhase = 2;
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed — npm test',
    phase: 2,
    kind: 'verify-failed',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

test('named kinds decide; everything human-shaped answers null', () => {
  const halt = (kind?: string, reason = 'phase 2 stopped') =>
    ({ reason, ...(kind ? { kind } : {}) });

  assert.equal(autoRecoveryClass(halt('verify-failed'), 'halted'), 'halted-verification');
  assert.equal(autoRecoveryClass(halt('plan-lint'), 'halted'), 'halted-verification');
  assert.equal(autoRecoveryClass(halt('no-handoff'), 'halted'), 'halted-missing-handoff');
  assert.equal(autoRecoveryClass(halt('phase-crashed'), 'halted'), 'interrupted-resume');
  for (const kind of ['needs-human', 'budget', 'models-exhausted', 'failure-streak', 'plan-unreadable']) {
    assert.equal(autoRecoveryClass(halt(kind), 'halted'), null, kind);
  }
  // An interrupted run is the crash this console is booting back from.
  assert.equal(autoRecoveryClass(null, 'interrupted'), 'interrupted-resume');
  // A halted run with no halt record says nothing to act on.
  assert.equal(autoRecoveryClass(null, 'halted'), null);
  assert.equal(autoRecoveryClass(null, 'running'), null);
  assert.equal(autoRecoveryClass(null, 'parked'), null);
});

test('records written before kinds are read by their unmistakable sentences only', () => {
  const halt = (reason: string) => ({ reason });
  assert.equal(
    autoRecoveryClass(halt('phase 3 did not verify: 1 of 2 command(s) failed — npm test'), 'halted'),
    'halted-verification');
  assert.equal(
    autoRecoveryClass(halt('phase 3 left the plan failing validate.sh: LINT FAIL'), 'halted'),
    'halted-verification');
  assert.equal(
    autoRecoveryClass(halt('the session for phase 6 ended cleanly but the board still reads "ready" — no handoff was written'), 'halted'),
    'halted-missing-handoff');
  // The client may OFFER a button for these; this must not press it.
  assert.equal(autoRecoveryClass(halt('the run budget of $5 is spent'), 'halted'), null);
  assert.equal(autoRecoveryClass(halt('claude is signed out'), 'halted'), null);
  assert.equal(autoRecoveryClass(halt('the runner itself failed: boom'), 'halted'), null);
});

/* ------------------------------------------------------------------ *
 * The guards, in the order a launch has to pass them
 * ------------------------------------------------------------------ */

test('a phase the board is still WAITING on is not a recovery candidate', async () => {
  // Measured on a real run: the healer boarded a phase 10 whose 7, 8 and 9 were
  // sitting ready and untouched, halting every time with "the session for phase
  // 10 ended cleanly but the board still reads waiting" — the runner correctly
  // describing work it should never have started — until the run's entire
  // recovery budget (5 launches) was spent on a phase that could not run.
  //
  // A waiting phase has unmet dependencies by definition: nothing has started,
  // nothing can start, and no rung has a session worth launching for it.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    try {
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      // Records for all three, so record-existence is not what excludes them.
      for (const phase of [1, 2, 3]) phaseRecord(state, phase).status = 'failed';
      saveRun(state);

      const board = (await svc.board('alpha')).states;
      assert.equal(board[1], 'ready', 'phase 1 leads the plan');
      assert.equal(board[2], 'waiting', 'phase 2 depends on 1');
      assert.equal(board[3], 'waiting', 'phase 3 depends on 2');

      const open = await svc.classifyOpenPhases('alpha', state, board);
      const phases = open.map((entry) => entry.phase).sort((a, b) => a - b);
      assert.deepEqual(phases, [1], `only the ready phase is a candidate, got ${phases.join(',')}`);

      // …unless this run is actually driving it: out-of-order work is real work.
      state.children = {
        c1: { pid: 1, phase: 3, sessionId: 's', startedAt: new Date().toISOString() },
      } as never;
      const driving = await svc.classifyOpenPhases('alpha', state, board);
      assert.ok(
        driving.some((entry) => entry.phase === 3),
        'a waiting phase with a live lane stays diagnosable',
      );
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a healable halt launches the recovery agent, and the attempt is persisted at launch', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = haltedRun(root);

    const out = await svc.maybeAutoRecover('alpha');

    assert.equal(out.launched, true, out.reason);
    assert.equal(minted.length, 1);
    const meta = (minted[0] as { meta?: { intent?: string; recovery?: Record<string, unknown> } }).meta;
    assert.equal(meta?.intent, 'recovery');
    assert.equal(meta?.recovery?.kind, 'halted-verification');
    assert.equal(meta?.recovery?.slug, 'alpha');
    assert.equal(meta?.recovery?.phase, 2);
    // Bumped BEFORE the session runs, so a console death cannot forget it.
    const disk = loadRun(root, 'alpha', run.id, null);
    assert.equal(disk?.recoveries?.['2']?.attempts, 1);
  } finally { cleanup(); }
});

test('a run that opted out is left alone', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = haltedRun(root);
    const onDisk = loadRun(root, 'alpha', run.id, null)!;
    delete onDisk.autoRecover;
    saveRun(onDisk);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('the per-phase budget is a hard stop', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    haltedRun(root, {
      recoveries: { 2: { attempts: 2, lastAt: new Date().toISOString() } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /budget/i);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('the per-run cap counts every phase’s launches together', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    // Stated rather than assumed: the ceiling is `ladderPerRunRungs`, which an
    // operator sets. This used to lean on a hardcoded 5 in `maybeAutoRecover`
    // that silently overrode that preference — so the test read as though it
    // pinned the SUMMING (which is its point) while actually pinning the
    // constant.
    svc.prefs.ladderPerRunRungs = 5;
    const minted = stubMint(svc);
    haltedRun(root, {
      recoveries: {
        1: { attempts: 3, lastAt: new Date().toISOString() },
        3: { attempts: 2, lastAt: new Date().toISOString() },
      },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /run.*budget|budget.*run/i);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a legacy attempt on the identical failure counts as the rung the old healer drove — the ladder escalates from it, never repeats it', async () => {
  // Before rungs were recorded, `recoveries[phase]` held only `attempts` and
  // `lastReason`, and the identical reason twice was REFUSED outright — a
  // dead end, not an escalation (the measured "same failure twice — a person
  // should look" on phases a stronger try would have fixed). A legacy slot is
  // now read as having climbed the vehicle the old healer used: the agent,
  // for a phase with no session. verify-red's ladder is [own session, fix
  // agent]; with no session the own-session rung is undrivable and the agent
  // rung reads as tried — so the ladder is exhausted, an Errand is written,
  // and the reason says which rungs were spent, not merely "same failure".
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const reason = 'phase 2 did not verify: 1 of 2 command(s) failed — npm test';
    const run = haltedRun(root, {
      recoveries: { 2: { attempts: 1, lastAt: new Date().toISOString(), lastReason: reason } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(out.situation, 'verify-red');
    assert.match(out.reason ?? '', /every rung for verify-red has been tried/);
    assert.equal(minted.length, 0);
    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries?.['2']?.errand?.situation, 'verify-red', 'exhaustion writes the errand');
    assert.ok((disk.recoveries?.['2']?.errand?.need ?? '').length > 10);
  } finally { cleanup(); }
});

test('the same failure with a session left is escalated, not refused: own session first, then a stronger agent', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const reason = 'phase 2 did not verify: 1 of 2 command(s) failed — npm test';
    const run = haltedRun(root, {
      recoveries: { 2: { attempts: 1, lastAt: new Date().toISOString(), lastReason: reason } },
      phases: { 2: { phase: 2, status: 'failed', attempts: 1, costUsd: 0, sessionId: 'sess-0002' } },
    });
    const resumed: Array<{ phase: number; mode: string }> = [];
    (svc as never as { recoverPhase: (slug: string, phase: number, mode: string) => Promise<null> })
      .recoverPhase = async (_slug: string, phase: number, mode: string) => { resumed.push({ phase, mode }); return null; };

    // The legacy attempt reads as the own-session rung; the next rung is the
    // stronger fresh agent — the escalation the old refusal never offered.
    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'fix-agent');
    assert.equal(out.vehicle, 'agent');
    assert.equal(minted.length, 1);
    assert.deepEqual(resumed, [], 'the own session was the legacy attempt — not repeated');
    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries?.['2']?.rungs?.[0]?.rung, 'fix-agent');
    assert.equal(disk.recoveries?.['2']?.attempts, 2);
  } finally { cleanup(); }
});

test('without --allow-agent the refusal names the flag', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    haltedRun(root);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /--allow-agent/);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a human-shaped halt is never healed however the run is configured', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'authentication failed — sign in and continue',
        phase: 2,
        kind: 'needs-human',
      },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a recovery already running for the target is not doubled', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    haltedRun(root);
    (svc.terminals as never as Record<string, unknown>).state = () => ({
      sessions: [{
        id: 'sess-live', label: 'Recover alpha P2', kind: 'claude',
        meta: { intent: 'recovery', recovery: { kind: 'halted-verification', slug: 'alpha', phase: 2 } },
      }],
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /already running/i);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Boot: a console that died mid-halt re-arms the same loop
 * ------------------------------------------------------------------ */

test('readoptQueued schedules auto-recovery for a halted run with the option on', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    haltedRun(root);
    const scheduled: string[] = [];
    (svc as never as { scheduleAutoRecover: (slug: string) => void }).scheduleAutoRecover =
      (slug: string) => { scheduled.push(slug); };

    await (svc as never as { readoptQueued: () => Promise<void> }).readoptQueued();
    assert.deepEqual(scheduled, ['alpha']);
  } finally { cleanup(); }
});

test('readoptQueued leaves an opted-out halted run for a person', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    const run = haltedRun(root);
    const onDisk = loadRun(root, 'alpha', run.id, null)!;
    delete onDisk.autoRecover;
    saveRun(onDisk);
    const scheduled: string[] = [];
    (svc as never as { scheduleAutoRecover: (slug: string) => void }).scheduleAutoRecover =
      (slug: string) => { scheduled.push(slug); };

    await (svc as never as { readoptQueued: () => Promise<void> }).readoptQueued();
    assert.deepEqual(scheduled, []);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The verification-preflight park: the one parked shape an agent heals
 * ------------------------------------------------------------------ */

test('a verification-preflight park classifies as plan-repair — and only exactly that shape', () => {
  const halt = { reason: 'nothing left to run on its own — phase 1 is parked (…§Verification…)', kind: 'verification-preflight' };
  assert.equal(autoRecoveryClass(halt, 'parked'), 'plan-repair');
  // The kind travels with `parked` only: the drive loop never writes it on a
  // halted run, so meeting one there means something else is going on.
  assert.equal(autoRecoveryClass(halt, 'halted'), null);
  // A kindless park (a lock, a live-orphan adoption) stays a person's.
  assert.equal(autoRecoveryClass({ reason: 'phase 1 is locked by someone-else' }, 'parked'), null);
});

/** A run parked at the verification preflight, as the drive loop writes one. */
function verificationParkedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
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

test('a verification-preflight park launches the plan-repair agent by itself', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = verificationParkedRun(root);

    const out = await svc.maybeAutoRecover('alpha');

    assert.equal(out.launched, true, out.reason);
    assert.equal(minted.length, 1);
    const meta = (minted[0] as { meta?: { recovery?: Record<string, unknown> } }).meta;
    assert.equal(meta?.recovery?.kind, 'plan-repair');
    assert.equal(meta?.recovery?.slug, 'alpha');
    // Anchored on the halt's own phase — without it the launch dies at
    // "no phase to anchor a recovery on" (activePhase is null after a park).
    assert.equal(meta?.recovery?.phase, 1);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.recoveries?.['1']?.attempts, 1);
  } finally { cleanup(); }
});

test('a failed verification repair cannot loop: the same reason twice is refused', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    const run = verificationParkedRun(root);

    assert.equal((await svc.maybeAutoRecover('alpha')).launched, true);
    // The repair came back empty-handed; the sync records the miss under the
    // SAME slot the launcher bumped.
    svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', phase: 1, runId: run.id },
      { fixed: false, headline: '', detail: '' },
    );

    const again = await svc.maybeAutoRecover('alpha');
    assert.equal(again.launched, false);
    // plan-broken:verification climbs [repair script (not drivable yet), repair
    // agent]; the agent was the rung just spent, so the ladder is exhausted and
    // the phase carries an errand — the loop ends with a named ask, not a retry.
    assert.match(again.reason ?? '', /every rung for plan-broken:verification has been tried/,
      'the same rung is never climbed twice on one phase, and the loop ends');
    assert.equal(loadRun(root, 'alpha', run.id, null)?.recoveries?.['1']?.errand?.situation, 'plan-broken:verification');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The vehicle: session-API recovery first, pty only for plan repairs
 * ------------------------------------------------------------------ */

test('a halt with a resumable session takes the session API — under --allow-run alone, no pty minted', async () => {
  const { root, cleanup } = scratch();
  try {
    // Agent capability OFF on purpose: the old router required --allow-agent
    // even though the autopilot itself is --allow-run, so a console without
    // agents silently never healed. The session vehicle needs only the runner.
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const run = haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'the session for phase 2 ended cleanly but the board still reads "ready" — no handoff was written',
        phase: 2, kind: 'no-handoff',
      },
      phases: { 2: { phase: 2, status: 'failed', attempts: 1, costUsd: 0, sessionId: 'sess-0002' } },
    });

    const resumed: Array<{ phase: number; mode: string }> = [];
    (svc as never as { recoverPhase: (slug: string, phase: number, mode: string) => Promise<null> })
      .recoverPhase = async (_slug: string, phase: number, mode: string) => {
        resumed.push({ phase, mode });
        return null;
      };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.deepEqual(resumed, [{ phase: 2, mode: 'closeout' }],
      'the recovery resumes the phase\'s own session through the runner');
    assert.equal(minted.length, 0, 'no pty agent for a phase whose own session can be resumed');
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.recoveries?.['2']?.attempts, 1, 'the budget was spent at launch');
  } finally { cleanup(); }
});

test('the pre-recovery gate: a board that moved past the halt reconciles the records and launches nothing', async () => {
  // The observed unnecessary-recovery class: sessions launched 19 and 61
  // seconds AFTER the console logged "superseded — the board shows phase N
  // done", because nothing read the board before minting.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'no handoff was written', phase: 2, kind: 'no-handoff',
      },
    });
    // Somebody finished phase 2 by hand: a complete handoff appears on disk.
    mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-02-cart-api-endpoint.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 2\ntitle: cart\nstatus: complete\n---\n# done\n', 'utf8');
    (svc as never as { reread: (slug: string) => void }).reread('alpha');

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    // Which layer catches it depends on who read the run first: the read-path
    // resolver may reconcile before the gate ever runs (loading the run IS a
    // read), or the gate does it against a pooled state the read path skips.
    // Either way the contract holds: nothing launched, records closed.
    assert.match(out.reason ?? '',
      /board had already moved past the halt|the halt is not auto-recoverable|already resolved/);
    assert.equal(minted.length, 0, 'nothing was spawned for work somebody already did');

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.phases['2'].status, 'done');
    assert.match(after.phases['2'].note ?? '', /closed outside this run/);
    assert.equal(after.halt, null, 'the halt about the finished phase is stood down');
    assert.ok(after.resolved, 'the run is resolved as superseded');
    assert.match(after.resolved?.reason ?? '', /superseded/);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The anchor is a SITUATION, not the halt's phase — the measured dead end
 * ------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';

/** A scratch root that is a clean git repository: the work evidence can then say "nothing" rather than "unreadable". */
function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

test('a parked run whose only open record is interrupted with no work anchors on it and re-boards fresh — no "no phase to anchor"', async () => {
  // The 2026-08-19 P12 specimen: the operator resumed a run, it parked at once
  // on an `interrupted` record (stopped by the operator, 16 turns, during
  // bootstrap), and Recover & continue answered "needs-you: no phase to
  // anchor a recovery on" — twice — before a $3.32 closeout discovered the
  // phase had never been implemented. activePhase is null after a park and
  // the park's halt names no phase, so the old derivation had nothing.
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = {
      at: new Date().toISOString(),
      reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)',
    };
    state.finishedReason = state.halt.reason;
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'stopped by the operator';
    record.sessionId = 'sess-0001';
    record.startedAt = new Date(Date.now() + 5_000).toISOString(); // started after the seed commit: nothing since
    record.turns = 16;
    record.costUsd = 1.44;
    saveRun(state);

    const retried: number[] = [];
    (svc as never as { retryPhase: (slug: string, phase: number) => Promise<null> })
      .retryPhase = async (_slug: string, phase: number) => { retried.push(phase); return null; };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 1);
    assert.equal(out.situation, 'never-started');
    assert.equal(out.rung, 'reboard-fresh');
    assert.equal(out.vehicle, 'retry', 'the runner\'s own re-board — no closeout, no agent, no person');
    assert.deepEqual(retried, [1]);
    assert.equal(minted.length, 0);

    const disk = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.situation, 'never-started');
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-fresh');
    assert.equal(disk.recoveries?.['1']?.attempts, 1, 'the legacy counter moves with the rung');
    assert.equal(disk.phases['1'].situation?.key, 'never-started', 'the record caches what it read as');

    // The journal carries the situation and the rung by name.
    const { readFileSync } = await import('node:fs');
    const { journalFile } = await import('../server/runner/state.ts');
    const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
    const situation = lines.find((l) => l.event === 'phase.situation');
    assert.equal(situation?.phase, 1);
    assert.equal(situation?.data.situation, 'never-started');
    const rung = lines.find((l) => l.event === 'phase.rung');
    assert.equal(rung?.data.rung, 'reboard-fresh');
    assert.equal(rung?.data.vehicle, 'retry');
  } finally { cleanup(); }
});

test('Recover & continue names the step: the phase, what it reads as, and the rung', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root, { allowAgent: false });
    stubMint(svc);
    const state = newRun({ slug: 'alpha', root });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)' };
    state.finishedReason = state.halt.reason;
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'stopped by the operator';
    record.startedAt = new Date(Date.now() + 5_000).toISOString();
    saveRun(state);
    (svc as never as { retryPhase: (slug: string, phase: number) => Promise<null> }).retryPhase = async () => null;

    const report = await svc.recoverPlan('alpha');
    assert.equal(report.outcome, 'recovering', report.detail);
    assert.ok(report.steps.some((step) => /phase 1 reads Never started — re-boarding it fresh through the runner \(rung reboard-fresh\)/.test(step)),
      report.steps.join(' | '));
  } finally { cleanup(); }
});

test('a work-in-progress phase with no session left re-boards through the runner WITH the resume brief — the reboard vehicle', async () => {
  // The 2026-08-13 P2 shape, minus the session: unfinished work on disk, no
  // transcript to resume. The ladder's first rung (own session) is not
  // available; the second is the runner's own re-board with a RESUMING brief,
  // driven through `startRun({resumeRunId, reboard})` — never a closeout that
  // may not do the work, never a bare needs-you.
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    writeFileSync(join(root, 'half-done.txt'), 'the work, unfinished');
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted' };
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'the console stopped while phase 1 was running';
    record.attempts = 1;
    saveRun(state);

    const starts: Array<Record<string, unknown>> = [];
    (svc as never as { startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown> })
      .startRun = async (_slug: string, options: Record<string, unknown>) => { starts.push(options); return null; };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 1);
    assert.equal(out.situation, 'work-in-progress');
    assert.equal(out.rung, 'reboard-resume-brief');
    assert.equal(out.vehicle, 'reboard');
    assert.equal(minted.length, 0, 'no agent');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].resumeRunId, state.id);
    const reboard = starts[0].reboard as Array<Record<string, unknown>>;
    assert.equal(reboard.length, 1);
    assert.equal(reboard[0].phase, 1);
    assert.equal(reboard[0].situation, 'work-in-progress');
    assert.equal(reboard[0].rung, 'reboard-resume-brief');
    assert.equal(reboard[0].brief, 'resume');
    assert.equal(reboard[0].sessionId, undefined, 'nothing to resume — the brief is the whole bridge');

    const disk = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-resume-brief', 'the healer accounts the rung; start({reboard}) does not double-count');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The QA wedge: a stop whose blocker is a phase the board reads DONE
 * ------------------------------------------------------------------ */

/**
 * The measured dead end. Phase 1 finished and its QA verdict is `fail`, so the
 * engine holds 2 and 3 for ever and the board has nothing ready. Every record
 * this run holds reads `done`, so `classifyOpenPhases` — which skips board-done
 * and board-waiting phases — yields no candidate at all, and the healer used to
 * answer "no open phase of this run has a record to act on" with `phase: 0,
 * situation: 'unknown'`, writing no errand and pushing nothing. The operator
 * pressed the button three times and got the same sentence each time.
 */
function qaWedgedRun(root: string): RunState {
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
    '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | fail | reports/phase-01-qa.md |\n',
    'utf8',
  );
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'parked';
  state.stoppedBy = 'system';
  const record = phaseRecord(state, 1);
  record.status = 'done';
  record.note = 'closed outside this run (the board reads done)';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 is done but its QA verdict is fail, which holds phases 2, 3.',
    phase: 1,
    kind: 'plan-deadlocked',
  };
  saveRun(state);
  return state;
}

test('the engine really does wedge on a recorded QA fail (the premise)', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    qaWedgedRun(s.root);
    const board = await svc.boardStates('alpha');
    assert.equal(board[1], 'done');
    assert.equal(board[2], 'waiting', 'a fail holds the dependent even though 1 is done');
  } finally { s.cleanup(); }
});

test('a QA-wedged run is climbed, not handed to a person', async () => {
  // Before: "no open phase of this run has a record to act on", three times,
  // with no errand and nothing launched. Then, briefly, an errand — better, but
  // still a person's afternoon. Now the ladder climbs it: the phase that built
  // the work is resumed with the QA report and asked to clear the findings and
  // re-record the verdict. Nothing is asked of anybody unless that runs out.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    saveRun(state);

    const result = await svc.recoverPlan('alpha');
    assert.equal(result.outcome, 'recovering', 'the wedge is the ladder\'s to clear');
    assert.doesNotMatch(result.detail ?? '', /no open phase/);

    const after = loadRun(s.root, 'alpha', state.id)!;
    const rungs = after.recoveries?.['1']?.rungs ?? [];
    assert.equal(rungs[0]?.rung, 'resume-own-session', 'and it climbed the QA rung');
    assert.equal(rungs[0]?.params?.mode, 'qa-fix');
  } finally { s.cleanup(); }
});
test('a QA wedge the ladder has spent still leaves exactly one errand', async () => {
  // Exhaustion is the only thing that makes a QA verdict a person's again — and
  // when it happens the ask has to be there, naming the report and the two doors
  // (fix and re-record, or waive). This is the errand `ladder.ts` has always
  // carried and nothing could reach.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    // Both rungs already climbed and failed: nothing left to try.
    state.recoveries = {
      1: {
        attempts: 2, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-failed', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'failed', params: { mode: 'qa-fix' } },
          { situation: 'qa-failed', rung: 'fix-agent', at: new Date().toISOString(), outcome: 'failed' },
        ],
      },
    };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false, 'every rung is spent');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const errand = after.errand ?? after.recoveries?.['1']?.errand;
    assert.ok(errand, 'an exhausted climb must leave the ask behind');
    assert.match(errand!.need, /QA verdict/);
    assert.match(errand!.how, /qa-record\.sh|QA/);
  } finally { s.cleanup(); }
});
test('maybeAutoRecover leaves an errand for a stop with no anchor at all', async () => {
  // The unattended half. `maybeAutoRecover` returned at its empty-candidate
  // guard, BEFORE the errand/journal/push machinery, so an unattended console
  // swept the run every five minutes for ever, refused with the same sentence
  // each time, and never once asked the person who could fix it.
  //
  // The QA shapes climb now, so the shape that reaches this guard is one with
  // no record to act on at all — here, a run whose only record the board has
  // overtaken and whose halt names a phase the QA table does not hold.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    // Every rung spent, so the climb cannot start; the ask is all that is left.
    state.recoveries = {
      1: {
        attempts: 9, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-failed', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'failed', params: { mode: 'qa-fix' } },
          { situation: 'qa-failed', rung: 'fix-agent', at: new Date().toISOString(), outcome: 'failed' },
        ],
      },
    };
    saveRun(state);
    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.ok(after.errand ?? after.recoveries?.['1']?.errand, 'the ask must be written, not just returned');
  } finally { s.cleanup(); }
});
test('a spent recovery budget still leaves the errand behind', async () => {
  // Two ceilings sit ahead of the ladder in `maybeAutoRecover`: the run's
  // per-phase launch cap and a hardcoded run-wide 5. Both `refuse` and move on
  // WITHOUT writing an errand — so a phase whose budget ran out went quiet
  // rather than asking. Exhaustion is exactly when a person has to be told:
  // "the ladder climbed everything it had and none of it worked" is the most
  // actionable thing this system ever knows, and it was the one case that said
  // nothing. (`ladder.ts`'s own exhaustion path has always written one.)
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = haltedRun(s.root);
    // Spend the per-phase budget the way the healer itself would have.
    state.recoveries = { 2: { attempts: 5, lastAt: new Date().toISOString() } };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /budget/);
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.ok(after.recoveries?.['2']?.errand, 'a spent budget is an ask, not a silence');
    assert.ok((after.recoveries!['2'].errand!.need ?? '').length > 0);
  } finally { s.cleanup(); }
});

test('the run-wide recovery ceiling comes from the ladder prefs, not a hardcoded 5', async () => {
  // `if (totalAttempts >= 5)` was a second, silent ceiling that contradicted
  // `ladderPerRunRungs` in Settings — an operator who raised the ladder budget
  // to 20 still got five.
  const s = scratch();
  try {
    const svc = service(s.root);
    svc.prefs.ladderPerRunRungs = 12;
    stubMint(svc);
    const state = haltedRun(s.root);
    state.recoveries = { 2: { attempts: 0, lastAt: new Date().toISOString() } };
    // Six launches across other phases: over the old hardcoded 5, under 12.
    state.recoveries['9'] = { attempts: 6, lastAt: new Date().toISOString() };
    saveRun(state);
    const result = await svc.maybeAutoRecover('alpha');
    assert.doesNotMatch(result.reason ?? '', /5 launches/,
      'the prefs are the ceiling; a second hardcoded one is a setting that lies');
  } finally { s.cleanup(); }
});

test('a rung this console may not drive still leaves an errand naming the flag', async () => {
  // `vehicleForRung` deliberately does NOT consult capability flags: a vehicle
  // the console has but may not use is still the right vehicle, and refusing it
  // BY NAME ("needs --allow-agent") beats skipping it silently, which would read
  // as "nothing to climb" and hide the flag that was actually in the way. That
  // reasoning is sound and stays.
  //
  // What was missing is the other half. The refusal returned without writing an
  // errand, so the reason reached a journal line and a HealResult — and the
  // operator, who is the only one who can restart the console with the flag,
  // was never told. The ladder's own exhaustion path has always written one.
  const s = scratch();
  try {
    const svc = service(s.root, { allowAgent: false });
    const state = haltedRun(s.root);
    // No resumable session, so the ladder reaches for an agent rung.
    delete state.phases['2'].sessionId;
    delete state.phases['2'].resumeSessionId;
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /--allow-agent/, 'the refusal still names the flag');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const errand = after.recoveries?.['2']?.errand;
    assert.ok(errand, 'and the person who can supply the flag is asked for it');
    assert.match(`${errand!.need} ${errand!.how}`, /allow-agent/);
  } finally { s.cleanup(); }
});

test('a QA-blocked done phase is a candidate the ladder can actually climb', async () => {
  // When the QA situations had no rungs, admitting a board-`done` phase to the
  // candidate list bought nothing — it produced a better-worded refusal and a
  // push duplicating the inbox's, at the cost of contradicting the documented
  // candidate contract ("their records are closed by the reconcile pass, not
  // diagnosed"). That was the right call then.
  //
  // It is not the right call now: `qa-failed` and `qa-pending` climb, so the
  // phase holding the plan is a phase the ladder can genuinely act on. The guard
  // stays for every OTHER done phase — a settled phase is still settled.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';   // the session that built it survives
    saveRun(state);

    const board = await svc.boardStates('alpha');
    const candidates = await svc.classifyOpenPhases('alpha', state, board);
    assert.equal(candidates.length, 1, 'the phase holding the plan is now reachable');
    assert.equal(candidates[0].phase, 1);
    assert.equal(candidates[0].situation.key, 'qa-failed');
  } finally { s.cleanup(); }
});

test('a genuinely settled done phase is still not a candidate', async () => {
  // The guard's whole purpose: a phase the board reads done, with a clean
  // verdict, is finished work. Diagnosing it would spend a board read and a
  // classify per pass, for ever, on every plan.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    // Phase 1 done and QA-passed; the run holds a record for it.
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n', 'utf8',
    );
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n', 'utf8',
    );
    const state = newRun({ slug: 'alpha', root: s.root, autoRecover: true });
    state.status = 'parked';
    phaseRecord(state, 1).status = 'done';
    saveRun(state);

    const board = await svc.boardStates('alpha');
    const candidates = await svc.classifyOpenPhases('alpha', state, board);
    assert.deepEqual(candidates.map((c) => c.phase), [], 'settled work is not diagnosed');
  } finally { s.cleanup(); }
});

test('a QA rung hands the session real commands, never placeholders', async () => {
  // A resumed session is mid-conversation and will run what it is given. A brief
  // that says `qa-record.sh <slug> <N>` is handing it a guess — and the one thing
  // this rung exists to produce is a verdict recorded in the right place under
  // the right name.
  const s = scratch();
  try {
    const svc = service(s.root);
    const build = (svc as unknown as {
      vehicleForRung: (
        rung: unknown, situation: unknown, record: unknown, evidence: unknown, slug: string,
      ) => { instruction?: string } | null;
    }).vehicleForRung.bind(svc);

    const record = { phase: 7, status: 'done', sessionId: 'sess-p7' };
    const evidence = { phase: 7, handoff: { exists: false }, qa: { mode: 'on', result: 'fail' } };

    for (const mode of ['qa-fix', 'qa-verdict']) {
      const vehicle = build(
        { vehicle: 'resume-own-session', params: { mode } }, { key: 'qa-failed' }, record, evidence, 'alpha',
      );
      const instruction = vehicle?.instruction ?? '';
      assert.match(instruction, /qa-record\.sh alpha 7/, `${mode}: the real slug and phase`);
      assert.match(instruction, /reports\/phase-07-qa\.md/, `${mode}: the real, zero-padded report path`);
      assert.doesNotMatch(instruction, /<slug>|<N>|<NN>/, `${mode}: no placeholder may survive into a brief`);
    }
  } finally { s.cleanup(); }
});

test('a phase whose handoff is on disk reports it as present, not absent', async () => {
  // `handoffFor` answers the parsed handoff or `undefined`; a `Handoff` carries
  // no `exists` field, so `handoff?.exists` was always undefined and EVERY phase
  // with a real handoff derived `{exists: false}`. Live on a real plan: one API
  // response carrying `phase.handoff.status: 'complete'` beside
  // `proof.handoff: 'absent'`, and a phase card telling the operator to "re-scan"
  // a file that was present, complete and already parsed. Two call sites share
  // the predicate, so this asserts through the SERVICE — `evidence-model.js` was
  // always right about what it was handed.
  const s = scratch();
  try {
    qaWedgedRun(s.root);            // writes a real phase-01 handoff, status: complete
    const svc = service(s.root);    // opened after, so the store's first scan sees it
    const detail = await svc.detail('alpha');
    const phase1 = detail?.phases.find((p) => p.phase === 1);
    assert.ok(phase1, 'phase 1 must be in the detail');
    assert.equal(phase1!.handoff?.status, 'complete', 'the premise: the store parsed it');
    assert.equal(phase1!.proof?.handoff, 'complete', 'and the evidence must agree with the store');
    assert.ok(
      !(phase1!.proof?.why ?? []).some((w) => /handoff absent|re-scan/i.test(w)),
      `no "re-scan" about a file that is right there: ${(phase1!.proof?.why ?? []).join(' | ')}`,
    );
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The last gate between a chosen QA rung and an actual launch
 * ------------------------------------------------------------------ */

test('preRecoveryGate: a done phase whose QA holds the plan is NOT superseded', async () => {
  // `preRecoveryGate` is the belt on every launch: it re-reads the board and
  // stands down when the board has moved past the halt. Its test for that is
  // `board[phase] === 'done'` — which is exactly true of the phase a QA verdict
  // is holding, and exactly the wrong conclusion about it. So the ladder chose
  // the right rung, and the gate refused it one line before the spawn:
  // "the board had already moved past the halt — records reconciled, nothing to
  // launch", on a plan where nothing had moved past anything.
  //
  // Keyed on the BOARD FACT, not on the halt's kind: the run that exposed this
  // was parked by an older build, so its halt carries no `kind` and no `phase`
  // at all, and any fix that reads the halt leaves every existing run wedged.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);

    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    // An OLD-style halt: no kind, no phase — the shape on disk right now.
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run: 6 phase(s) are still waiting.' };
    saveRun(state);

    assert.equal(await gate('alpha', state, 1), 'proceed',
      'a phase the QA gate is holding has not been overtaken by anything');
  } finally { s.cleanup(); }
});

test('preRecoveryGate: a genuinely finished phase is still superseded', async () => {
  // The guard's real job, unchanged: a phase the board finished and QA passed is
  // done, and launching anything for it would be spending on settled work.
  const s = scratch();
  try {
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n', 'utf8',
    );
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n', 'utf8',
    );
    const svc = service(s.root);
    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);

    const state = newRun({ slug: 'alpha', root: s.root, autoRecover: true });
    state.status = 'parked';
    phaseRecord(state, 1).status = 'failed';
    state.halt = { at: new Date().toISOString(), reason: 'phase 1 failed', phase: 1, kind: 'verify-failed' };
    saveRun(state);

    assert.equal(await gate('alpha', state, 1), 'superseded',
      'finished work is finished — this is what the guard exists for');
  } finally { s.cleanup(); }
});

test('a run parked by an OLDER build still gets its QA wedge climbed', async () => {
  // End to end, on the shape that is actually on disk: a halt with no kind and
  // no phase, both records `done`, a recorded QA fail. Every earlier layer was
  // right — the candidate list admits phase 1, the ladder picks `qa-fix` — and
  // the launch was refused by the gate above. This is the assertion that would
  // have caught it.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    stubMint(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run: 6 phase(s) are still waiting.' };
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].resumeSessionId = 'sess-p1';
    saveRun(state);

    let resumed: { phase?: number; mode?: string; instruction?: string } | null = null;
    const pooled = svc.runnerFor('alpha') as unknown as {
      recover: (o: { phase?: number; mode?: string; instruction?: string }) => Promise<unknown>;
    };
    pooled.recover = async (o) => { resumed = o; return state; };

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true, `expected a launch, got: ${result.reason}`);
    assert.equal(result.phase, 1);
    assert.equal(result.situation, 'qa-failed');

    // The launch is fire-and-forget by design (the healer answers at once and
    // the session runs on), so wait for the drive rather than racing it.
    const deadline = Date.now() + 5_000;
    while (!resumed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(resumed?.phase, 1, 'and it really drove the phase holding the plan');
    assert.equal(resumed?.mode, 'resume');
    assert.match(resumed?.instruction ?? '', /qa-record\.sh alpha 1/);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Per-phase QA: `- **QA:** on|off` in a phase's own section
 * ------------------------------------------------------------------ */

/** A plan that gates on QA, with phase 2 opting out for itself. */
function perPhaseQaPlan(root: string): void {
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), `---
slug: alpha
created: 2026-08-22
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | docs   | — | — | app | it reads |
| 3 | ship   | 2 | — | app | it ships |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — docs
- **Size:** S
- **QA:** off

### Phase 3 — ship
- **Size:** S
`, 'utf8');
}

test('the console reads a phase\'s own QA regime, not just the plan\'s', async () => {
  const s = scratch();
  try {
    perPhaseQaPlan(s.root);
    const svc = service(s.root);
    assert.equal((await svc.qaMode('alpha')).mode, 'on', 'the plan gates');
    assert.equal((await svc.qaMode('alpha', 1)).mode, 'on', 'a silent phase inherits it');
    assert.equal((await svc.qaMode('alpha', 2)).mode, 'off', 'and a phase may exempt itself');
    assert.match((await svc.qaMode('alpha', 2)).reason ?? '', /phase directive/,
      'the reason says WHERE the answer came from — "why is this not being reviewed" is the real question');
  } finally { s.cleanup(); }
});

test('a QA-exempt phase is never treated as QA-held by the healer', async () => {
  // `qaHolds` decides whether a board-`done` phase is admitted to the candidate
  // list as a blocker. A phase the plan exempts is done work, not a blocker —
  // admitting it would have the ladder resume a session to produce a verdict
  // nothing is waiting for.
  const s = scratch();
  try {
    perPhaseQaPlan(s.root);
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | fail | - |\n| 2 | fail | - |\n',
      'utf8',
    );
    const svc = service(s.root);
    const holds = (svc as unknown as {
      qaHolds: (slug: string, phase: number) => Promise<boolean>;
    }).qaHolds.bind(svc);

    assert.equal(await holds('alpha', 1), true, 'phase 1 gates and its verdict is red');
    assert.equal(await holds('alpha', 2), false, 'phase 2 exempted itself — its row governs nothing');
  } finally { s.cleanup(); }
});

test('a rung is not settled while its own session is still running', async () => {
  // Observed on a live run: the `qa-fix` rung recorded `outcome: 'failed'`, note
  // "the run reads running", while its `claude` process was eight minutes into
  // doing exactly what it was asked. The settle block reads the run's status the
  // moment `recoverPhase` resolves and treats anything that is not
  // parked-without-halt as a failure — but `running` is not a verdict, it is the
  // absence of one, and a run that is still going has not failed at anything.
  //
  // The cost is a lie in the ledger and a premature escalation: the next climb
  // reads rung 1 as spent and reaches for the more expensive rung 2.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    stubMint(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run.' };
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].resumeSessionId = 'sess-p1';
    saveRun(state);

    // The recovery resolves, but the run is still being driven — exactly the
    // shape that produced the false verdict.
    const pooled = svc.runnerFor('alpha') as unknown as {
      recover: (o: unknown) => Promise<unknown>; current: () => unknown;
    };
    // What the real one does: by the time `recoverPhase` resolves, the drive
    // loop owns the run and it reads `running`. The settle block prefers the
    // pooled runner's own `current()` over a load, so that is what is faked —
    // a `loadRun` would reclaim a `running` record whose pid is not alive and
    // report `interrupted`, which is a different story.
    // The run as it really is on disk (rung and all), with the one field that
    // matters overridden — a plain copy of the pre-climb `state` would carry no
    // rung, and the settle would find nothing to settle, which is a green test
    // that proves nothing.
    const asRunning = () => {
      const live = loadRun(s.root, 'alpha', state.id);
      return live ? { ...live, status: 'running' as const } : null;
    };
    pooled.recover = async () => asRunning();
    pooled.current = () => asRunning();

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true);

    const deadline = Date.now() + 4_000;
    let rung: { outcome?: string } | undefined;
    while (Date.now() < deadline) {
      rung = loadRun(s.root, 'alpha', state.id)?.recoveries?.['1']?.rungs?.[0];
      if (rung?.outcome && rung.outcome !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(rung?.outcome, 'failed',
      `a rung whose run is still driving has not failed: ${JSON.stringify(rung)}`);
  } finally { s.cleanup(); }
});

test('a QA-held phase is exempt from "superseded" even when other phases are ready', async () => {
  // The exemption was guarded by `wedgeCleared` — "does the BOARD have anything
  // ready or in flight?" — which is a plan-wide fact answering a per-phase
  // question. Whether some unrelated chain has work says nothing about whether
  // THIS phase's verdict is holding its own dependents, and on any plan with a
  // parallel branch the exemption silently evaporated: the ladder picked the QA
  // rung and the gate refused it again, exactly as before the fix.
  //
  // It only looked right because the specimen that exposed the bug happened to
  // have an empty ready set.
  const s = scratch();
  try {
    // A plan with a parallel branch: 1 -> 2, and an independent 3. Phase 1's
    // verdict holds 2 while 3 sits ready — the ordinary shape of any real plan,
    // and the one the guard silently failed on.
    writeFileSync(join(s.root, 'docs', 'plans', 'alpha.md'), `---
slug: alpha
created: 2026-08-22
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema   | — | — | app | it works |
| 2 | after it | 1 | — | app | it still works |
| 3 | elsewhere| — | — | app | it ships |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — after it
- **Size:** S

### Phase 3 — elsewhere
- **Size:** S
`, 'utf8');
    qaWedgedRun(s.root);
    const svc = service(s.root);
    const board = await svc.boardStates('alpha');
    assert.ok(Object.values(board).includes('ready'), `the premise: something else is ready — ${JSON.stringify(board)}`);

    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    assert.equal(await gate('alpha', state, 1), 'proceed',
      'a verdict holding this phase\'s dependents is not settled by other work being ready');
  } finally { s.cleanup(); }
});
