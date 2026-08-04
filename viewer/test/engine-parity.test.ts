/**
 * Parity with the engine.
 *
 * The console parses plans in JavaScript for everything it draws, but takes
 * every status claim from `scripts/phase-graph.sh`. That split is only safe
 * while the two readings of a plan agree, so this test re-derives the live
 * board from the JS parse — using the engine's own rules for handoff status
 * and QA gating — and asserts it matches what the engine reports, for every
 * real plan in the source directory.
 *
 * Point it elsewhere with PHASE_CONSOLE_TEST_ROOT; it skips when the default
 * directory is absent (a fresh clone on another machine).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { checkRoot, safeList, SKILL_DIR } from '../server/config.ts';
import { Store, type PlanRecord } from '../server/store.ts';
import { run, readMemoryBlock, type PhaseState } from '../server/engine.ts';
import { parseTestStatus } from '../server/parse/folder.ts';
import { scopeOfRow, formatScope } from '../shared/scope.js';

// Point these at a real plan library with PHASE_CONSOLE_TEST_ROOT; without it the
// suite skips the integration tests rather than assuming anyone's directory layout.
const ROOT = process.env.PHASE_CONSOLE_TEST_ROOT ?? '';
const SCRIPTS = join(SKILL_DIR, 'scripts');
const available = Boolean(ROOT) && existsSync(join(ROOT, 'docs', 'plans')) && existsSync(join(SCRIPTS, 'phase-graph.sh'));

/** The engine's own status reading: handoff front matter, first match wins. */
function handoffState(record: PlanRecord, phase: number): 'done' | 'in-progress' | 'stuck' | 'not-started' {
  const handoff = record.handoffs.find((h) => h.phase === phase);
  if (!handoff) return 'not-started';
  if (handoff.status === 'complete') return 'done';
  if (handoff.status === 'in-progress') return 'in-progress';
  if (handoff.status === 'blocked') return 'stuck';
  return 'not-started';
}

/** Re-derive the board the way phase-graph.sh does — deliberately duplicated. */
function deriveBoard(record: PlanRecord): Record<number, PhaseState> {
  const rows = record.plan?.graph ?? [];
  const qaFile = record.handoffDir ? join(record.handoffDir, 'test-status.md') : undefined;
  const gating = Boolean(qaFile && existsSync(qaFile));
  const qaRows = gating ? parseTestStatus(readFileSync(qaFile!, 'utf8')) : [];

  const isDone = (phase: number) => handoffState(record, phase) === 'done';
  const isVerified = (phase: number) => {
    if (!isDone(phase)) return false;
    if (!gating) return true;
    const result = qaRows.find((q) => q.phase === phase)?.result;
    return result === 'pass' || result === 'waived';
  };

  const states: Record<number, PhaseState> = {};
  for (const row of rows) {
    const own = handoffState(record, row.phase);
    if (own === 'done') { states[row.phase] = 'done'; continue; }
    if (own === 'in-progress' || own === 'stuck') { states[row.phase] = own; continue; }
    states[row.phase] = row.dependsOn.every(isVerified) ? 'ready' : 'waiting';
  }
  return states;
}

async function boardFor(slug: string) {
  const result = await run({ scriptsDir: SCRIPTS, root: ROOT }, 'phase-graph.sh', [slug, '--memory-block']);
  return readMemoryBlock(result);
}

test('source directory validates', { skip: !available && 'no source directory' }, () => {
  const check = checkRoot(ROOT);
  assert.equal(check.ok, true);
  assert.ok(check.planCount > 0, 'expected plans');
});

test('every plan classifies the same way as the engine', { skip: !available && 'no source directory' }, async () => {
  const store = new Store(checkRoot(ROOT));
  store.scan();

  const records = store.list().filter((r) => r.planPath);
  assert.ok(records.length > 10, 'expected a real plan library');

  const mismatches: string[] = [];
  let phasedCount = 0;
  let documentCount = 0;

  await Promise.all(records.map(async (record) => {
    const board = await boardFor(record.slug);

    if (!record.plan?.phased) {
      documentCount++;
      if (board.phased) mismatches.push(`${record.slug}: JS says document, engine parsed a graph`);
      return;
    }

    phasedCount++;
    if (!board.phased) {
      mismatches.push(`${record.slug}: JS parsed a graph, engine reported "${board.error}"`);
      return;
    }

    const jsPhases = record.plan.graph.map((r) => r.phase).sort((a, b) => a - b);
    const enginePhases = Object.keys(board.states).map(Number).sort((a, b) => a - b);
    if (jsPhases.join(',') !== enginePhases.join(',')) {
      mismatches.push(`${record.slug}: roster JS [${jsPhases}] vs engine [${enginePhases}]`);
      return;
    }

    const derived = deriveBoard(record);
    for (const phase of jsPhases) {
      if (derived[phase] !== board.states[phase]) {
        mismatches.push(`${record.slug} p${phase}: JS "${derived[phase]}" vs engine "${board.states[phase]}"`);
      }
    }
  }));

  assert.deepEqual(mismatches, [], `parity mismatches:\n  ${mismatches.join('\n  ')}`);
  assert.ok(phasedCount > 40, `expected many phased plans, saw ${phasedCount}`);
  assert.ok(documentCount > 0, `expected some non-phased documents, saw ${documentCount}`);
});

