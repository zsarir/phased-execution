/**
 * A closed plan goes quiet — the server half.
 *
 * Nothing read a plan's own `status:` field. A plan marked `complete` months ago
 * still reported "phase 10 QA recorded fail — dependents stay blocked" as an
 * error, still counted its unfinished phases into "work remaining", still
 * offered its phases as ready, and would still have pushed a notification about
 * one landing. The plan said it was over; every surface disagreed.
 *
 * Closure is one predicate — a terminal status — read once per language:
 * `plan_is_closed()` in `scripts/phase-graph.sh`, `isClosedStatus()` here. What
 * follows checks the four things the console does with it: it stops reporting
 * progress problems, it stops counting the plan as work, it stops announcing it,
 * and it can close and reopen a plan through the same scripts an operator would
 * run by hand.
 *
 * What it must NOT do is hide anything: a closed plan with a broken graph still
 * says so, demoted to `info`. The one thing worse than a noisy plan is an
 * invisible broken one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every state-dir consumer this pulls in reads these at module load, so they
// have to be redirected before the imports below.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-closure-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { planWrite, runWrite, WriteError } = await import('../server/writes.ts');
const { isClosedStatus, CLOSED_STATUSES } = await import('../server/analysis/stats.ts');
const { run } = await import('../server/engine.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

/* ------------------------------------------------------------------ *
 * The predicate
 * ------------------------------------------------------------------ */

test('closed is a terminal status, and nothing else', () => {
  for (const status of CLOSED_STATUSES) assert.equal(isClosedStatus(status), true, status);

  for (const open of ['active', 'backlog', 'approved', 'proposal', 'prepared-awaiting-outreach', '✅']) {
    assert.equal(isClosedStatus(open), false, open);
  }
  assert.equal(isClosedStatus(undefined), false, 'a plan with no status is open, not closed');
  assert.equal(isClosedStatus(''), false);
});

test('the legend most plans carry does not change the reading', () => {
  // Scaffolded plans keep the template's comment: `status: active   # active | complete | …`
  assert.equal(isClosedStatus('complete            # complete | abandoned'), true);
  assert.equal(isClosedStatus('active            # active | complete | abandoned'), false,
    'the word "complete" inside the legend must not close an active plan');
  assert.equal(isClosedStatus('Abandoned'), true, 'case is not part of the decision');
  assert.equal(isClosedStatus('  superseded  '), true);
});

/* ------------------------------------------------------------------ *
 * A library to close things in
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: SLUG
created: 2026-08-01
status: STATUS
phases: 2
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | it works |
| 2 | second | 1 | — | app | it still works |

## Phases

### Phase 1 — first
- **Size:** S

### Phase 2 — second
- **Size:** S
`;

const HANDOFF = `---
plan: docs/plans/SLUG.md
phase: 1
title: first
status: HSTATUS
completed: 2026-08-01
next_phase: 2
depends_on: []
blocks: [2]
parallel_safe: []
skills_used: []
key_files: []
memory: project_SLUG
---

# Phase 1 → next handoff: first

## What this phase did
Enough of it to be a handoff.

## State now (verified)
Committed.

## Files changed
None worth naming.

## Key decisions / gotchas
None.

## ▶ Start next phase(s) (paste into fresh sessions)
See the plan.

## Outstanding / blockers
None.
`;

type Library = { root: string; cleanup(): void };

function library(): Library {
  const root = mkdtempSync(join(tmpdir(), 'pc-closure-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A plan with a phase 1 handoff stuck at `blocked` — an `error` on any open plan. */
function addStuckPlan(root: string, slug: string, status: string): void {
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug).replace('STATUS', status));
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-01-first.md`), HANDOFF.replaceAll('SLUG', slug).replace('HSTATUS', 'blocked'));
}

/** A plan whose phase 1 is done — so phase 2 is genuinely ready. */
function addReadyPlan(root: string, slug: string, status: string): void {
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug).replace('STATUS', status));
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-01-first.md`), HANDOFF.replaceAll('SLUG', slug).replace('HSTATUS', 'complete'));
}

/**
 * A live Service on a scratch library — and its teardown, registered here so it
 * cannot be forgotten. An open Service holds a file watcher, and a watcher
 * nobody closed keeps the whole test runner alive after the last assertion.
 */
