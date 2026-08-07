/**
 * Approving a gate — the write path.
 *
 * A `manual` gate used to be a wall with no door: the runner parked the phase
 * and the only way through was hand-editing the plan. The Gate card's POST
 * writes a clearance row (`gate-approve.sh` → docs/handoffs/<slug>/gate-status.md)
 * that `--gate-status` honours for EVERY gate kind, and the service reports the
 * POSTCONDITION read back from the engine, never the script's exit code.
 *
 * What this pins: approve flips the live verdict to clear; revoke restores the
 * gate; writes-off refuses with the standard sentence; the request validation
 * refuses hostile `by` strings; and the sidecar file never flips QA gating on
 * (it is deliberately not test-status.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every state-dir consumer this pulls in reads these at module load, so they
// have to be redirected before the imports below.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-gate-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { planWrite, WriteError } = await import('../server/writes.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

const PLAN = `---
slug: SLUG
created: 2026-08-01
status: active
phases: 3
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | manual-gated | — | — | app | it works |
| 2 | ai-gated | — | — | app | it works |
| 3 | open | — | — | app | it works |

## Phases

### Phase 1 — manual-gated *(GATED)*
- **Gates (must clear first):**
  1. mint the fixture keys in the admin panel
  2. export them into the operator env
- **Gate-check:** manual operator keys exported
- **Size:** S

### Phase 2 — ai-gated *(GATED)*
- **Gates (must clear first):** staging deployed and smoke tests green
- **Gate-check:** ai verify staging deploy and smoke tests
- **Size:** S

### Phase 3 — open
- **Size:** S
`;

function library(slug: string) {
  const root = mkdtempSync(join(tmpdir(), 'pc-gate-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function service(t: { after(fn: () => void): void }, root: string, overrides: Record<string, unknown> = {}) {
  const svc = new Service({ ...flags, ...overrides } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

/* ------------------------------------------------------------------ *
 * The end-to-end write
 * ------------------------------------------------------------------ */

test('approving a manual gate flips the live verdict to clear, revoking restores it', async (t) => {
  const lib = library('gatey');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);

  const before = await svc.gateStatus('gatey', 1);
  assert.equal(before?.clear, false);
  assert.equal(before?.kind, 'manual');

  const approved = await svc.approveGate('gatey', 1, { approve: true, by: 'operator', note: 'keys minted + exported' });
  assert.equal(approved.ok, true, approved.detail);
  assert.equal(approved.gate?.clear, true);
  assert.match(approved.gate?.detail ?? '', /approved by operator/);

  const file = join(lib.root, 'docs', 'handoffs', 'gatey', 'gate-status.md');
  assert.ok(existsSync(file), 'the clearance sidecar exists');
  assert.match(readFileSync(file, 'utf8'), /\| 1 \| yes \| operator \| \d{4}-\d{2}-\d{2} \| keys minted \+ exported \|/);
  // The sidecar is NOT the QA table — recording an approval must not flip QA on.
  assert.ok(!existsSync(join(lib.root, 'docs', 'handoffs', 'gatey', 'test-status.md')));
  assert.equal((await svc.qaMode('gatey')).mode, 'off');

  const revoked = await svc.approveGate('gatey', 1, { approve: false, by: 'operator' });
  assert.equal(revoked.ok, true, revoked.detail);
  assert.equal(revoked.gate?.clear, false);
  assert.equal(revoked.gate?.kind, 'manual');
});

test('an ai gate is approvable too — both categories share the one door', async (t) => {
  const lib = library('aigate');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);

  const before = await svc.gateStatus('aigate', 2);
  assert.equal(before?.clear, false);
  assert.equal(before?.kind, 'ai');
  assert.match(before?.detail ?? '', /verify staging deploy/);

  const approved = await svc.approveGate('aigate', 2, { approve: true, by: 'phase-2-session' });
  assert.equal(approved.ok, true, approved.detail);
  assert.equal(approved.gate?.clear, true);
});

test('with writes off the answer is the standard refusal, and nothing is written', async (t) => {
  const lib = library('frozen');
  t.after(lib.cleanup);
  const svc = service(t, lib.root, { allowWrites: false });

  const outcome = await svc.approveGate('frozen', 1, { approve: true });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /Writes are disabled/);
  assert.ok(!existsSync(join(lib.root, 'docs', 'handoffs', 'frozen', 'gate-status.md')));
});

test('the gateKind travels on the phase view', async (t) => {
  const lib = library('kinds');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);

  const detail = await svc.detail('kinds');
  const kinds = Object.fromEntries(detail!.phases.map((p) => [p.phase, p.gateKind]));
  assert.deepEqual(kinds, { 1: 'human', 2: 'ai', 3: 'none' });
});

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

test('planWrite builds the exact argv, and refuses hostile input', () => {
  const opts = { root: '/x' };
  assert.deepEqual(
    planWrite({ action: 'gate-approve', slug: 'demo', phase: 3, by: 'op', reason: 'done' }, opts).args,
    ['demo', '3', '--by', 'op', '--note', 'done'],
  );
  assert.deepEqual(
    planWrite({ action: 'gate-approve', slug: 'demo', phase: 3, revoke: true }, opts).args,
    ['demo', '3', '--revoke'],
  );
  assert.throws(
    () => planWrite({ action: 'gate-approve', slug: 'demo', phase: 3, by: '--revoke' }, opts),
    WriteError,
    'an option-shaped by must not become an argv flag',
  );
  assert.throws(() => planWrite({ action: 'gate-approve', slug: 'demo', phase: 0 }, opts), WriteError);
  assert.throws(() => planWrite({ action: 'gate-approve', slug: 'Bad Slug', phase: 1 }, opts), WriteError);
});
