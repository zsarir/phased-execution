/**
 * "Done" is a sentence somebody wrote, not a measurement.
 *
 * `phase_status()` (`scripts/phase-graph.sh:418-430`) greps `^status:` out of a
 * handoff's frontmatter and maps `complete → done`. That is the entire basis of
 * every green ring, every filled DAG node and every completion percentage the
 * console draws. A phase closed by hand with nothing ever run looks exactly
 * like one whose suite passed — and the case that made this concrete is
 * ordinary rather than exotic: `board: done` with `qa: fail` is a LEGAL,
 * common state, because `_is_verified` gates a phase's dependents and never the
 * phase itself (`phase-graph.sh:1023-1027`).
 *
 * These tests pin the truth table `shared/evidence-model.js` implements: which
 * recorded shapes count as evidence, which only look like it, and — for every
 * combination the shapes on disk cannot tell apart — that the answer is the
 * conservative one and that `why[]` says which fact was missing. `why[]` is
 * never empty, in any combination, because a verdict nobody can read the
 * reasoning of is the thing this module exists to stop shipping.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_WORDS, HANDOFF_WORDS, QA_WORDS, RULING_KINDS, VERIFICATION_WORDS,
  deriveEvidence, isQaWord, isVerificationWord,
} from '../shared/evidence-model.js';

/* ------------------------------------------------------------------ *
 * Fixtures — one per recorded verification shape (the V-table)
 * ------------------------------------------------------------------ */

/** V1 — a command ran and failed (`runner.ts:4409`). */
const V_RED = { ok: false, reason: '1 of 2 checks failed', ran: [{ command: 'npm test', ok: false }, { command: 'npm run lint', ok: true }], notRun: [] };
/** V2 — nothing runnable, left for a person (`runner.ts:4441`). */
const V_UNPROVEN = { ok: false, reason: 'nothing runnable', ran: [], notRun: [{ text: 'check the page by hand', reason: 'no command in the plan text' }] };
/** V3 — every command's lead is missing here (`runner.ts:4386-4402`). */
const V_UNRUNNABLE = { ok: false, reason: 'every check skipped', ran: [], notRun: [], skipped: [{ command: 'rg -n foo', lead: 'rg', reason: 'not installed' }] };
/** V4 — a human allow (`runner.ts:5574-5581`): ok flipped, `ran` still empty. */
const V_HUMAN = { ok: true, reason: '2 manual check(s) confirmed by mobin — looked right', ran: [], notRun: [{ text: 'eyeball the chart', reason: 'human check' }, { text: 'confirm the copy', reason: 'human check' }] };
/** V5 — green, with a check nobody here could run (`runner.ts:4453-4457`). */
const V_PARTIAL = { ok: true, reason: 'verified with 1 check(s) skipped', ran: [{ command: 'npm test', ok: true }], notRun: [], skipped: [{ command: 'rg -n foo', lead: 'rg', reason: 'not installed' }] };
/** V6 — green (`runner.ts:4450`). */
const V_GREEN = { ok: true, reason: '2/2 ok', ran: [{ command: 'npm test', ok: true }, { command: 'npm run lint', ok: true }], notRun: [] };

const DONE = { board: 'done', handoff: { exists: true, status: 'complete' } };

/** Every `why[]` line joined, for readable `assert.match` failures. */
function why(input: Parameters<typeof deriveEvidence>[0]) {
  return deriveEvidence(input).why.join('\n');
}

/* ------------------------------------------------------------------ *
 * Axis 3 — the recorded verification shapes fold into five words
 * ------------------------------------------------------------------ */

test('V0-V6: every recorded VerifySummary shape maps to its word', () => {
  const word = (v: unknown) => deriveEvidence({ ...DONE, verification: v as never }).verification;
  assert.equal(word(undefined), 'none');                    // V0
  assert.equal(word(null), 'none');                         // V0
  assert.equal(word(V_RED), 'red');                         // V1
  assert.equal(word(V_UNPROVEN), 'skipped');                // V2
  assert.equal(word(V_UNRUNNABLE), 'skipped');              // V3
  assert.equal(word(V_HUMAN), 'human');                     // V4
  assert.equal(word(V_PARTIAL), 'green');                   // V5
  assert.equal(word(V_GREEN), 'green');                     // V6
  // Not ok with nothing to ask and nothing skipped is a failure, not a shrug
  // (`runner.ts:4443` — the halt is `verify-failed`).
  assert.equal(word({ ok: false, reason: 'exit 1', ran: [], notRun: [] }), 'red');
  // ok with no command and no chore proves nothing at all.
  assert.equal(word({ ok: true, reason: '', ran: [], notRun: [] }), 'skipped');
});

