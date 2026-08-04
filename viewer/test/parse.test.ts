import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontMatter, fmString, fmList, fmPhaseList, scalar } from '../server/parse/frontmatter.ts';
import { parsePlan, parseDependsOn } from '../server/parse/plan.ts';
import { parseHandoff, parseHandoffFilename, normaliseStatus } from '../server/parse/handoff.ts';
import { parseIndex, parseTestStatus, parseLock } from '../server/parse/folder.ts';
import { labelledBullets, sections, fences } from '../server/parse/markdown.ts';

const PLAN = `---
slug: demo-plan
created: 2026-08-02
status: active            # active | complete | abandoned
phases: 4
handoffs: docs/handoffs/demo-plan/
memory: project_demo-plan
---

# Demo Plan

> Continues from \`docs/handoffs/other/phase-03-x.md\`.

## Context

Why this exists.

## Architecture / approach

Key files by repo.

## Session budget

**Target model:** \`claude-opus-5\` (1M window) · **Budget:** ~200K weight/session · **Branch:** current branch (no new branch)
**Skills (every session):** \`api-conventions\`, \`design-system\`
**QA gate:** on

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Schema | — | — | api | tables migrated |
| 2 | Routes | 1 | 3 | api | routes green |
| **3** | Relay | 1 | 2 | aws | relay green |
| 4 | Capstone *(GATED)* | 1–3 (+2) | — | all | shipped |

**Blocking:** 1 → {2, 3} → 4
**Independent (run in any order, one at a time):** 2 ∥ 3

## Phases

### Phase 1 — Schema
- **Goal:** the tables.
- **Size:** S
- **Read first:** this plan.
- **Files:** \`app/models/x.py\`
- **Steps:** models → migration.
- **Exit criteria:**
  1. Migration round-trips.
  2. Guard lists 36 tables.
- **Verification:** \`pytest -q\`
- **Verify in:** services/api
- **Handoff must record:** revision id.

### Phase 2 — Routes
- **Goal:** the API.
- **Size:** L
- **Exit criteria:** routes enforce status sets.

### Phase 3 — Relay
- **Goal:** the relay.
- **Model:** claude-haiku-4-5

### Phase 4 — Capstone *(GATED)*
- **Goal:** ship it.
- **Size:** M
- **Gates (must clear first):** operator runs the checklist.
- **Gate-check:** date 2026-09-01

## End-to-end verification

Run the whole loop.
`;

test('front matter survives trailing legends and block lists', () => {
  const fm = parseFrontMatter(`---
status: complete          # active | complete | abandoned
phases: 10
key_files:
  - packages/api/src/one.ts
  - packages/api/src/two.ts
depends_on: [5]
blocks: [10]
skills_used: [api-conventions, design-system]
metadata:
  type: project
---
body`);
  assert.equal(fmString(fm, 'status'), 'complete');
  assert.equal(fmString(fm, 'phases'), '10');
  assert.deepEqual(fmList(fm, 'key_files'), ['packages/api/src/one.ts', 'packages/api/src/two.ts']);
  assert.deepEqual(fmPhaseList(fm, 'depends_on'), [5]);
  assert.deepEqual(fmList(fm, 'skills_used'), ['api-conventions', 'design-system']);
  assert.deepEqual(fm.values.metadata, { type: 'project' });
});

test('front matter is optional and never throws', () => {
  const fm = parseFrontMatter('# Just a document\n\nNo front matter here.');
  assert.equal(fm.lines, 0);
  assert.equal(fmString(fm, 'status'), undefined);
});

test('a value may contain a hash when no space precedes it', () => {
  assert.equal(scalar('https://x.test/a#anchor   # trailing note'), 'https://x.test/a#anchor');
});

test('dependency cells accept numbers, lists, ranges and the em-dash', () => {
  assert.deepEqual(parseDependsOn('—'), []);
  assert.deepEqual(parseDependsOn('4'), [4]);
  assert.deepEqual(parseDependsOn('4, 5'), [4, 5]);
  assert.deepEqual(parseDependsOn('1–7'), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseDependsOn('1–7 (+9–10)'), [1, 2, 3, 4, 5, 6, 7, 9, 10]);
  assert.deepEqual(parseDependsOn('after 2 and 3'), [2, 3]);
});