function service(t: { after(fn: () => void): void }, root: string) {
  const svc = new Service(flags as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

/* ------------------------------------------------------------------ *
 * What a closed plan stops saying
 * ------------------------------------------------------------------ */

test('a closed plan reports no progress problems, and an open one still does', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addStuckPlan(lib.root, 'open-plan', 'active');
  addStuckPlan(lib.root, 'shut-plan', 'abandoned');

  const svc = service(t, lib.root);
  const summaries = await svc.summaries();
  const open = summaries.find((s) => s.slug === 'open-plan')!;
  const shut = summaries.find((s) => s.slug === 'shut-plan')!;

  assert.equal(open.closed, false);
  assert.equal(shut.closed, true);

  // The same file, the same blocked handoff, two different readings.
  assert.ok(open.issues.some((i) => i.kind === 'stale-handoff' && i.severity === 'error'),
    'an open plan with a blocked handoff is an error');
  assert.deepEqual(shut.issues.filter((i) => i.kind === 'stale-handoff'), [],
    'a closed plan does not report a handoff nobody is coming back to');

  // And the counts every attention surface reads follow it.
  assert.equal(open.issueCounts.error > 0, true);
  assert.equal(shut.issueCounts.error, 0);
  assert.equal(shut.issueCounts.warning, 0);

  // The board itself stays honest: closing quiets the warnings, it does not
  // pretend the phase landed.
  assert.deepEqual(shut.stuck, [1], 'the board still says phase 1 never finished');
});

test('a closed plan keeps its structural damage, demoted to info', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  // `phases: 2` in the front matter, one row in the table — real corruption.
  const broken = PLAN.replaceAll('SLUG', 'broken-plan').replace('STATUS', 'superseded')
    .replace('| 2 | second | 1 | — | app | it still works |\n', '');
  writeFileSync(join(lib.root, 'docs', 'plans', 'broken-plan.md'), broken);

  const svc = service(t, lib.root);
  const [summary] = await svc.summaries();

  const counts = summary.issues.filter((i) => i.kind === 'phase-count');
  assert.equal(counts.length, 1, 'a broken closed plan is still reported');
  assert.equal(counts[0].severity, 'info', 'demoted, never dropped');
  assert.equal(summary.issueCounts.error, 0);
});

test('a closed plan is not work: no ready queue, no remaining weight, not stalled', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addReadyPlan(lib.root, 'live-plan', 'active');
  addReadyPlan(lib.root, 'done-plan', 'complete');

  const svc = service(t, lib.root);
  const view = await svc.portfolio();

  assert.equal(view.totals.plans, 2);
  assert.equal(view.totals.closed, 1);
  assert.equal(view.totals.ready, 1, 'only the open plan offers work');
  assert.deepEqual(view.readyQueue.map((r) => r.slug), ['live-plan']);
  assert.equal(view.totals.ready, view.readyQueue.length,
    'the tile and the queue are the same claim and must agree');
  assert.equal(view.stalled.some((s) => s.slug === 'done-plan'), false);

  // The census still counts it — closing a plan does not delete its history.
  assert.equal(view.totals.phases, 4);
  assert.equal(view.totals.done, 2);
  assert.ok(view.byStatus.some((b) => b.status === 'complete' && b.closed === true));
  assert.ok(view.byStatus.some((b) => b.status === 'active' && b.closed === false));
});

/* ------------------------------------------------------------------ *
 * What a closed plan stops doing
 * ------------------------------------------------------------------ */

test('no notification fires for a closed plan, and one still does for an open plan', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addReadyPlan(lib.root, 'live-plan', 'active');
  addReadyPlan(lib.root, 'done-plan', 'complete');

  const svc = service(t, lib.root);
  // `run:phase` is what the runner emits as each phase lands; the announcer
  // behind it had no status check at all.
  const emit = (svc as unknown as { onRunnerEvent(event: string, data: unknown): void });
  emit.onRunnerEvent('run:phase', { slug: 'done-plan', phase: 1, status: 'done' });
  emit.onRunnerEvent('run:phase', { slug: 'live-plan', phase: 1, status: 'done' });

  const slugs = svc.inbox({} as never).items.map((i: { slug?: string }) => i.slug);
  assert.deepEqual(slugs, ['live-plan'], `a closed plan announced itself: ${JSON.stringify(slugs)}`);
});

test('repairing a closed plan is refused, and says to reopen it', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addStuckPlan(lib.root, 'shut-plan', 'abandoned');

  const svc = service(t, lib.root);
  const outcome = await (svc as unknown as {
    resolveRecovery(request: unknown): Promise<{ ok: boolean; status?: number; error?: string }>;
  }).resolveRecovery({ class: 'plan-repair', slug: 'shut-plan' });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.match(String(outcome.error), /closed/);
  assert.match(String(outcome.error), /reopen/i);
});

/* ------------------------------------------------------------------ *
 * The write verb
 * ------------------------------------------------------------------ */

test('close and reopen map to exactly the argv close-plan.sh documents', () => {
  const opts = { root: '/x' };

  const closed = planWrite({ action: 'close-plan', slug: 'demo', status: 'superseded', reason: 'folded into v2' }, opts);
  assert.equal(closed.script, 'close-plan.sh');
  assert.deepEqual(closed.args, ['demo', '--status', 'superseded', '--reason', 'folded into v2']);

  const reopened = planWrite({ action: 'reopen-plan', slug: 'demo' }, opts);
  assert.equal(reopened.script, 'close-plan.sh');
  assert.deepEqual(reopened.args, ['demo', '--reopen']);

  // `abandoned` is the default because closing is usually giving up, not finishing.
  assert.deepEqual(planWrite({ action: 'close-plan', slug: 'demo', reason: 'x' }, opts).args,
    ['demo', '--status', 'abandoned', '--reason', 'x']);
});