test('deps, size and gated flags match the engine phase by phase', { skip: !available && 'no source directory' }, async () => {
  const store = new Store(checkRoot(ROOT));
  store.scan();

  // A spread of shapes: small and large plans, gated phases, QA-gated plans.
  const sample = store.list()
    .filter((r) => r.plan?.phased)
    .sort((a, b) => (b.plan!.graph.length) - (a.plan!.graph.length))
    .filter((_, i) => i % 5 === 0)
    .slice(0, 8);
  assert.ok(sample.length > 3, 'expected a usable sample');

  const problems: string[] = [];
  for (const record of sample) {
    const plan = record.plan!;
    await Promise.all(plan.graph.map(async (row) => {
      const opts = { scriptsDir: SCRIPTS, root: ROOT };
      const [deps, size, gated, repos] = await Promise.all([
        run(opts, 'phase-graph.sh', [record.slug, '--deps', String(row.phase)]),
        run(opts, 'phase-graph.sh', [record.slug, '--size', String(row.phase)]),
        run(opts, 'phase-graph.sh', [record.slug, '--gated', String(row.phase)]),
        run(opts, 'phase-graph.sh', [record.slug, '--repos', String(row.phase)]),
      ]);
      const jsScope = formatScope(scopeOfRow(row.repos));
      if (repos.stdout.trim() !== jsScope) {
        problems.push(`${record.slug} p${row.phase}: scope JS "${jsScope}" vs engine "${repos.stdout.trim()}"`);
      }
      const engineDeps = deps.stdout.trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
      const jsDeps = [...row.dependsOn].sort((a, b) => a - b);
      if (engineDeps.join(',') !== jsDeps.join(',')) {
        problems.push(`${record.slug} p${row.phase}: deps JS [${jsDeps}] vs engine [${engineDeps}]`);
      }
      const jsSize = plan.phases[row.phase]?.size ?? 'M';
      if (size.stdout.trim() !== jsSize) {
        problems.push(`${record.slug} p${row.phase}: size JS ${jsSize} vs engine ${size.stdout.trim()}`);
      }
      const jsGated = plan.phases[row.phase]?.gated ? 'yes' : 'no';
      if (gated.stdout.trim() !== jsGated) {
        problems.push(`${record.slug} p${row.phase}: gated JS ${jsGated} vs engine ${gated.stdout.trim()}`);
      }
    }));
  }

  assert.deepEqual(problems, [], `graph mismatches:\n  ${problems.join('\n  ')}`);
});

/**
 * Scope is the one parity that has teeth: it decides whether two sessions are
 * allowed to run at the same time. `phase-lock.sh` answers that in bash and the
 * console answers it in JavaScript, so a disagreement is not a cosmetic drift —
 * it is one side admitting a session the other would have refused. Every phase
 * of every real plan, not a sample.
 */
test('every phase scopes the same way as the engine', { skip: !available && 'no source directory' }, async () => {
  const store = new Store(checkRoot(ROOT));
  store.scan();

  const rows = store.list()
    .filter((r) => r.plan?.phased)
    .flatMap((r) => r.plan!.graph.map((row) => ({ slug: r.slug, row })));
  assert.ok(rows.length > 100, `expected a real plan library, saw ${rows.length} phases`);

  const problems: string[] = [];
  const BATCH = 24;   // bounded: one subprocess per phase, hundreds of phases
  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(rows.slice(i, i + BATCH).map(async ({ slug, row }) => {
      const result = await run({ scriptsDir: SCRIPTS, root: ROOT }, 'phase-graph.sh',
        [slug, '--repos', String(row.phase)]);
      const engine = result.stdout.trim();
      const js = formatScope(scopeOfRow(row.repos));
      if (engine !== js) problems.push(`${slug} p${row.phase} (${JSON.stringify(row.repos)}): JS "${js}" vs engine "${engine}"`);
      // Never empty on either side: an undeclared phase must read as `all`.
      if (!engine) problems.push(`${slug} p${row.phase}: engine returned an empty scope`);
    }));
  }

  assert.deepEqual(problems, [], `scope mismatches:\n  ${problems.join('\n  ')}`);
});

test('handoff folders without a plan are kept as orphans', { skip: !available && 'no source directory' }, () => {
  const store = new Store(checkRoot(ROOT));
  store.scan();
  const orphans = store.list().filter((r) => r.kind === 'orphan-handoffs');
  for (const orphan of orphans) {
    assert.equal(orphan.planPath, undefined);
    // Some orphans are abandoned work that left only a stale lock behind —
    // still worth surfacing, so the store keeps them either way.
    assert.ok(
      orphan.handoffs.length > 0 || orphan.locks.length > 0 || orphan.index.length > 0,
      `${orphan.slug} should carry handoffs, an index or locks`,
    );
  }
});

test('the store reads every handoff file it should', { skip: !available && 'no source directory' }, () => {
  const store = new Store(checkRoot(ROOT));
  store.scan();

  const handoffsDir = checkRoot(ROOT).handoffsDir!;
  let onDisk = 0;
  for (const dir of safeList(handoffsDir)) {
    const full = join(handoffsDir, dir);
    if (dir.startsWith('.') || !statSync(full).isDirectory()) continue;
    onDisk += safeList(full).filter((f) => /^phase-\d+-.*\.md$/.test(f)).length;
  }
  const parsed = store.list().reduce((n, r) => n + r.handoffs.length, 0);
  assert.equal(parsed, onDisk);
});