test('the count-narrowed shape recordEvidence writes reads the same as the arrays', () => {
  // `situation.ts:305-313` keeps only counts. Both must classify alike.
  assert.equal(deriveEvidence({ ...DONE, verification: { ok: false, ran: 2, failed: 1 } }).verification, 'red');
  assert.equal(deriveEvidence({ ...DONE, verification: { ok: true, ran: 2, failed: 0 } }).verification, 'green');
  assert.equal(deriveEvidence({ ...DONE, verification: { ok: true, ran: 2, failed: 0, skipped: 1 } }).verification, 'green');
  assert.equal(deriveEvidence({ ...DONE, verification: { ok: false, ran: 0, skipped: 3 } }).verification, 'skipped');
  // Ambiguity 2: provenance does not survive the narrowing, and we do not invent it.
  assert.doesNotMatch(why({ ...DONE, verification: { ok: true, ran: 1, failed: 0 } }), /terminal/);
  assert.match(why({ ...DONE, verification: { ok: true, reason: '', ran: [{ command: 'npm test', ok: true, via: 'terminal' }], notRun: [] } }), /ran at least one check in a terminal/);
});

/* ------------------------------------------------------------------ *
 * Axis 4 — the QA gate
 * ------------------------------------------------------------------ */

test('the QA table: mode off swallows the row, mode on/waived reads the verdict', () => {
  const word = (mode: string, result?: string) => deriveEvidence({ ...DONE, qa: { mode, result } }).qa;
  for (const result of [undefined, 'pass', 'fail', 'pending', 'waived', 'unknown']) {
    assert.equal(word('off', result), 'off', `off + ${result}`);
  }
  for (const mode of ['on', 'waived']) {
    assert.equal(word(mode, 'fail'), 'fail');
    assert.equal(word(mode, 'pass'), 'pass');
    assert.equal(word(mode, 'waived'), 'waived');
    assert.equal(word(mode, 'pending'), 'pending');
    assert.equal(word(mode, undefined), 'pending');
    // Ambiguity 6 — a row read but not classifiable is not a verdict.
    assert.equal(word(mode, 'unknown'), 'pending');
    assert.match(why({ ...DONE, qa: { mode, result: 'unknown' } }), /verdict "unknown" is not one of pass\/fail\/waived\/pending/);
  }
  // Ambiguity 7 — the drive loop supplies no qa dep at all; it reads as off.
  assert.equal(deriveEvidence({ ...DONE, qa: null }).qa, 'off');
});

/* ------------------------------------------------------------------ *
 * The truth table
 * ------------------------------------------------------------------ */

test('an engine error claims nothing else, ever', () => {
  const e = deriveEvidence({ board: 'done', boardError: 'phase-graph.sh timed out after 20s', handoff: { exists: true, status: 'complete' }, verification: V_GREEN, qa: { mode: 'on', result: 'pass' } });
  assert.equal(e.board, 'unknown');
  assert.equal(e.evidenced, false);
  assert.equal(e.why.length, 1, 'an empty board is not evidence of anything — say only that');
  assert.match(e.why[0], /the engine could not read this plan — phase-graph\.sh timed out/);
  // A board word the engine never emits is `unknown` too, and never `ready`.
  assert.equal(deriveEvidence({ board: 'nonsense' }).board, 'unknown');
  assert.equal(deriveEvidence({}).board, 'unknown');
});

test('done + complete + green + a clear gate is the one evidenced row', () => {
  for (const qa of [{ mode: 'off' }, { mode: 'on', result: 'pass' }, { mode: 'waived', result: 'waived' }]) {
    const e = deriveEvidence({ ...DONE, verification: V_GREEN, qa });
    assert.equal(e.evidenced, true, JSON.stringify(qa));
    assert.match(e.why.join('\n'), /board: done/);
    assert.match(e.why.join('\n'), /handoff: complete/);
    assert.match(e.why.join('\n'), /verification: green \(2\/2 ok\)/);
    assert.match(e.why.join('\n'), /qa: /);
  }
});

