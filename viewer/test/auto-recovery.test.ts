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

test('the identical failure is never retried — that is a person’s to read', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const reason = 'phase 2 did not verify: 1 of 2 command(s) failed — npm test';
    haltedRun(root, {
      recoveries: { 2: { attempts: 1, lastAt: new Date().toISOString(), lastReason: reason } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /same failure/i);
    assert.equal(minted.length, 0);
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
    assert.match(again.reason ?? '', /same failure twice/,
      'a deterministic reason string meets the identical-failure refusal, and the loop ends');
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
