/**
 * The paragraph a retried phase reads before it starts over.
 *
 * Every case here is a shape the run record actually takes: a verification that
 * ran and failed, one that could not be run at all, a plan that stopped linting,
 * a session that explained itself on the way out. The assertions are about what
 * survives — because the whole point of the insert is that the ONE fact worth
 * paying attention to (which command, what it printed) is still there after the
 * trimmer has done its work.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, hostname, userInfo } from 'node:os';

import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, MAX_BRIEF_BYTES, MAX_FAILURE_CONTEXT_BYTES,
} from '../server/runner/failure-context.ts';

const red = (partial: Record<string, unknown> = {}) => ({
  phase: 4,
  attempts: 1,
  verification: {
    ok: false,
    reason: '`npm test` exited 1',
    ran: [{ command: 'npm test', ok: false, code: 1, output: 'FAIL test/pricing.test.ts\n  expected 3, got 4' }],
    notRun: [],
  },
  ...partial,
});

test('a clean record produces no insert at all', () => {
  assert.equal(failureContext({ phase: 1 }), '');
  assert.equal(failureContext({ phase: 1, attempts: 0 }), '');
  // Verification that PASSED is not a failure to report.
  assert.equal(
    failureContext({ phase: 1, attempts: 0, verification: { ok: true, reason: '1 command green', ran: [{ command: 'true', ok: true, code: 0 }], notRun: [] } }),
    '',
    'a green record must not produce a header promising an explanation it does not have',
  );
});

test('the failing command, its exit code and the end of its output all survive', () => {
  const text = failureContext(red());
  assert.match(text, /\$ npm test/);
  assert.match(text, /exit 1/);
  assert.match(text, /expected 3, got 4/);
});

test('the header names the phase and tells the session the repository wins', () => {
  const text = failureContext(red());
  assert.match(text, /previous attempt\(s\) of phase 4/);
  assert.match(text, /the repository is right/,
    'this text is a snapshot from before the retry — a session that trusts it fixes what is no longer broken');
});

test('the run halt reason is quoted, capped to one line', () => {
  const text = failureContext(red(), `phase 4 did not verify\n\nsecond line ${'x'.repeat(600)}`);
  const line = text.split('\n').find((l) => l.startsWith('Why the run stopped:'))!;
  assert.ok(line, 'the halt reason is the shortest statement of what went wrong');
  assert.ok(line.length <= 'Why the run stopped: '.length + 400, `halt line was ${line.length} chars`);
});

test('a verification that could not be RUN reports its reason instead of inventing a failure', () => {
  const text = failureContext({
    phase: 2,
    attempts: 1,
    verification: {
      ok: false,
      reason: 'nothing runnable in this phase\'s verification (2 fragments left for a human)',
      ran: [],
      notRun: [{ text: 'targeted pytest', reason: 'no command in it' }],
    },
  });
  assert.match(text, /nothing runnable/);
  assert.match(text, /targeted pytest — no command in it/);
  assert.doesNotMatch(text, /command\(s\) that failed/,
    'no command failed — saying one did is the bug this distinction exists to prevent');
});

test('lint and the session\'s closing words are carried', () => {
  const text = failureContext(red({
    lint: { ok: false, summary: 'phase 4: depends_on disagrees with the graph' },
    said: 'I could not find the module the plan names.',
  }));
  assert.match(text, /depends_on disagrees/);
  assert.match(text, /I could not find the module/);
});

test('a green lint is not reported as a problem', () => {
  const text = failureContext(red({ lint: { ok: true, summary: '8 phases, no issues' } }));
  assert.doesNotMatch(text, /no issues/);
});

test('the attempt count is stated, and pluralised honestly', () => {
  assert.match(failureContext(red({ attempts: 1 })), /attempted 1 time already/);
  assert.match(failureContext(red({ attempts: 3 })), /attempted 3 times already/);
});

test('a huge log is trimmed to the budget, and the command line survives the trim', () => {
  // The failure mode this guards: an insert so big it crowds the plan's own
  // instructions out of the boot prompt.
  const text = failureContext(red({
    verification: {
      ok: false,
      reason: 'exited 1',
      ran: [
        { command: 'npm test', ok: false, code: 1, output: `${'noise\n'.repeat(4000)}THE ACTUAL FAILURE` },
        { command: 'npm run lint', ok: false, code: 2, output: 'x'.repeat(50_000) },
        { command: 'npm run build', ok: false, code: 1, output: 'y'.repeat(50_000) },
        { command: 'npm run e2e', ok: false, code: 1, output: 'z'.repeat(50_000) },
      ],
      notRun: [],
    },
    said: 'w'.repeat(9_000),
  }));
  assert.ok(Buffer.byteLength(text) <= MAX_FAILURE_CONTEXT_BYTES,
    `insert was ${Buffer.byteLength(text)} bytes`);
  assert.match(text, /\$ npm test/);
  assert.match(text, /THE ACTUAL FAILURE/, 'the END of a log is where the failure is');
  assert.doesNotMatch(text, /npm run e2e/, 'only the first three failing commands are worth the room');
});

test('sections drop bottom-up: evidence goes before the halt reason', () => {
  // Every section at its full capped size at once — the only shape that actually
  // overruns 4 KB, since `tail()` has already trimmed each one on the way in.
  const text = failureContext(red({
    verification: {
      ok: false,
      reason: 'exited 1',
      ran: [1, 2, 3].map((n) => ({
        command: `npm run check-${n} ${'-'.repeat(190)}`,
        ok: false,
        code: n,
        // Real line structure: `tail()` never starts mid-line, so a single
        // 4000-character token would trim to almost nothing and never overrun.
        output: `${'qqqq noise\n'.repeat(400)}TAIL-OF-${n}`,
      })),
      notRun: Array.from({ length: 6 }, (_, i) => ({
        text: `check ${i} by hand ${'.'.repeat(150)}`,
        reason: `not a command ${'.'.repeat(110)}`,
      })),
    },
    lint: { ok: false, summary: `a lint summary ${'.'.repeat(400)}` },
    said: 's'.repeat(20_000),
  }), 'the halt reason, which is the shortest true statement of what went wrong');

  assert.ok(Buffer.byteLength(text) <= MAX_FAILURE_CONTEXT_BYTES,
    `insert was ${Buffer.byteLength(text)} bytes`);
  assert.match(text, /the halt reason, which is the shortest true statement/,
    'the halt reason is the last thing to go — it costs 400 bytes and explains the stop');
  assert.match(text, /TAIL-OF-1/, 'the failing commands outrank everything below them');
  assert.doesNotMatch(text, /attempted 1 time already/,
    'the attempt count is the first thing dropped: the header already implies a previous attempt');
  assert.doesNotMatch(text, /sssssss/, 'the session\'s closing words go before the failing commands');
});

test('the insert is built only from the record it was handed', () => {
  // Held to the same standard as the recovery templates next door, and by the
  // same means: the operator's real strings are derived at runtime, never
  // written down. Listing them here to grep for them WOULD BE the leak — this
  // repository is public, and the scrub greps this file's own contents too.
  const mine = [homedir(), hostname().split('.')[0], userInfo().username]
    .filter((value) => typeof value === 'string' && value.length > 2);

  const text = failureContext(red({ said: 'done' }), 'halted');
  for (const secret of mine) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), 'the insert names this machine');
  }
  // Stronger than a blocklist and needs no private strings: an insert is made of
  // the caller's own facts, so no absolute path may appear in it at all.
  assert.doesNotMatch(text, /(?:^|\s)\/[A-Za-z0-9._-]+\//, 'an absolute path reached the prompt');
});

/* ------------------------------------------------------------------ *
 * The re-board briefs: RESUMING and UNBLOCK
 * ------------------------------------------------------------------ */

