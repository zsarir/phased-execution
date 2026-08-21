/**
 * healthIssues — the verification-unrunnable kind.
 *
 * The issue is what makes a verification park repairable at all:
 * `resolveRecovery` refuses a plan-repair whose plan has no error-or-warning
 * issues, so this kind existing is a hard prerequisite for the self-heal path.
 * Scoping is the other half: a DONE phase's proof is its handoff, and a CLOSED
 * plan is nobody's to-do list — neither may nag.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePlan } from '../server/parse/plan.ts';
import { healthIssues, PROGRESS_ISSUE_KINDS } from '../server/analysis/stats.ts';

const PLAN_TEXT = (status: string) => `---
slug: hv
created: 2026-08-07
status: ${status}
phases: 3
---

# hv

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | nested | — | — | app | green |
| 2 | prose | 1 | — | app | green |
| 3 | bare | 2 | — | app | shipped |

## Phases

### Phase 1 — nested
- **Size:** S
- **Verification:**
  - \`npm test\`

### Phase 2 — prose
- **Size:** S
- **Verification:** eyeball the dashboard by hand.

### Phase 3 — bare
- **Size:** S
`;

function ctx(status: string, done: number[]) {
  const plan = parsePlan(PLAN_TEXT(status), 'hv', '/tmp/hv.md');
  const record = {
    slug: 'hv', kind: 'plan', plan, handoffs: [], index: [], qa: [], locks: [],
    handoffDir: '/tmp/hv-handoffs', revision: 1,
  } as never;
  const board = {
    phased: true, states: {}, done, inProgress: [], stuck: [], ready: [], waiting: [],
  } as never;
  return { record, board, qaMode: { mode: 'off' } } as never;
}

test('a phase without runnable verification is a warning, scoped away from done phases and closed plans', () => {
  const open = healthIssues(ctx('active', []))
    .filter((issue) => issue.kind === 'verification-unrunnable');
  // Phase 1's nested sub-bullet IS runnable (the shape that used to read as
  // "no verification"); phases 2 and 3 fail for their own distinct reasons.
  assert.deepEqual(open.map((issue) => issue.phase), [2, 3]);
  assert.ok(open.every((issue) => issue.severity === 'warning'));
  assert.match(open[0].message, /yields nothing the runner can execute/);
  assert.match(open[1].message, /has no §Verification/);

  // A done phase's proof is its handoff — no nag.
  const withDone = healthIssues(ctx('active', [3]))
    .filter((issue) => issue.kind === 'verification-unrunnable');
  assert.deepEqual(withDone.map((issue) => issue.phase), [2]);

  // Closure silences it entirely — the kind rides the same PROGRESS mechanism
  // every other done-with-this-plan issue does.
  assert.ok(PROGRESS_ISSUE_KINDS.has('verification-unrunnable'));
  const closed = healthIssues(ctx('complete', []))
    .filter((issue) => issue.kind === 'verification-unrunnable');
  assert.equal(closed.length, 0);
});

test('a done record over a not-done board is a record-ahead-of-board warning — once per phase, on the newest run, dropped by closure', () => {
  const runs = [
    { id: 'r2', status: 'halted', phases: { '2': { phase: 2, status: 'done' } } },
    { id: 'r1', status: 'finished', phases: { '2': { phase: 2, status: 'done' }, '3': { phase: 3, status: 'done' } } },
  ];
  const open = healthIssues({ ...(ctx('active', []) as object), runs } as never)
    .filter((issue) => issue.kind === 'record-ahead-of-board');
  assert.deepEqual(open.map((issue) => [issue.phase, issue.severity]), [[2, 'warning'], [3, 'warning']]);
  assert.match(open[0].message, /run r2/, 'the newest run that says so is the one named');
  // The board catching up ends it; a closed plan drops it with the other progress kinds.
  assert.equal(healthIssues({ ...(ctx('active', [2, 3]) as object), runs } as never)
    .filter((issue) => issue.kind === 'record-ahead-of-board').length, 0);
  assert.equal(healthIssues({ ...(ctx('complete', []) as object), runs } as never)
    .filter((issue) => issue.kind === 'record-ahead-of-board').length, 0);
  assert.ok(PROGRESS_ISSUE_KINDS.has('record-ahead-of-board'));
  // And no runs at all is no issue, never a throw.
  assert.equal(healthIssues(ctx('active', [])).filter((issue) => issue.kind === 'record-ahead-of-board').length, 0);
});