test('a green with skipped checks is still evidence, and says how many', () => {
  const e = deriveEvidence({ ...DONE, verification: V_PARTIAL, qa: { mode: 'on', result: 'pass' } });
  assert.equal(e.verification, 'green');
  assert.equal(e.evidenced, true, 'commands ran and passed — qualified, not disqualified');
  assert.match(e.why.join('\n'), /verification: green with 1 check skipped — rg not installed here/);
});

test('a human sign-off is evidence, and the line never pretends a command ran', () => {
  const e = deriveEvidence({ ...DONE, verification: V_HUMAN, qa: { mode: 'off' } });
  assert.equal(e.verification, 'human');
  assert.equal(e.evidenced, true);
  // Ambiguity 1 — the shape says a person allowed it, the prose says who.
  assert.match(e.why.join('\n'), /verification: 2 manual checks confirmed by mobin — no command ran/);
  // With the fact that does not exist yet, we read it directly instead.
  const named = deriveEvidence({ ...DONE, verification: { ...V_HUMAN, reason: '', confirmedBy: 'ada' } });
  assert.match(named.why.join('\n'), /confirmed by ada/);
  // With neither, we still say what happened rather than inventing a name.
  const anon = deriveEvidence({ ...DONE, verification: { ok: true, reason: '', ran: [], notRun: [{ text: 'look', reason: 'human check' }] } });
  assert.equal(anon.verification, 'human');
  assert.match(anon.why.join('\n'), /confirmed by a person — no command ran/);
});

test('a fail verdict beats any green: the claim is not backed', () => {
  for (const v of [V_GREEN, V_PARTIAL, V_HUMAN]) {
    const e = deriveEvidence({ ...DONE, verification: v, qa: { mode: 'on', result: 'fail' } });
    assert.equal(e.qa, 'fail');
    assert.equal(e.evidenced, false);
    assert.match(e.why.join('\n'), /qa: on and the recorded verdict is fail — dependents stay blocked/);
  }
});

test('a gate with no verdict is not a gate that passed', () => {
  for (const v of [V_GREEN, V_PARTIAL, V_HUMAN]) {
    for (const result of [undefined, 'pending', 'unknown']) {
      const e = deriveEvidence({ ...DONE, verification: v, qa: { mode: 'on', result } });
      assert.equal(e.qa, 'pending');
      assert.equal(e.evidenced, false, `${result}`);
      assert.match(e.why.join('\n'), /qa: on and (no verdict is recorded|the recorded verdict "unknown")/);
    }
  }
});

test('done + red: the board and the record disagree, and we say which', () => {
  const e = deriveEvidence({ ...DONE, verification: V_RED, qa: { mode: 'off' } });
  assert.equal(e.verification, 'red');
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /verification: red \(1\/2 failed\) — the board reads done, the record disagrees/);
});

test('done + nothing runnable: N fragments were left for a person', () => {
  const e = deriveEvidence({ ...DONE, verification: V_UNPROVEN, qa: { mode: 'off' } });
  assert.equal(e.verification, 'skipped');
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /verification: nothing runnable — 1 fragment left for a person/);
});

test('done + every lead missing: nothing was proven, and the leads are named', () => {
  const e = deriveEvidence({ ...DONE, verification: V_UNRUNNABLE, qa: { mode: 'off' } });
  assert.equal(e.verification, 'skipped');
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /verification: every command's lead is missing here \(rg\) — nothing was proven/);
});

test('done with no verification at all is CLAIMED, not evidenced', () => {
  for (const qa of [{ mode: 'off' }, { mode: 'on', result: 'pass' }, { mode: 'waived', result: 'waived' }]) {
    const e = deriveEvidence({ ...DONE, qa });
    assert.equal(e.verification, 'none');
    assert.equal(e.evidenced, false, 'the hand-closed phase');
    // Ambiguity 4 — a statement about our records, never about the work.
    assert.match(e.why.join('\n'), /verification: no run of this console verified this phase/);
    assert.doesNotMatch(e.why.join('\n'), /unverified/);
  }
});