const resumable = {
  phase: 7, slug: 'demo', scriptsDir: '/skill/scripts', attempts: 1,
  handoff: { exists: true, status: 'in-progress', outstanding: '- the PR description\n- re-run the e2e suite' },
  work: { did: true, why: '.: 3 uncommitted paths, 1 commit since the phase started', dirty: 3, commits: 1, paths: ['src/a.ts', 'src/b.ts', 'docs/x.md'] },
  verification: { ok: false, reason: '`npm test` exited 1', ran: [{ command: 'npm test', ok: false, code: 1, output: 'FAIL e2e\n  timeout' }], notRun: [] },
  said: 'stopping here — budget nearly spent; the e2e suite still needs a re-run',
};

test('the RESUMING brief carries the handoff, the uncommitted paths, the last verification and the last words — and never the closeout sentence', () => {
  const text = resumeBrief(resumable);
  assert.match(text, /^RESUMING phase 7/);
  assert.match(text, /a handoff exists for phase 7 and reads "in-progress"/);
  assert.match(text, /re-run the e2e suite/, 'the Outstanding section rides along');
  assert.match(text, /uncommitted: src\/a\.ts, src\/b\.ts, docs\/x\.md/);
  assert.match(text, /\$ npm test/);
  assert.match(text, /exit 1/);
  assert.match(text, /budget nearly spent/);
  assert.match(text, /phase-outcome\.sh demo 7 partial --reason/, 'the partial declaration is named for the next stop');
  assert.match(text, /the repository is right/);
  assert.doesNotMatch(text, /do not start new work/i);
  assert.ok(Buffer.byteLength(text) <= MAX_BRIEF_BYTES);
});