test('plan parse reads the graph, phases, sizes, gates and budget', () => {
  const plan = parsePlan(PLAN, 'demo-plan', '/tmp/demo-plan.md');

  assert.equal(plan.phased, true);
  assert.equal(plan.title, 'Demo Plan');
  assert.equal(plan.declaredPhases, 4);
  assert.equal(plan.status, 'complete' === plan.status ? plan.status : 'active');
  assert.equal(plan.memoryKey, 'project_demo-plan');
  assert.ok(plan.provenance?.includes('Continues from'));

  assert.equal(plan.graph.length, 4);
  assert.deepEqual(plan.graph.map((r) => r.phase), [1, 2, 3, 4]);
  assert.deepEqual(plan.graph[3].dependsOn, [1, 2, 3]);
  assert.equal(plan.graph[2].title, 'Relay');          // bold cell survives
  assert.equal(plan.graph[1].repos, 'api');

  assert.equal(plan.sessionBudget.targetModel, 'claude-opus-5');
  assert.equal(plan.sessionBudget.qaGate, 'on');
  assert.deepEqual(plan.sessionBudget.skills, ['api-conventions', 'design-system']);
  assert.match(plan.sessionBudget.branch ?? '', /current branch/);

  assert.equal(plan.phases[1].size, 'S');
  assert.equal(plan.phases[2].size, 'L');
  assert.equal(plan.phases[3].size, 'M');              // no Size bullet → default M
  assert.equal(plan.phases[3].model, 'claude-haiku-4-5');
  assert.equal(plan.phases[4].gated, true);
  assert.equal(plan.phases[1].gated, false);
  assert.match(plan.phases[4].gates ?? '', /operator runs the checklist/);
  assert.equal(plan.phases[4].gateCheck, 'date 2026-09-01');

  assert.match(plan.phases[1].exitCriteria ?? '', /Migration round-trips/);
  assert.match(plan.phases[1].exitCriteria ?? '', /Guard lists 36 tables/);
  assert.equal(plan.phases[1].verification, '`pytest -q`');
  // Two bullets whose labels share a prefix as far as "Verif". `bullet()` matches
  // on prefix, so the pair is worth pinning: neither string starts with the
  // other, and reading one into the other would run the suite in the wrong tree.
  assert.equal(plan.phases[1].verifyIn, 'services/api');
  assert.equal(plan.phases[2].verifyIn, undefined, 'a plan that says nothing means the root');
  assert.match(plan.context ?? '', /Why this exists/);
  assert.match(plan.endToEnd ?? '', /whole loop/);
  assert.equal(plan.callouts.length, 2);
});

test('a heading that covers a range of phases keeps the graph title', () => {
  const plan = parsePlan(`# T

## Phase graph

| Phase | Title | Depends on |
|---|---|---|
| 1 | crm-core (spec/runner/ingest) | — |
| 2 | vendor app import | 1 |

## Phases

### Phase 1–5 — DONE
See the earlier handoff for the record.

### Phase 2 — vendor app import
- **Goal:** the screen.
`, 'ranged', '/tmp/ranged.md');

  assert.equal(plan.phases[1].title, 'crm-core (spec/runner/ingest)');
  assert.equal(plan.phases[2].title, 'vendor app import');
});

test('a document without a phase graph parses as unphased rather than failing', () => {
  const plan = parsePlan('# Design spike\n\n## Findings\n\nNo graph here.\n', 'spike', '/tmp/spike.md');
  assert.equal(plan.phased, false);
  assert.equal(plan.graph.length, 0);
  assert.equal(plan.title, 'Design spike');
});

test('other pipe tables in a plan are never read as phase rows', () => {
  const plan = parsePlan(`# T

## Repos

| Repo | Owner |
|---|---|
| 1 | api |

## Phase graph

| Phase | Title | Depends on |
|---|---|---|
| 1 | Only phase | — |

## Risks

| 9 | something |
`, 't', '/tmp/t.md');
  assert.equal(plan.graph.length, 1);
  assert.equal(plan.graph[0].title, 'Only phase');
});

