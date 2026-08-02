/**
 * Service, analysis and write-guard behaviour against the real source
 * directory. Skips when that directory is absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR, checkRoot } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { planWrite, WriteError } from '../server/writes.ts';
import { indexGraph, layerGraph, routeLayout, criticalPath, transitiveDependents, resolveBudget, loadSizing } from '../server/analysis/graph.ts';
import { weeklyBuckets, isoWeek, normalisePlanStatus } from '../server/analysis/stats.ts';
import type { Board } from '../server/engine.ts';

// Point these at a real plan library with PHASE_CONSOLE_TEST_ROOT; without it the
// suite skips the integration tests rather than assuming anyone's directory layout.
const ROOT = process.env.PHASE_CONSOLE_TEST_ROOT ?? '';
const available = Boolean(ROOT) && existsSync(join(ROOT, 'docs', 'plans'));

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
};

function board(states: Record<number, string>): Board {
  const b: Board = { phased: true, states: {} as Board['states'], done: [], inProgress: [], stuck: [], ready: [], waiting: [] };
  for (const [phase, state] of Object.entries(states)) {
    (b.states as Record<number, string>)[Number(phase)] = state;
    if (state === 'done') b.done.push(Number(phase));
    if (state === 'ready') b.ready.push(Number(phase));
    if (state === 'waiting') b.waiting.push(Number(phase));
  }
  return b;
}

const ROWS = [
  { phase: 1, title: 'a', dependsOn: [], parallelSafe: '', repos: '', exitCriteria: '' },
  { phase: 2, title: 'b', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
  { phase: 3, title: 'c', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
  { phase: 4, title: 'd', dependsOn: [2, 3], parallelSafe: '', repos: '', exitCriteria: '' },
];

test('layering places each phase after its deepest dependency', () => {
  const layers = layerGraph(indexGraph(ROWS));
  assert.equal(layers.get(1), 0);
  assert.equal(layers.get(2), 1);
  assert.equal(layers.get(3), 1);
  assert.equal(layers.get(4), 2);

  const layout = routeLayout(indexGraph(ROWS));
  assert.equal(layout.length, 4);
  assert.notEqual(layout.find((n) => n.phase === 2)?.row, layout.find((n) => n.phase === 3)?.row);
});

test('a cycle in the graph does not hang the layout', () => {
  const cyclic = [
    { phase: 1, title: 'a', dependsOn: [2], parallelSafe: '', repos: '', exitCriteria: '' },
    { phase: 2, title: 'b', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
  ];
  const layout = routeLayout(indexGraph(cyclic));
  assert.equal(layout.length, 2);
});

test('downstream reach and critical path measure the work that is left', () => {
  const index = indexGraph(ROWS);
  assert.deepEqual(transitiveDependents(index, 1), [2, 3, 4]);
  assert.deepEqual(transitiveDependents(index, 4), []);

  const sizing = loadSizing(flags.scriptsDir);
  const sizes = new Map<number, 'S' | 'M' | 'L'>([[1, 'S'], [2, 'L'], [3, 'S'], [4, 'M']]);
  const path = criticalPath(index, board({ 1: 'done', 2: 'ready', 3: 'ready', 4: 'waiting' }), sizes, sizing, 200_000);

  // 1 is done so it costs nothing; the heaviest remaining chain is 2 → 4.
  assert.deepEqual(path.phases, [2, 4]);
  assert.equal(path.weight, sizing.L + sizing.M);
  assert.equal(path.sessions, 1);
});

test('budgets resolve the way the engine resolves them', () => {
  const sizing = loadSizing(flags.scriptsDir);
  assert.equal(resolveBudget('claude-opus-5', sizing), sizing.budgetBig);
  assert.equal(resolveBudget('claude-haiku-4-5', sizing), sizing.budgetHaiku);
  assert.equal(resolveBudget('120000', sizing), 120_000);
  assert.equal(resolveBudget(undefined, sizing), sizing.budgetDefault);
  assert.equal(resolveBudget('something-else', sizing), sizing.budgetDefault);
});

test('plan status drops the template legend that trails many values', () => {
  assert.equal(normalisePlanStatus('complete          # active | complete | abandoned'), 'complete');
  assert.equal(normalisePlanStatus('complete — all 10 phases done'), 'complete');
  assert.equal(normalisePlanStatus('superseded'), 'superseded');
  assert.equal(normalisePlanStatus(undefined), undefined);
});

test('weekly buckets cover the requested window and land dates in it', () => {
  const week = isoWeek(new Date());
  const buckets = weeklyBuckets([new Date().toISOString().slice(0, 10)], 4);
  assert.equal(buckets.length, 4);
  assert.equal(buckets.at(-1)?.week, week);
  assert.equal(buckets.at(-1)?.count, 1);
});

test('write requests are validated before any script runs', () => {
  const opts = { root: ROOT, docsDir: join(ROOT, 'docs') };

  assert.throws(() => planWrite({ action: 'new-handoff', slug: 'Bad Slug', phase: 1, title: 'x' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'new-handoff', slug: 'ok-slug', phase: 0, title: 'x' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'new-handoff', slug: 'ok-slug', phase: 1, title: 'Not Kebab' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'qa-record', slug: 'ok-slug', phase: 1, result: 'nope', report: 'r.md' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'qa-record', slug: 'ok-slug', phase: 1, result: 'pass', report: '../escape.md' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'lock-claim', slug: 'ok-slug', phase: 1, owner: 'no-slash' }, opts), WriteError);

  const handoff = planWrite(
    { action: 'new-handoff', slug: 'ok-slug', phase: 7, title: 'front-admin-console', status: 'complete', qa: true },
    opts,
  );
  assert.equal(handoff.script, 'new-handoff.sh');
  assert.deepEqual(handoff.args, ['ok-slug', '7', 'front-admin-console', 'complete', '--qa']);

  const lock = planWrite({ action: 'lock-claim', slug: 'ok-slug', phase: 3, owner: 'me@example.com/session-1' }, opts);
  assert.deepEqual(lock.args, ['ok-slug', 'claim', '3', '--owner', 'me@example.com/session-1']);
  assert.ok(!lock.args.includes('--git'), 'the console must never pass --git');
});

test('service composes plans, detail and portfolio', { skip: !available && 'no source directory' }, async () => {
  const service = new Service(flags as never);
  const check = service.open(ROOT);
  assert.equal(check.ok, true);

  const summaries = await service.summaries();
  assert.ok(summaries.length > 20);
  // Default order is newest activity first — the list view relies on it.
  for (let i = 1; i < summaries.length; i++) {
    assert.ok(summaries[i - 1].activity >= summaries[i].activity, 'summaries must be newest first');
  }

  const withGraph = summaries.find((s) => s.kind === 'plan' && s.phases > 3)!;
  const detail = await service.detail(withGraph.slug);
  assert.ok(detail);
  assert.equal(detail!.summary.slug, withGraph.slug);
  assert.equal(detail!.phases.length, withGraph.phases);
  assert.equal(detail!.route.nodes.length, withGraph.phases);
  assert.ok(detail!.boardText.includes('Phase graph'));
  assert.ok(detail!.lint, 'lint should have run');

  // Every route edge points at a real node.
  const known = new Set(detail!.route.nodes.map((n) => n.phase));
  for (const edge of detail!.route.edges) {
    assert.ok(known.has(edge.from) && known.has(edge.to), `edge ${edge.from}→${edge.to} is dangling`);
  }

  const stats = await service.portfolio();
  assert.equal(stats.totals.phases, summaries.filter((s) => s.kind === 'plan').reduce((n, s) => n + s.phases, 0));
  assert.equal(stats.totals.ready, stats.readyQueue.length);
  assert.ok(stats.velocity.length === 26);

  const found = service.searchAll('exit criteria');
  assert.ok(found.total > 0, 'search should find something in a real plan library');
  assert.ok(found.groups[0].hits[0].snippet.length > 0);

  service.close();
});

test('a boot prompt is the engine text, unaltered', { skip: !available && 'no source directory' }, async () => {
  const service = new Service(flags as never);
  service.open(ROOT);
  const summaries = await service.summaries();
  const withReady = summaries.find((s) => s.ready.length > 0);
  if (!withReady) { service.close(); return; }

  const prompt = await service.bootPrompt(withReady.slug, withReady.ready[0]);
  assert.match(prompt, /^\/phased-execution/);
  assert.match(prompt, new RegExp(`start Phase ${withReady.ready[0]}`));
  service.close();
});
