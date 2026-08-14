/**
 * The shared recovery model — one table, every layer held to it.
 *
 * Before `shared/recovery-model.js` there were five word-books for the same
 * actions and three disagreeing halt-kind classifications. These tests are the
 * anti-drift contract: the server's classes, the client's re-exports and the
 * shared arrays must be THE SAME OBJECTS (import identity, not equal copies),
 * every kind must have a profile, every action must say what it costs, and the
 * widened never-empty invariant must hold across the whole status × flag grid.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before any ../server import
// resolves the real directories.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_VOCAB, FLAG_OFF, HALT_KINDS, KIND_PROFILE, MECHANISMS, RECOVERY_BLURBS,
  RECOVERY_BUSY, RECOVERY_CLASSES, RECOVERY_LABELS, RECOVERY_TITLES,
  classifyPhase, classifyRun, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { RECOVERY_CLASSES as SERVER_CLASSES, RECOVERY_TITLES as SERVER_TITLES } from '../server/recovery.ts';
import { autoRecoveryClass } from '../server/service.ts';

/* ------------------------------------------------------------------ *
 * Parity by identity
 * ------------------------------------------------------------------ */

test('the server re-exports the SAME class array and title table', async () => {
  assert.equal(SERVER_CLASSES, RECOVERY_CLASSES);
  assert.equal(SERVER_TITLES, RECOVERY_TITLES);
});

test('the client re-exports the SAME model objects', async () => {
  const client = await import('../client/src/lib/recovery.ts');
  assert.equal(client.RECOVERY_CLASSES, RECOVERY_CLASSES);
  assert.equal(client.RECOVERY_LABELS, RECOVERY_LABELS);
  assert.equal(client.RECOVERY_BLURBS, RECOVERY_BLURBS);
  assert.equal(client.KIND_PROFILE, KIND_PROFILE);
  // The classifiers are typed wrappers, not the same function objects — hold
  // them to the same ANSWERS instead.
  assert.equal(
    client.classifyRun({ status: 'halted', halt: { reason: 'x', kind: 'verify-failed' } }),
    classifyRun({ status: 'halted', halt: { reason: 'x', kind: 'verify-failed' } }),
  );
});

/* ------------------------------------------------------------------ *
 * Table completeness
 * ------------------------------------------------------------------ */

test('every halt kind has a profile, and no profile is for an unknown kind', () => {
  assert.deepEqual(Object.keys(KIND_PROFILE).sort(), [...HALT_KINDS].sort());
  for (const kind of HALT_KINDS) {
    const profile = KIND_PROFILE[kind];
    assert.equal(typeof profile.sessionShaped, 'boolean', kind);
    if (profile.humanClass) assert.ok(RECOVERY_CLASSES.includes(profile.humanClass), kind);
    if (profile.autoClass) assert.ok(RECOVERY_CLASSES.includes(profile.autoClass), kind);
  }
});

test('every class has a title, a label naming the mechanism, and a blurb naming the cost', () => {
  for (const cls of RECOVERY_CLASSES) {
    assert.ok(RECOVERY_TITLES[cls]?.length > 5, cls);
    assert.match(RECOVERY_LABELS[cls], /new agent/, `${cls} label must say it is a NEW agent`);
    assert.ok(RECOVERY_BLURBS[cls].length > 60, cls);
    assert.match(RECOVERY_BLURBS[cls], /Costs a full session/, `${cls} blurb must state the cost`);
    assert.match(RECOVERY_BLURBS[cls], /Agent tab/, `${cls} blurb must say where to watch it`);
  }
});

test('every deterministic action has a mechanism from the table and a real blurb', () => {
  for (const [id, vocab] of Object.entries(ACTION_VOCAB)) {
    assert.ok(vocab.label.length > 2, id);
    assert.ok(vocab.blurb.length > 30, `${id} must say exactly what will happen`);
    assert.ok(vocab.mechanism in MECHANISMS, `${id} names an unknown mechanism`);
  }
});

/* ------------------------------------------------------------------ *
 * The widened never-empty invariant
 * ------------------------------------------------------------------ */