test('handoff parse reads front matter, sections and boot prompts', () => {
  const text = `---
plan: docs/plans/demo-plan.md
phase: 2
title: routes
status: complete            # complete | in-progress | blocked | pending
completed: 2026-08-01
next_phase: 3
depends_on: [1]
blocks: [4]
parallel_safe: [3]
skills_used: [api-conventions]
key_files:
  - api/routes.py
memory: project_demo-plan
---

# Phase 2 → next handoff: routes

## What this phase did

Shipped the routes.

## State now (verified)

Tests 12/12 green; committed \`abc1234\`.

## Files changed

- api/routes.py

## Key decisions / gotchas

Chose polling over SSE.

## ▶ Start next phase(s) (paste into fresh sessions)

\`\`\`
/phased-execution

Continue the "demo-plan" plan — start Phase 3 in this fresh session.
Stop + hand off when done.
\`\`\`

## Outstanding / blockers

none
`;
  const handoff = parseHandoff(text, 'demo-plan', 'phase-02-routes.md', '/tmp/x.md', { size: 10, mtimeMs: 1 });
  assert.equal(handoff.phase, 2);
  assert.equal(handoff.status, 'complete');
  assert.equal(handoff.completed, '2026-08-01');
  assert.deepEqual(handoff.dependsOn, [1]);
  assert.deepEqual(handoff.blocks, [4]);
  assert.deepEqual(handoff.keyFiles, ['api/routes.py']);
  assert.match(handoff.whatItDid ?? '', /Shipped the routes/);
  assert.match(handoff.stateNow ?? '', /abc1234/);
  assert.equal(handoff.outstanding, 'none');
  assert.equal(handoff.prompts.length, 1);
  assert.equal(handoff.prompts[0].phase, 3);
  assert.match(handoff.prompts[0].text, /^\/phased-execution/);
});

test('handoff filenames and off-roster statuses degrade safely', () => {
  assert.deepEqual(parseHandoffFilename('phase-07-cart-api-endpoint.md'),
    { phase: 7, title: 'cart-api-endpoint' });
  assert.deepEqual(parseHandoffFilename('README.md'), { title: 'README' });
  assert.equal(normaliseStatus('complete'), 'complete');
  assert.equal(normaliseStatus('COMPLETE  '), 'complete');
  assert.equal(normaliseStatus('half-done'), 'unknown');
  assert.equal(normaliseStatus(undefined), 'unknown');
});

test('INDEX, QA table and lock files parse', () => {
  const index = parseIndex(`# Handoffs — demo

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 01 | schema | complete | [phase-01-schema.md](phase-01-schema.md) |
| 02 | api | pending | TBD |
`);
  assert.deepEqual(index.map((r) => [r.phase, r.status]), [[1, 'complete'], [2, 'pending']]);
  assert.equal(index[0].link, 'phase-01-schema.md');
  assert.equal(index[1].link, undefined);

  const qa = parseTestStatus(`## QA status

| Phase | Result | Report |
|------:|--------|--------|
| 1 | waived | - |
| 2 | fail | [reports/phase-02-qa.md](reports/phase-02-qa.md) |
`);
  assert.deepEqual(qa.map((r) => [r.phase, r.result]), [[1, 'waived'], [2, 'fail']]);
  assert.equal(qa[1].report, 'reports/phase-02-qa.md');

  const future = Math.floor(Date.now() / 1000) + 600;
  const lock = parseLock(`slug=demo
phase=8
owner=me@example.com/session
host=box
claimed_at=1785622531
lease_until=${future}
`, 'phase-08.lock');
  assert.equal(lock?.phase, 8);
  assert.equal(lock?.owner, 'me@example.com/session');
  assert.equal(lock?.expired, false);

  const stale = parseLock('slug=demo\nphase=2\nowner=x\nlease_until=1000\n', 'phase-02.lock');
  assert.equal(stale?.expired, true);
});

test('markdown helpers split sections, bullets and fences', () => {
  const secs = sections('## One\n\na\n\n## Two\n\nb\n');
  assert.deepEqual(secs.map((s) => s.title), ['One', 'Two']);

  const bullets = labelledBullets(`- **Goal:** ship it.
- **Exit criteria:**
  1. first
  2. second
- plain bullet, not a field
- **Verification:** \`pytest\``);
  assert.deepEqual(bullets.map((b) => b.label), ['Goal', 'Exit criteria', 'Verification']);
  assert.match(bullets[1].body, /first[\s\S]*second/);

  const code = fences('text\n\n```bash\nrun me\n```\n');
  assert.equal(code.length, 1);
  assert.equal(code[0].code, 'run me');
});

test('a fenced code block cannot be mistaken for a heading or bullet', () => {
  const secs = sections('## Real\n\n```\n## Not a heading\n```\n\ntail\n');
  assert.equal(secs.length, 1);
  assert.match(secs[0].body, /## Not a heading/);
});