test('done without a complete handoff means the store and the engine drifted', () => {
  for (const status of ['in-progress', 'blocked', 'pending', 'donee']) {
    const e = deriveEvidence({ board: 'done', handoff: { exists: true, status, rawStatus: status }, verification: V_GREEN, qa: { mode: 'off' } });
    assert.equal(e.evidenced, false, status);
    assert.match(e.why.join('\n'), /board: done but the store reads handoff .+ — re-scan/);
  }
  const gone = deriveEvidence({ board: 'done', handoff: null, verification: V_GREEN, qa: { mode: 'off' } });
  assert.equal(gone.handoff, 'absent');
  assert.equal(gone.evidenced, false);
  assert.match(gone.why.join('\n'), /board: done but the store reads handoff absent — re-scan/);
});

test('in-progress: the handoff, the Outstanding prose, and an advisory verification', () => {
  const base = { board: 'in-progress', handoff: { exists: true, status: 'in-progress', outstanding: 'the migration   still needs\na rollback path' } };
  const plain = deriveEvidence({ ...base });
  assert.equal(plain.evidenced, false);
  assert.equal(plain.verification, 'none');
  assert.match(plain.why.join('\n'), /board: in-progress/);
  assert.match(plain.why.join('\n'), /handoff: in-progress — Outstanding: the migration still needs a rollback path/);
  assert.doesNotMatch(plain.why.join('\n'), /verification:/, 'a phase mid-work owes no verification line');

  for (const v of [V_RED, V_UNPROVEN]) {
    const e = deriveEvidence({ ...base, verification: v });
    assert.equal(e.evidenced, false);
    assert.match(e.why.join('\n'), /advisory, the phase is mid-work/);
  }
});

test('in-progress + green is "verified, unrecorded" — still not evidenced', () => {
  for (const v of [V_GREEN, V_HUMAN]) {
    const e = deriveEvidence({ board: 'in-progress', handoff: { exists: true, status: 'in-progress' }, verification: v });
    assert.equal(e.evidenced, false, 'nothing claims done yet, so nothing is backed');
    assert.match(e.why.join('\n'), /but the handoff still reads in-progress/);
  }
});

test('stuck reads the handoff that made it stuck', () => {
  const e = deriveEvidence({ board: 'stuck', handoff: { exists: true, status: 'blocked', outstanding: 'waiting on a DNS change' }, verification: V_RED });
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /board: stuck \(the handoff reads blocked\)/);
  assert.match(e.why.join('\n'), /handoff: blocked — Outstanding: waiting on a DNS change/);
  assert.match(e.why.join('\n'), /verification: red/);
});

test('ready separates "no handoff" from "a handoff that claims nothing"', () => {
  const none = deriveEvidence({ board: 'ready', handoff: null });
  assert.equal(none.handoff, 'absent');
  assert.match(none.why.join('\n'), /handoff: none/);
  assert.match(none.why.join('\n'), /board: ready — every dependency is verified/);

  // Ambiguity 3 — the board cannot say this; only the store can.
  const pending = deriveEvidence({ board: 'ready', handoff: { exists: true, status: 'pending' } });
  assert.equal(pending.handoff, 'pending');
  assert.match(pending.why.join('\n'), /handoff: pending — the file exists and claims nothing/);
  assert.notEqual(none.why.join('\n'), pending.why.join('\n'), 'these two must not read alike');
});

test('an unreadable handoff status is quoted back, not swallowed', () => {
  const e = deriveEvidence({ board: 'ready', handoff: { exists: true, status: 'unknown', rawStatus: 'donee' } });
  assert.equal(e.handoff, 'unknown');
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /handoff: status "donee" is not one of complete\/in-progress\/blocked\/pending/);
});

test('ready with a record from a run that did not land says so, twice', () => {
  for (const v of [V_RED, V_UNPROVEN, V_GREEN]) {
    const e = deriveEvidence({ board: 'ready', handoff: null, verification: v, record: { status: 'failed', attempts: 3 } });
    assert.equal(e.evidenced, false);
    assert.match(e.why.join('\n'), /record: failed · 3 attempts/);
    assert.match(e.why.join('\n'), /verification: /);
  }
  const one = deriveEvidence({ board: 'ready', handoff: null, record: { status: 'interrupted', attempts: 1 } });
  assert.match(one.why.join('\n'), /record: interrupted · 1 attempt$/m);
});