test('the write verb refuses what the script would refuse, in words', () => {
  const opts = { root: '/x' };

  // `active` is not a closed status — reopening is its own action.
  assert.throws(() => planWrite({ action: 'close-plan', slug: 'demo', status: 'active', reason: 'x' }, opts),
    (error: Error) => error instanceof WriteError && /reopen/i.test(error.message));
  assert.throws(() => planWrite({ action: 'close-plan', slug: 'demo', status: 'sleeping', reason: 'x' }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'close-plan', slug: 'Not A Slug', reason: 'x' }, opts), WriteError);

  // A closed plan with no reason tells the next reader nothing.
  assert.throws(() => planWrite({ action: 'close-plan', slug: 'demo' }, opts), WriteError);
  assert.deepEqual(planWrite({ action: 'close-plan', slug: 'demo', force: true }, opts).args,
    ['demo', '--status', 'abandoned', '--force']);
});

test('a reason is one line, without the comment marker every reader strips', () => {
  const messy = 'shipped\nas # v2\t— see\r\nthe    other plan';
  const plan = planWrite({ action: 'close-plan', slug: 'demo', reason: messy }, { root: '/x' });
  const reason = plan.args[plan.args.indexOf('--reason') + 1];

  assert.equal(reason, 'shipped as v2 — see the other plan');
  assert.equal(/[\r\n\t#]/.test(reason), false);

  const long = planWrite({ action: 'close-plan', slug: 'demo', reason: 'w'.repeat(500) }, { root: '/x' });
  assert.equal(long.args[long.args.indexOf('--reason') + 1].length, 200);
});

test('close then reopen round-trips through the real script, and bash agrees', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addReadyPlan(lib.root, 'demo', 'active');
  const planFile = join(lib.root, 'docs', 'plans', 'demo.md');
  const engine = { scriptsDir: SCRIPTS, root: lib.root };
  const closedPerBash = async () => (await run(engine, 'phase-graph.sh', ['demo', '--closed'])).code === 0;
  const readyPerBash = async () => (await run(engine, 'phase-graph.sh', ['demo', '--ready'])).stdout.trim();

  assert.equal(await closedPerBash(), false, 'the fixture starts open');
  assert.equal(await readyPerBash(), '2', 'and offers phase 2');

  const closing = planWrite({ action: 'close-plan', slug: 'demo', status: 'abandoned', reason: 'the idea did not survive contact' }, { root: lib.root });
  const closeOutcome = await runWrite(closing, { scriptsDir: SCRIPTS, root: lib.root });
  assert.equal(closeOutcome.ok, true, closeOutcome.stderr);

  const afterClose = readFileSync(planFile, 'utf8');
  assert.match(afterClose, /^status: abandoned$/m);
  assert.match(afterClose, /^closed: \d{4}-\d{2}-\d{2}$/m);
  assert.match(afterClose, /^closed_reason: the idea did not survive contact$/m);

  assert.equal(await closedPerBash(), true, 'the engine reads the same file the console wrote');
  assert.equal(await readyPerBash(), '', 'and stops offering work');

  // The console's own reading agrees — this is the parity that matters, since
  // every board the UI draws comes from the JS side.
  const svc = service(t, lib.root);
  assert.equal((await svc.summaries())[0].closed, true);
  assert.equal((await svc.summaries())[0].closedReason, 'the idea did not survive contact');

  const reopenOutcome = await runWrite(
    planWrite({ action: 'reopen-plan', slug: 'demo' }, { root: lib.root }),
    { scriptsDir: SCRIPTS, root: lib.root },
  );
  assert.equal(reopenOutcome.ok, true, reopenOutcome.stderr);

  const afterReopen = readFileSync(planFile, 'utf8');
  assert.match(afterReopen, /^status: active$/m);
  assert.equal(/^closed:/m.test(afterReopen), false, 'reopening clears the closure, it does not layer on it');
  assert.equal(/^closed_reason:/m.test(afterReopen), false);
  assert.equal(await closedPerBash(), false);
  assert.equal(await readyPerBash(), '2', 'and the work comes back');
});

test('a dry run says exactly what would be run, and runs nothing', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addReadyPlan(lib.root, 'demo', 'active');
  const before = readFileSync(join(lib.root, 'docs', 'plans', 'demo.md'), 'utf8');

  // What `POST /api/write?dry=1` answers with: the plan, never the run.
  const plan = planWrite({ action: 'close-plan', slug: 'demo', status: 'complete', reason: 'shipped' }, { root: lib.root });
  assert.equal(`${plan.script} ${plan.args.join(' ')}`, 'close-plan.sh demo --status complete --reason shipped');
  assert.match(plan.description, /Close demo as complete — shipped/);

  assert.equal(readFileSync(join(lib.root, 'docs', 'plans', 'demo.md'), 'utf8'), before,
    'planning a write must never perform one');
});
