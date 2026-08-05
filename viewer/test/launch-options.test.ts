/**
 * What a launch carries: default skills as an opt-in, and QA turned on at start.
 *
 * Two decisions moved into `startRun` and both are about consent. The machine's
 * default skills used to ride into every run as a side effect of existing; now
 * they ride only when the launch (or the stored preference) says so, and the
 * OFF paths are the ones pinned — the preference must not re-seed a resume, and
 * an unticked box must mean none. QA-on-launch is the same shape: the launch
 * flag (or preference) activates the plan's QA gate BEFORE the runner starts,
 * loudly refuses without `--allow-writes`, and an explicit `qa: false` beats
 * the preference.
 *
 * The runner is stubbed to a recorder: these tests are about what `startRun`
 * DECIDES, and the captured StartOptions are where the decision lands. Nothing
 * here spawns a session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-launch-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
import type { StartOptions } from '../server/runner/runner.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-08-04
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | the tables exist |
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | money moves |

## Phases

### Phase 1 — schema
- **Size:** S
- **Goal:** the tables.

### Phase 2 — cart api endpoint
- **Size:** S
- **Goal:** A cart endpoint that survives a reload.

### Phase 3 — checkout
- **Size:** S
`;

const handoff = (phase: number, title: string) => `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: complete
completed: 2026-08-01
depends_on: [${phase === 1 ? '' : phase - 1}]
blocks: [${phase + 1}]
key_files:
  - src/cart.ts
---

# Phase ${phase}

## What this phase did
It did the thing.
`;

const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(opts: { handoffs?: number[] } = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-launch-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  for (const phase of opts.handoffs ?? []) {
    writeFileSync(
      join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-phase-${phase}.md`),
      handoff(phase, `phase-${phase}`), 'utf8',
    );
  }
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A Service whose runner is a recorder. `startRun`'s job ends where
 * `Runner.start` begins, so everything after the decision is stubbed out.
 */
function service(root: string, over: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: SCRIPTS, logFile: null, defaultSkills: [], ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  // The config home is shared by every test in this file, so each service
  // opens on a known slate — a preference set three tests ago is not part of
  // this test's arrangement.
  svc.savePreferences({ attachDefaultSkills: false, qaByDefault: false });
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);

  const captured: StartOptions[] = [];
  (svc as never as { runnerFor: (slug: string) => unknown }).runnerFor = () => ({
    start: async (options: StartOptions) => {
      captured.push(options);
      return { id: 'run-1', slug: options.slug, status: 'running', phases: {} };
    },
  });
  return { svc, captured };
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Default skills — the attach decision
 * ------------------------------------------------------------------ */

test('with everything off, a silent launch carries no skills at all', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', {});
    assert.equal(captured[0]!.skills, undefined, 'the machine default no longer rides along uninvited');
  } finally { cleanup(); }
});

test('the preference seeds a fresh run, and what was picked rides WITH the defaults', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', {});
    assert.deepEqual(captured[0]!.skills, ['graph-tool']);
    await svc.startRun('alpha', { skills: ['investigate'] });
    // A union, not a coup: the attach box and the picker are separate answers,
    // and ticking one must not erase the other.
    assert.deepEqual(captured[1]!.skills, ['graph-tool', 'investigate']);
  } finally { cleanup(); }
});

test('the per-launch choice beats the preference, in both directions', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', { attachDefaultSkills: true });
    assert.deepEqual(captured[0]!.skills, ['graph-tool'], 'a tick beats an off preference');
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', { attachDefaultSkills: false, skills: ['investigate'] });
    assert.deepEqual(captured[1]!.skills, ['investigate'], 'an untick beats an on preference');
  } finally { cleanup(); }
});

test('an explicit empty list survives as none — the operator unchecked every box', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', { skills: [] });
    assert.deepEqual(captured[0]!.skills, []);
  } finally { cleanup(); }
});

test('a resume never re-seeds from the preference — the run answers for itself', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', { resumeRunId: 'run-1', skills: ['investigate'] });
    assert.deepEqual(captured[0]!.skills, ['investigate'], 'the picked list passes through untouched');
    await svc.startRun('alpha', { resumeRunId: 'run-1' });
    assert.equal(captured[1]!.skills, undefined, 'an omission stays an omission, so sticky skills rule');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA on launch
 * ------------------------------------------------------------------ */

test('qa: true turns the gate on before the runner starts, with the waived backfill', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { qa: true });
    assert.equal(captured.length, 1, 'the run still started');
    const table = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    // Anchored on the LATEST handoff (phase 2), so phase 1 — complete before
    // activation — is recorded waived rather than left to flip its dependents.
    assert.match(table, /\|\s*1\s*\|\s*waived/);
    const mode = await svc.qaMode('alpha');
    assert.notEqual(mode.mode, 'off');
  } finally { cleanup(); }
});

test('QA on launch without --allow-writes is refused loudly, naming the flag', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root, { allowWrites: false });
    await assert.rejects(() => svc.startRun('alpha', { qa: true }), /--allow-writes/);
    assert.equal(captured.length, 0, 'a refused activation must not half-start the run');
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
  } finally { cleanup(); }
});

test('the preference activates QA for a fresh run, and qa: false vetoes it', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root);
    svc.savePreferences({ qaByDefault: true });
    await svc.startRun('alpha', { qa: false });
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')),
      'unticking the box means no activation, whatever the preference says');
    await svc.startRun('alpha', {});
    assert.ok(existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
    assert.equal(captured.length, 2);
  } finally { cleanup(); }
});

test('a resume does not let the preference activate QA behind the run', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc } = service(root);
    svc.savePreferences({ qaByDefault: true });
    await svc.startRun('alpha', { resumeRunId: 'run-1' });
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
  } finally { cleanup(); }
});

test('a plan already under QA starts without another activation write', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { qa: true });
    const before = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    await svc.startRun('alpha', { qa: true });
    const after = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    assert.equal(after, before, 'activation is once; a second launch finds the gate already on');
    assert.equal(captured.length, 2);
  } finally { cleanup(); }
});