test('waiting names WHICH dependencies, and how they block', () => {
  const bare = deriveEvidence({ board: 'waiting', handoff: null });
  assert.match(bare.why.join('\n'), /board: waiting/);
  assert.doesNotMatch(bare.why.join('\n'), /blocked by/, 'no deps given, nothing invented');

  // Ambiguity 8 — the two kinds of waiting, mirroring `_is_verified`.
  const e = deriveEvidence({
    board: 'waiting', handoff: null, qa: { mode: 'on' },
    blockedBy: [{ phase: 2, state: 'ready' }, { phase: 3, state: 'done', qa: 'pending' }, { phase: 4, state: 'done', qa: 'pass' }],
  });
  assert.equal(e.evidenced, false);
  assert.match(e.why.join('\n'), /blocked by phase\(s\) 2 \(not done\)/);
  assert.match(e.why.join('\n'), /blocked by phase\(s\) 3 \(done, QA not verified\)/);
  assert.doesNotMatch(e.why.join('\n'), /phase\(s\) 4/);

  // With no gate, a done dependency cannot be blocking on QA.
  const ungated = deriveEvidence({ board: 'waiting', handoff: null, qa: { mode: 'off' }, blockedBy: [{ phase: 3, state: 'done', qa: 'pending' }] });
  assert.doesNotMatch(ungated.why.join('\n'), /QA not verified/);
});

test('a fail verdict on a phase that is not done is legal, and worth saying', () => {
  for (const board of ['in-progress', 'stuck', 'ready', 'waiting']) {
    const e = deriveEvidence({ board, handoff: null, qa: { mode: 'on', result: 'fail' } });
    assert.equal(e.qa, 'fail');
    assert.equal(e.evidenced, false, board);
    assert.match(e.why.join('\n'), /qa: a fail verdict is recorded for a phase that is not done/);
  }
});

test('a fail row under a gate that reads off is resolved the conservative way', () => {
  const e = deriveEvidence({ ...DONE, verification: V_GREEN, qa: { mode: 'off', result: 'fail' } });
  assert.equal(e.qa, 'off', 'the table says the mode decides the word');
  assert.equal(e.evidenced, false, 'but a recorded failure is a recorded failure');
  assert.match(e.why.join('\n'), /the gate reads off but a fail verdict is recorded — treating it as unproven/);
});

test('the weaker facts about a green are carried, not dropped', () => {
  // A suite that passed in the wrong directory and one that passed in the
  // right one look identical afterwards (`state.ts:272-279`).
  const e = deriveEvidence({ ...DONE, verification: V_GREEN, record: { verifiedIn: 'packages/api', runId: 'run-d86f48d9', verifiedAt: '2026-08-14T03:45:02Z' } });
  assert.equal(e.evidenced, true);
  assert.match(e.why.join('\n'), /verification: ran in packages\/api/);
  // Ambiguity 5 — which run answered, said out loud.
  assert.match(e.why.join('\n'), /verification: from run run-d86f48d9, 2026-08-14T03:45:02Z/);
  // With no record at all we invent neither.
  assert.doesNotMatch(why({ ...DONE, verification: V_GREEN }), /ran in|from run/);
});

/* ------------------------------------------------------------------ *
 * Invariants
 * ------------------------------------------------------------------ */

test('why[] is never empty, and the words never leave their vocabulary', () => {
  const verifications: unknown[] = [undefined, null, V_RED, V_UNPROVEN, V_UNRUNNABLE, V_HUMAN, V_PARTIAL, V_GREEN, {}, { ok: true }, { ok: false }];
  const handoffs: unknown[] = [undefined, null, { exists: false }, { exists: true, status: 'complete' }, { exists: true, status: 'in-progress' }, { exists: true, status: 'blocked' }, { exists: true, status: 'pending' }, { exists: true, status: 'wat', rawStatus: 'wat' }];
  const qas: unknown[] = [undefined, null, { mode: 'off' }, { mode: 'on' }, { mode: 'on', result: 'pass' }, { mode: 'on', result: 'fail' }, { mode: 'waived', result: 'waived' }, { mode: 'on', result: 'unknown' }];
  let combos = 0;
  for (const board of [...BOARD_WORDS, 'garbage', '']) {
    for (const handoff of handoffs) {
      for (const verification of verifications) {
        for (const qa of qas) {
          const e = deriveEvidence({ board, handoff, verification, qa } as never);
          combos += 1;
          assert.ok(e.why.length > 0, `empty why for ${board}/${JSON.stringify(handoff)}`);
          for (const line of e.why) assert.ok(line.length > 8 && line === line.trim(), `bad line: ${line}`);
          assert.ok(BOARD_WORDS.includes(e.board as never), e.board);
          assert.ok(HANDOFF_WORDS.includes(e.handoff as never), e.handoff);
          assert.ok(isVerificationWord(e.verification), e.verification);
          assert.ok(isQaWord(e.qa), e.qa);
          assert.equal(typeof e.evidenced, 'boolean');
          if (e.evidenced) {
            assert.equal(e.board, 'done', 'nothing but a done phase can be evidenced');
            assert.equal(e.handoff, 'complete');
            assert.ok(e.verification === 'green' || e.verification === 'human', e.verification);
            assert.ok(e.qa !== 'fail' && e.qa !== 'pending', e.qa);
          }
        }
      }
    }
  }
  assert.ok(combos > 2000, `the matrix should be wide (${combos})`);
  // Garbage in, conservative out — no throw anywhere.
  assert.equal(deriveEvidence(null).evidenced, false);
  assert.equal(deriveEvidence(undefined).why.length, 1);
  assert.equal(deriveEvidence('nope' as never).board, 'unknown');
});

