/**
 * One recovery per target, in BOTH directions.
 *
 * `resolveRecovery` always refused to mint an agent while the runner was busy
 * — but the run-verbs (`recheck`/`closeout`/`resume`/`retry`) never looked the
 * other way: an agent recovery holds no runner, so "Fix with a new agent"
 * followed by "Finish in its own session" was two sessions editing one tree.
 * These tests pin the symmetric guard, its 409-with-sessionId wire shape, and
 * the resolve-first gate on the human path (a board that already reads done
 * reconciles the records instead of spawning a session to "finish" them).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service, RecoveryBusyError } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-conc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** A halted run whose phase 2 failed, saved where the service will find it. */
function haltedRun(root: string) {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed',
    phase: 2, kind: 'verify-failed',
  };
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  record.sessionId = 'sess-phase2';
  saveRun(state);
  return state;
}

/** Pretend a live agent recovery is holding (alpha, 2). */
function liveRecoveryStub(svc: ReturnType<typeof service>) {
  const t = svc.terminals as never as Record<string, unknown>;
  t.state = () => ({
    sessions: [{
      id: 'sess-recovery', exited: null,
      meta: { recovery: { kind: 'halted-verification', slug: 'alpha', phase: 2 } },
    }],
  });
}

test('recoverPhase refuses while an agent recovery holds the phase — with its session id', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root);
    liveRecoveryStub(svc);
    await assert.rejects(
      svc.recoverPhase('alpha', 2, 'recheck'),
      (error: unknown) => error instanceof RecoveryBusyError && error.sessionId === 'sess-recovery',
    );
    svc.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retryPhase refuses the same way — a retry is a second session on the same tree', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root);
    liveRecoveryStub(svc);
    await assert.rejects(
      svc.retryPhase('alpha', 2),
      (error: unknown) => error instanceof RecoveryBusyError && error.sessionId === 'sess-recovery',
    );
    svc.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a phase on ANOTHER target is not blocked by the live recovery', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root);
    liveRecoveryStub(svc);
    // Phase 1 has no record in the run — recoverPhase refuses for THAT reason,
    // not the busy guard: the guard is per-(slug, phase), never plan-wide.
    await assert.rejects(
      svc.recoverPhase('alpha', 1, 'recheck'),
      (error: unknown) => !(error instanceof RecoveryBusyError) && /no run of alpha/i.test(String((error as Error).message)),
    );
    svc.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolve-first: a board that reads done reconciles and spawns nothing', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = haltedRun(root);
    // The work was finished outside the run: the handoff exists and is complete.
    writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-02-cart-api.md'), `---
plan: docs/plans/alpha.md
phase: 2
title: cart api
status: complete
---
# Phase 2 — cart api
`, 'utf8');
    // No live recovery; the guard passes and the GATE answers instead.
    let recovered = false;
    const runners = (svc as never as { runnerFor: (slug: string) => { recover: () => Promise<unknown> } });
    const original = runners.runnerFor;
    (svc as never as Record<string, unknown>).runnerFor = () => ({ recover: async () => { recovered = true; return null; } });
    const result = await svc.recoverPhase('alpha', 2, 'closeout');
    (svc as never as Record<string, unknown>).runnerFor = original;

    assert.equal(recovered, false, 'the runner must never be asked — the board already answered');
    assert.equal(result?.id, state.id);
    assert.equal(result?.recoveries?.['2']?.lastOutcome, 'superseded');
    svc.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