test('a continue instruction replaces the RESUMING header but keeps the evidence', () => {
  const text = resumeBrief(resumable, 'Carry on exactly where you stopped.');
  assert.match(text, /^Carry on exactly where you stopped\./);
  assert.doesNotMatch(text, /RESUMING phase 7 — this phase/);
  assert.match(text, /uncommitted: src\/a\.ts/);
  assert.equal(resumeInstruction(resumable).includes('RESUMING phase 7'), true);
});

test('the UNBLOCK brief leads with the Outstanding text, allows the work, names the errand escape hatch, and never says do-not-start', () => {
  const text = unblockBrief({
    phase: 3, slug: 'demo', scriptsDir: '/skill/scripts',
    handoff: { exists: true, status: 'blocked', outstanding: 'The column rename is undecided; the two callers disagree.' },
    work: { did: false, why: '.: clean tree, 0 commits since the phase started' },
  });
  assert.match(text, /^UNBLOCK phase 3/);
  assert.match(text, /explicitly allowed — asked — to do the work/);
  assert.match(text, /The column rename is undecided/);
  assert.match(text, /phase-outcome\.sh demo 3 needs-human --reason/);
  assert.match(text, /Working tree: clean/);
  assert.doesNotMatch(text, /do not start new work/i);
  // The Outstanding block is load-bearing and appears once, not once in the
  // instruction and again in the evidence.
  assert.equal(text.split('The column rename is undecided').length - 1, 1);
});

test('an UNBLOCK brief with an empty Outstanding says so instead of inventing a blocker', () => {
  const text = unblockBrief({ phase: 3, handoff: { exists: true, status: 'blocked' } });
  assert.match(text, /Outstanding section is empty/);
  assert.match(text, /phase-outcome\.sh <slug> 3 needs-human/, 'unknown slug/scripts degrade to placeholders, never to a broken command');
});

test('a brief over budget sheds evidence, never the instruction', () => {
  const text = resumeBrief({
    ...resumable,
    handoff: { exists: true, status: 'in-progress', outstanding: 'x'.repeat(3_000) },
    verification: { ok: false, reason: 'red', ran: [{ command: 'npm test', ok: false, code: 1, output: 'y'.repeat(5_000) }], notRun: [] },
    said: 'z'.repeat(4_000),
  });
  assert.ok(Buffer.byteLength(text) <= MAX_BRIEF_BYTES);
  assert.match(text, /^RESUMING phase 7/);
  assert.match(text, /Read `git status` and `git diff` FIRST/);
});