test('an unfinished phase always yields a way forward, whatever the flags say', () => {
  const statuses = ['failed', 'interrupted', 'parked', 'awaiting-verification', 'pending', 'verifying', 'queued', 'gated', 'waiting'];
  for (const status of statuses) {
    for (const resumable of [true, false]) {
      for (const allowRun of [true, false]) {
        for (const allowAgent of [true, false]) {
          const actions = recoveryActionsFor({
            record: { status, resumable },
            flags: { allowRun, allowAgent, allowWrites: false },
          });
          assert.ok(actions.length > 0, `${status}/${resumable}/${allowRun}/${allowAgent} is a dead end`);
          // Flags disable, never hide: with runs off, the run-flagged actions
          // are still there carrying the exact sentence that says why.
          if (!allowRun) {
            const gated = actions.find((a) => a.flag === 'run');
            assert.ok(gated, status);
            assert.equal(gated?.disabledReason, FLAG_OFF.run);
          }
        }
      }
    }
  }
  assert.deepEqual(recoveryActionsFor({ record: { status: 'done' } }), []);
  assert.deepEqual(recoveryActionsFor({ record: { status: 'skipped' } }), []);
  assert.deepEqual(recoveryActionsFor({ boardState: 'done', record: { status: 'failed' } }), []);
});

/* ------------------------------------------------------------------ *
 * Grouping rules
 * ------------------------------------------------------------------ */

test('a session-shaped halt leads with the phase\'s own session', () => {
  const actions = recoveryActionsFor({
    record: { status: 'failed', resumable: true },
    run: { status: 'halted', halt: { reason: 'phase 2 did not verify', kind: 'verify-failed', phase: 2 } },
  });
  assert.equal(actions[0].id, 'closeout');
  assert.equal(actions[0].group, 'primary');
  const agent = actions.find((a) => a.id === 'fix-agent');
  assert.equal(agent?.recoveryClass, 'halted-verification');
  const retry = actions.find((a) => a.id === 'retry');
  assert.equal(retry?.group, 'overflow', 'retry never leads while a session survives');
});

test('phase-blocked NEVER offers closeout — resume-with-words leads instead', () => {
  // Twelve real halts and four looping closeout sessions taught this: the
  // handoff EXISTS and says blocked; "finish the paperwork" is the wrong ask.
  const actions = recoveryActionsFor({
    record: { status: 'failed', resumable: true },
    run: { status: 'halted', halt: { reason: 'phase 2 declared itself blocked: CI is down', kind: 'phase-blocked', phase: 2 } },
  });
  assert.ok(!actions.some((a) => a.id === 'closeout'), 'no closeout on a declared blocker');
  assert.equal(actions[0].id, 'resume');
  assert.equal(actions[0].group, 'primary');
  const agent = actions.find((a) => a.id === 'fix-agent');
  assert.equal(agent?.recoveryClass, 'plan-repair');
  assert.equal(agent?.group, 'overflow');
});

test('an MCP preflight park leads with continue-without-servers', () => {
  const actions = recoveryActionsFor({
    record: { status: 'parked', resumable: false },
    run: { status: 'parked', halt: { reason: 'every ready phase is parked on MCP servers', kind: 'mcp-preflight' } },
  });
  assert.equal(actions[0].id, 'mcp-continue');
  assert.equal(actions[0].group, 'primary');
  assert.ok(!actions.some((a) => a.id === 'fix-agent'), 'no agent can sign a server in');
});

test('a live recovery disables BOTH AI families with the same sentence', () => {
  const actions = recoveryActionsFor({
    record: { status: 'failed', resumable: true },
    run: { status: 'halted', halt: { reason: 'did not verify', kind: 'verify-failed', phase: 2 } },
    live: { recoverySessionId: 'sess-1' },
  });
  const closeout = actions.find((a) => a.id === 'closeout');
  const agent = actions.find((a) => a.id === 'fix-agent');
  assert.equal(closeout?.disabledReason, RECOVERY_BUSY);
  assert.equal(agent?.disabledReason, RECOVERY_BUSY);
});

test('run-only surfaces get continue + the classified agent + dismiss', () => {
  const actions = recoveryActionsFor({
    run: { status: 'halted', halt: { reason: 'x', kind: 'verify-failed', phase: 1 } },
  });
  assert.deepEqual(actions.map((a) => a.id), ['continue-run', 'fix-agent', 'dismiss']);
});

