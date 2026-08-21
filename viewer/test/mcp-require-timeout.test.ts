/**
 * The `require` MCP park's clock, at the service: the console owns the timer
 * because only the console can restart a run the park stopped.
 *
 * Pinned: a park already past its clock at boot is continued at once —
 * flipped on disk, journalled, announced once, and the run restarted through
 * `startRun`; a park still on its clock is armed for the remainder and the
 * healer refuses it with the time rather than writing an errand; a timeout of
 * 0 arms nothing. Nothing here spawns `claude`: the restart is stubbed where
 * it is asserted, and everything up to it is real.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun, loadRun, journalFile } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 2
---

# alpha

## Session budget
**MCP servers (every session):** \`gh\`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — api
- **Size:** S
- **Verification:** \`true\`
`;

const OPEN: Array<{ close: () => void }> = [];

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-mcp-timeout-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.splice(0)) svc.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Started = { slug: string; resumeRunId?: string };
type Announced = { category: string; title: string; body: string };

/**
 * A service with the restart stubbed and the announcer captured — BOTH before
 * `open()`, because the boot pass arms the clock synchronously inside it and
 * an overdue clock fires on the very next macrotask.
 */
function service(root: string, prefs: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  const started: Started[] = [];
  const announced: Announced[] = [];
  const s = svc as never as {
    startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown>;
    announce: (category: string, payload: { title: string; body: string }) => void;
    prefs: Record<string, unknown>;
    mcpRequireTimers: Map<string, unknown>;
  };
  s.startRun = async (slug, options) => { started.push({ slug, resumeRunId: options.resumeRunId as string | undefined }); return null; };
  s.announce = (category, payload) => { announced.push({ category, title: payload.title, body: payload.body }); };
  Object.assign(s.prefs, prefs);
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return { svc, started, announced, timers: () => s.mcpRequireTimers };
}

/** A run parked at boarding under `require` — the halt names the MCP door — with the park `minutesAgo` old. */
function parkedRun(root: string, minutesAgo: number): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true, mcpPolicy: 'require' });
  state.status = 'parked';
  state.stoppedBy = 'system';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 cannot start: MCP server gh (needs authentication). '
      + 'a signed-out MCP server takes Settings ▸ MCP, or Continue without these servers.',
    kind: 'mcp-preflight',
    phase: 1,
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.note = 'phase 1 cannot start: MCP server gh (needs authentication). An unattended session cannot sign a server in — '
    + 'do it from Phase Console → MCP (or `claude mcp login <name>`), then Retry.';
  record.mcpPark = {
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    degraded: [{ id: 'gh', reason: 'needs-auth' }],
  };
  saveRun(state);
  return state;
}

function journal(root: string, runId: string): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, 'alpha', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('boot: a require park already past its clock is continued at once — flipped on disk, journalled, announced once, run restarted', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = parkedRun(root, 31);
    const { svc, started, announced } = service(root);
    await svc.bootSettled;
    const deadline = Date.now() + 3_000;
    while (!started.length && Date.now() < deadline) await sleep(20);

    assert.equal(started.length, 1, 'the run is restarted so the loop boards the phase');
    assert.equal(started[0].resumeRunId, run.id);
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.phases['1'].status, 'pending');
    assert.equal(after.phases['1'].boardingHint?.rung, 'mcp-continue');
    assert.equal(after.phaseOptions?.['1']?.mcpPolicy, 'continue');
    assert.equal(after.recoveries?.['1']?.errand?.situation, 'mcp-unavailable');
    assert.match(after.recoveries?.['1']?.errand?.need ?? '', /went ahead without it after waiting 31 min/);
    assert.equal(after.halt, null, 'the halt was about this park');
    const lines = journal(root, run.id);
    assert.ok(lines.some((l) => l.event === 'phase.mcp-require-timeout' && l.phase === 1 && (l.data.by === 'timeout')));
    assert.ok(lines.some((l) => l.event === 'phase.errand' && l.phase === 1));
    const told = announced.filter((a) => a.category === 'parked' && /continues without an MCP server/.test(a.title));
    assert.equal(told.length, 1, 'the operator hears once');
    assert.match(told[0].body, /gh did not connect within 31 min/);
  } finally {
    cleanup();
  }
});

test('a park still on its clock is armed for the remainder — and the healer refuses it with the time instead of writing an errand', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = parkedRun(root, 1);
    const { svc, started, timers } = service(root);
    await svc.bootSettled;
    await sleep(50);
    assert.equal(started.length, 0, 'nothing restarted — the clock has 29 minutes to run');
    assert.equal(timers().size, 1, 'armed for the remainder');
    assert.equal(loadRun(root, 'alpha', run.id, null)!.phases['1'].status, 'parked');

    const verdict = await svc.maybeAutoRecover('alpha');
    assert.equal(verdict.launched, false);
    assert.match(verdict.reason ?? '', /continues without it at .* unless the server heals first/);
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.phases['1'].status, 'parked', 'untouched');
    assert.equal(after.recoveries?.['1']?.errand, undefined, 'no errand while the clock runs');
    assert.equal(started.length, 0);
  } finally {
    cleanup();
  }
});

test('a timeout of 0 means wait indefinitely: nothing is armed, nothing is flipped', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = parkedRun(root, 120);
    const { svc, started, timers } = service(root, { mcpRequireTimeoutMs: 0 });
    await svc.bootSettled;
    await sleep(50);
    assert.equal(timers().size, 0);
    assert.equal(started.length, 0);
    assert.equal(loadRun(root, 'alpha', run.id, null)!.phases['1'].status, 'parked');
  } finally {
    cleanup();
  }
});

test('continueMcpParkedPhase by name on a stopped run flips, journals in the service\'s voice, and restarts', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = parkedRun(root, 1);
    const { svc, started, announced } = service(root);
    await svc.bootSettled;
    const result = await svc.continueMcpParkedPhase('alpha', 1, 'operator');
    assert.ok(result);
    assert.deepEqual(result.servers, ['gh']);
    assert.equal(started.length, 1);
    assert.equal(started[0].resumeRunId, run.id);
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.phases['1'].status, 'pending');
    assert.ok(journal(root, run.id).some((l) => l.event === 'phase.mcp-require-timeout' && l.data.by === 'operator'));
    assert.equal(announced.filter((a) => /continues without/.test(a.title)).length, 1);
    assert.equal(await svc.continueMcpParkedPhase('alpha', 1, 'operator'), null, 'flipped once');
  } finally {
    cleanup();
  }
});
