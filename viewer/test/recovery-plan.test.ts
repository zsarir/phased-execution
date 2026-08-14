/**
 * "Recover & continue" — the plan-level button, held to its three honest steps.
 *
 * Step 1 CONFIRMS the stop against the board and stands down whatever the
 * board already settled (the observed shape: phase 7 halted on the banner,
 * done on the list). Step 2 continues a run that has nothing wrong. Step 3
 * arms bounded auto-recovery and runs the SAME healer the unattended path
 * uses — so the button cannot corrupt the orchestration — and anything only
 * a person can settle comes back named.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { listRuns, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

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
  const root = mkdtempSync(join(tmpdir(), 'pc-recover-plan-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

function handoff(root: string, phase: number, title: string, status: string): void {
  const pad = String(phase).padStart(2, '0');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-${pad}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase} — ${title}
`, 'utf8');
}

function haltedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed',
    phase: 2, kind: 'verify-failed',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  record.sessionId = 'sess-2';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

test('a halt the board has moved past is stood down and the run resumes', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = haltedRun(root);
    // The work landed outside the run: BOTH phases read done… no — phase 1
    // stays open so there is something to continue into.
    handoff(root, 2, 'cart-api', 'complete');

    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun =
      async (slug: string, options: unknown) => { started.push({ slug, options }); return state; };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'resumed');
      assert.equal(started.length, 1, 'the run continues under normal admission');
      assert.ok(report.steps.some((step) => /moved past phase 2/.test(step)), report.steps.join(' | '));

      // The story moved with the halt — read back OFF DISK, not through the
      // stub (which returns the stale pre-reconcile object).
      const after = listRuns(root, 'alpha')[0]!;
      assert.equal(after.halt, null);
      assert.equal(after.phases['2'].status, 'done');
      assert.match(after.finishedReason ?? '', /the board has since closed it/);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the honest headline replaces the dead blocker sentence when the halt dissolves', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root, {
      finishedReason: 'phase 2 declared itself blocked: CI is down',
      halt: { at: new Date().toISOString(), reason: 'phase 2 declared itself blocked: CI is down', phase: 2, kind: 'phase-blocked' },
    });
    handoff(root, 1, 'schema', 'complete');
    handoff(root, 2, 'cart-api', 'complete');
    (svc as never as Record<string, unknown>).startRun = async () => { throw new Error('nothing left to start'); };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'nothing-to-do');
      assert.match(report.run!.finishedReason ?? '', /the board has since closed it/);
      assert.doesNotMatch(report.run!.finishedReason ?? '', /declared itself blocked/);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a REAL halt arms bounded auto-recovery and runs the same healer, once, now', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root); // board still reads phase 2 open — the halt is real
    const healed: string[] = [];
    (svc as never as Record<string, unknown>).maybeAutoRecover =
      async (slug: string) => { healed.push(slug); return { launched: true }; };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'recovering');
      assert.deepEqual(healed, ['alpha'], 'the unattended healer IS the vehicle — no second orchestration');
      assert.ok(report.steps.some((step) => /armed auto-recovery/.test(step)));
      assert.deepEqual(report.run!.autoRecover, { attempts: 2 });
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('what only a person can settle comes back named, never blindly retried', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'phase 2 needs a person: the deploy window must be confirmed',
        phase: 2, kind: 'needs-human',
      },
    });
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'needs-you');
      assert.match(report.detail, /not auto-recoverable|needs a person|auto-recovery/i);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live run is left alone', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = haltedRun(root);
    (svc as never as Record<string, unknown>).liveRunner =
      () => ({ current: () => state, busy: () => true });
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'running');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