test('a bare expired lock offers release then takeover; a live one only force-release', () => {
  const expired = recoveryActionsFor({ lock: { holder: 'somebody@host', expired: true } });
  assert.deepEqual(expired.map((a) => a.id), ['release', 'fix-agent']);
  assert.equal(expired[1].recoveryClass, 'stale-claim-takeover');
  const live = recoveryActionsFor({ lock: { holder: 'somebody@host', expired: false } });
  assert.deepEqual(live.map((a) => a.id), ['force-release']);
});

/* ------------------------------------------------------------------ *
 * Classification through the one table
 * ------------------------------------------------------------------ */

test('classifyRun reads the profile: dedicated remedies beat the generic resume', () => {
  const run = (kind, status = 'halted') =>
    ({ status, halt: { reason: 'phase 2 stopped', kind } });
  assert.equal(classifyRun(run('verify-failed')), 'halted-verification');
  assert.equal(classifyRun(run('no-handoff')), 'halted-missing-handoff');
  // A budget halt's fix is Continue, not an agent told to "carry the phase".
  assert.equal(classifyRun(run('budget')), undefined);
  assert.equal(classifyRun(run('models-exhausted')), undefined);
  assert.equal(classifyRun(run('needs-human')), undefined);
  assert.equal(classifyRun(run('phase-blocked')), undefined);
  assert.equal(classifyRun(run('mcp-preflight', 'parked')), undefined);
  assert.equal(classifyRun(run('verification-preflight', 'parked')), 'plan-repair');
  // Old kindless records keep the word-matching and the generic fallback.
  assert.equal(classifyRun({ status: 'halted', halt: { reason: 'no handoff was written' } }), 'halted-missing-handoff');
  assert.equal(classifyRun({ status: 'halted', halt: { reason: 'something odd' } }), 'interrupted-resume');
  assert.equal(classifyRun({ status: 'interrupted', halt: null }), 'interrupted-resume');
  assert.equal(classifyRun({ status: 'halted', halt: null }, { authFailure: true }), 'auth-interrupted');
});

test('classifyPhase prefers the halt kind over word-matching', () => {
  const run = { status: 'halted', halt: { reason: 'phase 2 declared itself blocked: x', kind: 'phase-blocked' } };
  assert.equal(classifyPhase('failed', run), undefined);
  assert.equal(classifyPhase('failed', { status: 'halted', halt: { reason: 'did not verify', kind: 'verify-failed' } }), 'halted-verification');
  assert.equal(classifyPhase('done', null), undefined);
});

/* ------------------------------------------------------------------ *
 * The unattended classifier — record-aware
 * ------------------------------------------------------------------ */

test('a no-handoff halt with RED verification is classed as the verification failure it is', () => {
  const halt = { reason: 'ended cleanly but the board still reads ready', kind: 'no-handoff' };
  assert.equal(autoRecoveryClass(halt, 'halted', { verification: { ok: false } }), 'halted-verification');
  assert.equal(autoRecoveryClass(halt, 'halted', { verification: { ok: true } }), 'halted-missing-handoff');
  assert.equal(autoRecoveryClass(halt, 'halted'), 'halted-missing-handoff');
});

test('new kinds stay out of the unattended loop; unknown named kinds answer null', () => {
  const halt = (kind) => ({ reason: 'x', kind });
  for (const kind of ['phase-blocked', 'run-preflight', 'orphaned-session', 'recovery-failed', 'runner-crashed', 'mcp-preflight']) {
    assert.equal(autoRecoveryClass(halt(kind), 'halted'), null, kind);
  }
  assert.equal(autoRecoveryClass(halt('some-future-kind'), 'halted'), null);
  // Kindless records: only the two unmistakable sentences, strictly.
  assert.equal(autoRecoveryClass({ reason: 'phase 2 did not verify' }, 'halted'), 'halted-verification');
  assert.equal(autoRecoveryClass({ reason: 'a §Verification note' }, 'halted'), null,
    'the loose OFFER regex must not drive the unattended loop');
});

test('a board-stuck phase with no record gets the plan repair — and a plan failing lint gets its own', () => {
  const stuck = recoveryActionsFor({ boardState: 'stuck' });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].id, 'fix-agent');
  assert.equal(stuck[0].recoveryClass, 'plan-repair');
  assert.equal(stuck[0].group, 'primary');

  const lint = recoveryActionsFor({ planIssues: true });
  assert.equal(lint[0]?.recoveryClass, 'plan-repair');
});