test('nothing is named `done`: the claim and the evidence keep separate words', () => {
  const e = deriveEvidence({ ...DONE, verification: V_GREEN });
  assert.ok(!('done' in e), 'the board owns the word `done`, and it means claimed');
  assert.deepEqual(Object.keys(e).sort(), ['board', 'evidenced', 'handoff', 'qa', 'verification', 'why']);
});

test('the vocabularies are frozen, complete and in decision order', () => {
  for (const v of [VERIFICATION_WORDS, QA_WORDS, BOARD_WORDS, HANDOFF_WORDS, RULING_KINDS]) {
    assert.ok(Object.isFrozen(v));
    assert.equal(new Set(v).size, v.length, 'no duplicates');
  }
  assert.deepEqual([...VERIFICATION_WORDS], ['none', 'red', 'skipped', 'human', 'green']);
  assert.deepEqual([...QA_WORDS], ['off', 'fail', 'pending', 'pass', 'waived']);
  // Declared here for Phase 5 to fill; the words ship before the surface does.
  assert.deepEqual([...RULING_KINDS], ['ambiguity', 'deviation', 'deferral']);
});

/* ------------------------------------------------------------------ *
 * Parity — by import identity, never by deepEqual
 * ------------------------------------------------------------------ */

test('the client imports the SAME evidence model', async () => {
  // Not equal: the same. A copy would pass `deepEqual` today and drift tomorrow.
  const client = await import('../client/src/lib/evidence.ts');
  assert.equal(client.VERIFICATION_WORDS, VERIFICATION_WORDS);
  assert.equal(client.QA_WORDS, QA_WORDS);
  assert.equal(client.BOARD_WORDS, BOARD_WORDS);
  assert.equal(client.HANDOFF_WORDS, HANDOFF_WORDS);
  assert.equal(client.RULING_KINDS, RULING_KINDS);
  assert.equal(client.deriveEvidence, deriveEvidence);
  assert.equal(client.isVerificationWord, isVerificationWord);
  assert.equal(client.isQaWord, isQaWord);
  assert.ok(Object.isFrozen(VERIFICATION_WORDS));
});

test('a handoff the store HOLDS is never reported absent', () => {
  // `handoffFor` returns the parsed `Handoff` or `undefined` — there is no
  // `exists` field on it, so `handoff?.exists` was always `undefined` and every
  // phase with a real handoff derived `{exists: false}`. Live consequence, on a
  // plan whose phase 1 handoff reads `status: complete`: the same API response
  // carried `phase.handoff.status === 'complete'` AND `proof.handoff ===
  // 'absent'`, and the phase card said "board: done but the store reads handoff
  // absent — re-scan" about a file that was present, complete, and parsed.
  const present = deriveEvidence({
    phase: 1,
    board: 'done',
    handoff: { exists: true, status: 'complete' },
    qa: { mode: 'off' },
  });
  assert.equal(present.handoff, 'complete');
  assert.ok(!present.why.some((w) => /handoff absent|re-scan/i.test(w)),
    `a present handoff must not be described as missing: ${present.why.join(' | ')}`);

  // And the genuinely absent case still says so.
  const missing = deriveEvidence({ phase: 1, board: 'done', handoff: { exists: false }, qa: { mode: 'off' } });
  assert.equal(missing.handoff, 'absent');
});
