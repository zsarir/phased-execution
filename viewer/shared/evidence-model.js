/**
 * The evidence model: the difference between a phase that is CLAIMED done and
 * a phase that is EVIDENCED done, computed once, by a pure function, in ONE
 * vocabulary that three layers import by identity.
 *
 * The incident this file exists for. `phase_status()`
 * (`scripts/phase-graph.sh:418-430`) greps `^status:` out of the handoff's
 * YAML frontmatter and maps `complete → done`. That is the whole measurement.
 * The board says a phase is done because a MARKDOWN FILE SAYS SO — a line a
 * session wrote about itself, or a person typed at 2am — and every surface
 * downstream inherits that sentence and renders it as a fact: the ring, the
 * DAG colour, the plan's percentage, and `_is_verified`'s gate on the phase's
 * dependents. A phase closed by hand with no command ever run is, on every
 * screen the console has today, indistinguishable from one whose suite ran
 * green in the right directory five minutes ago.
 *
 * So this module never uses the word `done` for its own answer. `done` is
 * taken, it belongs to the board, and what it means is *claimed*. The field
 * here is `evidenced`, and it is true only when something actually RAN and
 * PASSED and the QA gate does not contradict it. Everything else — including
 * every state the recorded shapes cannot tell apart — is `false`, with a line
 * in `why[]` saying which fact was missing. **When in doubt the answer is
 * `false`.** A green badge that turns out to have been a sentence in a file is
 * worse than no badge; an amber one that turns out to have been fine costs a
 * glance.
 *
 * Imported by:
 *   - `server/service.ts` — `detail()` and `phaseDiagnosis()` fold the board,
 *     the store's handoff, the newest run's `record.verification` and the QA
 *     row into one call of `deriveEvidence`;
 *   - `server/runner/situation.ts` — the same call from the drive loop, where
 *     the dep set is thinner (no `qa`, no `health`: see ambiguity 7 below);
 *   - `client/src/lib/evidence.ts` — a bare re-export, so a chip, a panel and
 *     a journal line can never drift from the server's own word;
 *   - `test/evidence-model.test.ts` — holds every row of the truth table and
 *     holds client and shared identical by import identity.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `situation-model.js` precedent: the
 * client imports it relatively (node resolves no Vite alias in the test
 * suite), the server as `../../shared/evidence-model.js`.
 *
 * ## Why the fields are narrower than the facts
 *
 * The recorded shapes distinguish seven verification states and six QA ones.
 * The `verification` and `qa` FIELDS are five words each, because a badge is
 * five words wide and a surface that must switch on seven cases grows a
 * seventh case that nobody styled. Nothing is lost: the finer fact is always
 * in `why[]`, and it is always the thing that decided `evidenced`.
 *
 *   raw record shape (`VerifySummary`, `server/runner/state.ts:150`) → field
 *   V0  no run / no record / `verification === undefined`          → `none`
 *   V1  `ran.some(!ok)`                              (runner:4409) → `red`
 *   V2  `!ok && ran===0 && notRun>0`   "left for a person"  (:4441) → `skipped`
 *   V3  `!ok && ran===0 && skipped>0` "leads missing"  (:4386-4402) → `skipped`
 *   V4  `ok && ran===0 && notRun>0`   "human allow"    (:5574-5581) → `human`
 *   V5  `ok && ran>0 && skipped>0`    "partial"        (:4453-4457) → `green`
 *   V6  `ok && ran>0 && !skipped`                           (:4450) → `green`
 *
 * V5 folds into `green` because it IS evidence — commands ran and passed —
 * and the `why[]` line names how many checks were skipped and whose leads are
 * missing. V2 and V3 fold into `skipped` because they are the same answer to
 * the only question that matters: nothing was proven. QA's `unknown` (a row
 * that was read but could not be classified, `parse/folder.ts:47`) folds into
 * `pending` for the same reason — an unreadable verdict is not a verdict —
 * and `why[]` quotes the raw word so the operator can go fix the file.
 *
 * ## Combinations the recorded shapes CANNOT distinguish
 *
 * Every one of these takes the conservative answer (`evidenced: false` unless
 * noted) and says so in `why[]`. They are listed here so that the day someone
 * adds the missing fact, the line to delete is findable.
 *
 *  1. **A human sign-off vs a machine green with zero commands.** Both are
 *     `{ok:true, ran:[], notRun:[…]}`; the only separator is the `reason`
 *     prose `manual check(s) confirmed by <who>` that `askHuman` writes
 *     (`runner.ts:5578`). We read the shape, and mine `reason` only for the
 *     NAME. `verification: 'human'` is therefore `evidenced: true` — a person
 *     saying "I checked it" is evidence, it is just not a command — but the
 *     `why[]` line always says "no command ran". *Missing fact:*
 *     `VerifySummary.confirmedBy?: string`, written at `askHuman` time.
 *  2. **Verified in a terminal by a person vs verified by the runner.**
 *     `VerifyRun.via === 'terminal'` (`state.ts:125`) exists per command, but
 *     `recordEvidence` (`situation.ts:305-313`) narrows `ran` to a COUNT and
 *     throws the provenance away. When we are given the array we say it; when
 *     we are given counts we cannot. *Missing fact:* `VerifySummary.via`.
 *  3. **`handoff: pending` vs no handoff file at all.** Both map to the
 *     board's `not-started` (`phase-graph.sh:427`) and so to `ready`/
 *     `waiting`. Only the store can tell them apart, which is why this
 *     function takes the handoff RECORD and not just the board word — and why
 *     the runner's board-only fallback (`runner.ts:5808-5815`) will report a
 *     `pending` handoff as absent until it is given a store.
 *  4. **"Never verified" vs "verified before this console existed, or by
 *     hand."** Both are `verification === undefined`. No fact on disk
 *     separates them, so the `why[]` line is *"no run of this console verified
 *     this phase"* — a statement about our own records — and never
 *     *"unverified"*, which would be a claim about the work. *Missing fact:* a
 *     verification claim in the handoff itself.
 *  5. **Which run's verification is authoritative** when a phase appears in
 *     several. `phaseDiagnosis` takes the newest by `createdAt` by accident of
 *     `listRuns`' sort (`state.ts:1434`), so a stale red can outrank a fresh
 *     green in silence. The choice is the caller's; this function only insists
 *     that it be SAID — pass `runId`/`verifiedAt` and the line appears.
 *  6. **A QA row absent vs a row present but unreadable.** bash prints `none`
 *     for both (`phase-graph.sh:968-982`); the JS parser says `undefined` vs
 *     `'unknown'`, and the console never shells `--qa-result`, so the finer
 *     reading is what ships. Both are `qa: 'pending'` here; only the unreadable
 *     one quotes the raw word.
 *  7. **The drive loop has no `qa` dep.** `runner.ts:5805-5825` omits it, so
 *     `qa` arrives `null` there and reads as `off`. A phase whose QA verdict
 *     is `fail` will therefore look better from inside the runner than from
 *     the service. Unify the dep set or expect the difference.
 *  8. **Why a phase is `waiting`** — deps not done, vs deps done but their QA
 *     unverified — is not in `Board`. It is derivable from `board.states` +
 *     the QA rows + `dependsOn`, exactly as `test/engine-parity.test.ts:56-61`
 *     re-implements `_is_verified`; pass `blockedBy` and the two are named
 *     separately, omit it and `why[]` says only "waiting".
 */

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

/**
 * @typedef {'none'|'red'|'skipped'|'human'|'green'} VerificationWord
 */

/**
 * What we can say about whether a command ran and passed, in CLASSIFIER
 * order — the order is the decision, not an accident. `none` first because
 * "there is no record" is a different question from "the record is bad";
 * `red` next because a failure outranks everything a later check could soften;
 * `skipped` before `human` and `green` because nothing-was-proven must never
 * be dressed up by the one command that did run.
 */
export const VERIFICATION_WORDS = Object.freeze(
  /** @type {const} */ ([
    /** No run of this console recorded a verification for this phase. */
    'none',
    /** A command ran and failed, or the summary is not ok with nothing to ask. */
    'red',
    /** Nothing was proven: every command was left for a person, or its lead is missing here. */
    'skipped',
    /** A person confirmed the manual checks. Evidence — just not a command. */
    'human',
    /** Commands ran and passed. Some may have been skipped; `why[]` says how many. */
    'green',
  ]),
);

/**
 * @typedef {'off'|'fail'|'pending'|'pass'|'waived'} QaWord
 */

/**
 * The QA gate as it bears on THIS phase, in classifier order. Note what `off`
 * does NOT mean: QA gating is on iff `test-status.md` exists
 * (`phase-graph.sh:965-967`), and `**QA gate:** off` in the plan yields the
 * mode `waived`, not `off` — while any `fail` row already on disk still gates
 * the phase's dependents (`phase-graph.sh:991-993`). `off` here means only
 * "this plan has no gate", never "QA is irrelevant".
 */
export const QA_WORDS = Object.freeze(
  /** @type {const} */ ([
    /** No QA gate on this plan. */
    'off',
    /** A `fail` verdict is recorded for this phase. */
    'fail',
    /** The gate is on and no readable verdict is recorded. */
    'pending',
    /** A `pass` verdict is recorded. */
    'pass',
    /** A `waived` verdict is recorded — a person decided, and that is a verdict. */
    'waived',
  ]),
);

/**
 * @typedef {'done'|'in-progress'|'stuck'|'ready'|'waiting'|'unknown'} BoardWord
 */

/** The engine's five words plus `unknown`, which is what a board ERROR reads as. */
export const BOARD_WORDS = Object.freeze(
  /** @type {const} */ (['done', 'in-progress', 'stuck', 'ready', 'waiting', 'unknown']),
);

/**
 * @typedef {'absent'|'pending'|'in-progress'|'blocked'|'complete'|'unknown'} HandoffWord
 */

/**
 * The handoff's own frozen status vocabulary (`parse/handoff.ts:16`) plus the
 * two the board cannot see: `absent` (no file) and `unknown` (a file whose
 * `status:` is not one of the four). The board collapses `pending`, `absent`
 * and `unknown` all three into `not-started`; only the store can separate
 * them, and separating them is half of why this module takes a record.
 */
export const HANDOFF_WORDS = Object.freeze(
  /** @type {const} */ (['absent', 'pending', 'in-progress', 'blocked', 'complete', 'unknown']),
);

/**
 * @typedef {'ambiguity'|'deviation'|'deferral'} RulingKind
 */

/**
 * Declared here, filled in Phase 5. A *ruling* is a person's recorded decision
 * about a phase the evidence could not settle by itself — the third thing that
 * belongs beside a claim and its evidence:
 *   - `ambiguity`: the plan did not say, and someone chose;
 *   - `deviation`: the work departed from the plan, knowingly;
 *   - `deferral`: something the phase owed was postponed, on purpose.
 * Nothing in this file reads it yet; it lives here so that when the ruling
 * surface lands, its words are already the same words as the evidence's, in
 * the same file, read by the same three layers.
 */
export const RULING_KINDS = Object.freeze(/** @type {const} */ (['ambiguity', 'deviation', 'deferral']));

/* ------------------------------------------------------------------ *
 * Input — every field a FACT read from somewhere real
 * ------------------------------------------------------------------ */

/**
 * The store's parsed handoff (`parse/handoff.ts`), or `null`/absent for "no
 * file". `exists:false` and a missing object mean the same thing.
 * @typedef {object} HandoffFact
 * @property {boolean} [exists]
 * @property {string} [status] The normalised word: complete|in-progress|blocked|pending|unknown.
 * @property {string} [rawStatus] What the frontmatter actually said — quoted back when unknown.
 * @property {string} [outstanding] The handoff's Outstanding prose, if any.
 */

/**
 * `PhaseRecord.verification` (`server/runner/state.ts:150`), in either of the
 * two shapes that reach us: the full `VerifySummary` with arrays, or the
 * count-narrowed one `recordEvidence` writes (`situation.ts:305-313`). Both
 * are read; the arrays carry provenance the counts cannot (ambiguity 2).
 * @typedef {object} VerificationFact
 * @property {boolean} [ok]
 * @property {string} [reason]
 * @property {Array<{command?: string, ok?: boolean, via?: string}>|number} [ran]
 * @property {number} [failed] Count-shape only; with arrays it is derived.
 * @property {Array<{text?: string, reason?: string}>|number} [notRun]
 * @property {Array<{command?: string, lead?: string, reason?: string}>|number} [skipped]
 * @property {string} [confirmedBy] Does not exist yet — ambiguity 1. Read if present.
 */

/**
 * The QA gate as the engine resolves it (`--qa-mode`) plus this phase's row
 * from `test-status.md` (`qaFor`, `store.ts:228`). `null` means the caller has
 * no QA dependency at all, which reads as `off` — see ambiguity 7.
 * @typedef {object} QaFact
 * @property {string} [mode] off|on|waived
 * @property {string} [result] pass|fail|pending|waived|unknown, or absent for no row.
 */

/**
 * What the phase's own run recorded about itself, for the lines that say a run
 * happened and did not land.
 * @typedef {object} RecordFact
 * @property {string} [status]
 * @property {number} [attempts]
 * @property {string} [verifiedIn] The directory the commands ran in (`state.ts:279`).
 * @property {string} [runId] Which run this record came from — ambiguity 5.
 * @property {string} [verifiedAt] When, ISO — ambiguity 5.
 */

/**
 * One dependency of this phase, for the `waiting` explanation (ambiguity 8).
 * @typedef {object} DependencyFact
 * @property {number} phase
 * @property {string} [state] That phase's board word.
 * @property {string} [qa] That phase's QA row result, if any.
 */

/**
 * @typedef {object} EvidenceInput
 * @property {number} [phase]
 * @property {string} [board] The engine's word for this phase. Anything unrecognised reads `unknown`.
 * @property {string} [boardError] `Board.error` — the engine could not answer at all.
 * @property {HandoffFact|null} [handoff]
 * @property {VerificationFact|null} [verification]
 * @property {QaFact|null} [qa]
 * @property {RecordFact|null} [record]
 * @property {DependencyFact[]} [blockedBy]
 */

/**
 * @typedef {object} Evidence
 * @property {BoardWord} board The claim.
 * @property {HandoffWord} handoff Where the claim comes from.
 * @property {VerificationWord} verification
 * @property {QaWord} qa
 * @property {boolean} evidenced Whether the claim is backed. Never named `done`.
 * @property {string[]} why Short lowercase `key: value` sentences. Never empty.
 */

/* ------------------------------------------------------------------ *
 * Normalisation — nothing throws, unknown input degrades to the safe word
 * ------------------------------------------------------------------ */

/** @param {unknown} value */
export function isVerificationWord(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (VERIFICATION_WORDS).includes(value);
}

/** @param {unknown} value */
export function isQaWord(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (QA_WORDS).includes(value);
}

/** An array's length, or a count already narrowed to a number. @param {unknown} value */
function count(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return 0;
}

/** @param {unknown} value @returns {unknown[]} */
function list(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {string|undefined|null} value @param {number} [max] */
function tidy(value, max = 140) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * `{n} thing(s)` without the parenthesis tic when n is 1.
 * @param {number} n @param {string} word
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The board's word, or `unknown`. An engine error is `unknown` too — an empty
 * board is not evidence of anything (`analysis/stats.ts:388`), and it is
 * emphatically not `ready`.
 * @param {EvidenceInput} input @returns {BoardWord}
 */
function boardWord(input) {
  if (input.boardError) return 'unknown';
  const raw = String(input.board ?? '').trim();
  return /** @type {readonly string[]} */ (BOARD_WORDS).includes(raw) && raw !== 'unknown'
    ? /** @type {BoardWord} */ (raw)
    : 'unknown';
}

/**
 * @param {HandoffFact|null|undefined} handoff @returns {HandoffWord}
 */
function handoffWord(handoff) {
  if (!handoff || handoff.exists === false) return 'absent';
  const raw = String(handoff.status ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'complete' || raw === 'in-progress' || raw === 'blocked' || raw === 'pending') {
    return /** @type {HandoffWord} */ (raw);
  }
  return 'unknown';
}

/**
 * The recorded verification, read into the facts the words are decided from.
 * `null` in, `null` out: "there is no record" is its own answer.
 * @param {VerificationFact|null|undefined} v
 */
function readVerification(v) {
  if (!v || typeof v !== 'object') return null;
  const ranList = list(v.ran);
  const skippedList = list(v.skipped);
  const ran = count(v.ran);
  const failed = ranList.length
    ? ranList.filter((r) => r && typeof r === 'object' && /** @type {{ok?: boolean}} */ (r).ok === false)
        .length
    : count(v.failed);
  const leads = skippedList
    .map((s) => (s && typeof s === 'object' ? tidy(/** @type {{lead?: string}} */ (s).lead, 40) : ''))
    .filter(Boolean);
  // Ambiguity 1: the shape says a human allowed it, the prose says who.
  const named = /manual check\(s\) confirmed by ([^—]+)/i.exec(String(v.reason ?? ''));
  return {
    ok: v.ok === true,
    reason: tidy(v.reason, 200),
    ran,
    failed,
    notRun: count(v.notRun),
    skipped: count(v.skipped),
    leads: Array.from(new Set(leads)),
    // Ambiguity 2: only the array shape carries provenance; counts lost it.
    viaTerminal: ranList.some(
      (r) => r && typeof r === 'object' && /** @type {{via?: string}} */ (r).via === 'terminal',
    ),
    confirmedBy: tidy(v.confirmedBy, 60) || (named ? tidy(named[1], 60) : ''),
  };
}

/**
 * The V-table, folded into the five words. Read it beside the header's map.
 * @param {ReturnType<typeof readVerification>} v @returns {VerificationWord}
 */
function verificationWord(v) {
  if (!v) return 'none'; // V0
  if (v.failed > 0) return 'red'; // V1
  if (!v.ok) {
    if (v.ran === 0 && (v.notRun > 0 || v.skipped > 0)) return 'skipped'; // V2, V3
    return 'red'; // not ok, nothing to ask (runner.ts:4443)
  }
  if (v.ran === 0) {
    if (v.confirmedBy || v.notRun > 0) return 'human'; // V4
    return 'skipped'; // ok with nothing at all: proves nothing
  }
  return 'green'; // V5, V6
}

/**
 * @param {QaFact|null|undefined} qa
 */
function readQa(qa) {
  const mode = String(qa?.mode ?? 'off')
    .trim()
    .toLowerCase();
  const raw = String(qa?.result ?? '')
    .trim()
    .toLowerCase();
  return {
    mode: mode === 'on' || mode === 'waived' ? mode : 'off',
    /** '' when there is no row at all. */
    result: raw,
    gating: mode === 'on' || mode === 'waived',
  };
}

/**
 * @param {ReturnType<typeof readQa>} qa @returns {QaWord}
 */
function qaWord(qa) {
  if (!qa.gating) return 'off';
  if (qa.result === 'fail') return 'fail';
  if (qa.result === 'pass') return 'pass';
  if (qa.result === 'waived') return 'waived';
  return 'pending'; // pending, absent, and unreadable — ambiguity 6.
}

/* ------------------------------------------------------------------ *
 * The derivation
 * ------------------------------------------------------------------ */

/**
 * Fold the board, the handoff, the recorded verification and the QA verdict
 * into one honest answer about whether this phase's claim is backed.
 *
 * Pure: no I/O, no clock, no throw. Every unreadable input degrades to the
 * conservative word and says so in `why[]`, which is never empty.
 *
 * @param {EvidenceInput|null|undefined} input
 * @returns {Evidence}
 */
export function deriveEvidence(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const board = boardWord(inp);
  const handoff = handoffWord(inp.handoff);
  const v = readVerification(inp.verification);
  const verification = verificationWord(v);
  const qaFact = readQa(inp.qa);
  const qa = qaWord(qaFact);

  /** @type {string[]} */
  const why = [];

  // A board that could not be read outranks every other line. An empty board
  // is not evidence of anything, so we claim nothing else from it.
  if (board === 'unknown') {
    why.push(
      inp.boardError
        ? `board: the engine could not read this plan — ${tidy(inp.boardError, 160)}`
        : "board: unknown — the engine's answer did not name this phase",
    );
    return { board, handoff, verification, qa, evidenced: false, why };
  }

  /* --- the claim ------------------------------------------------- */

  if (board === 'stuck') {
    why.push(handoff === 'blocked' ? 'board: stuck (the handoff reads blocked)' : 'board: stuck');
  } else if (board === 'ready') {
    why.push('board: ready — every dependency is verified');
  } else {
    why.push(`board: ${board}`);
  }

  if (board === 'waiting') {
    const deps = Array.isArray(inp.blockedBy) ? inp.blockedBy.filter((d) => d && d.phase != null) : [];
    // Ambiguity 8: which of the two kinds of waiting this is. Mirrors
    // `_is_verified` (phase-graph.sh:984-987) exactly as engine-parity does.
    const notDone = deps.filter((d) => d.state !== 'done').map((d) => d.phase);
    const qaUnverified = qaFact.gating
      ? deps.filter((d) => d.state === 'done' && d.qa !== 'pass' && d.qa !== 'waived').map((d) => d.phase)
      : [];
    if (notDone.length) why.push(`blocked by phase(s) ${notDone.join(', ')} (not done)`);
    if (qaUnverified.length)
      why.push(`blocked by phase(s) ${qaUnverified.join(', ')} (done, QA not verified)`);
  }

  /* --- where the claim comes from -------------------------------- */

  const outstanding = tidy(inp.handoff?.outstanding);
  const trailer = outstanding ? ` — Outstanding: ${outstanding}` : '';
  if (handoff === 'absent') {
    why.push('handoff: none');
  } else if (handoff === 'pending') {
    why.push('handoff: pending — the file exists and claims nothing');
  } else if (handoff === 'unknown') {
    const raw = tidy(inp.handoff?.rawStatus, 40) || tidy(inp.handoff?.status, 40) || '(empty)';
    why.push(`handoff: status "${raw}" is not one of complete/in-progress/blocked/pending`);
  } else {
    why.push(`handoff: ${handoff}${trailer}`);
  }

  // The board's `done` IS `handoff: complete` (phase-graph.sh:425). Seeing one
  // without the other means the store and the engine have drifted.
  const drifted = board === 'done' && handoff !== 'complete';
  if (drifted) {
    why.push(`board: done but the store reads handoff ${handoff} — re-scan`);
  }

  /* --- a run that did not land ----------------------------------- */

  const recordStatus = tidy(inp.record?.status, 40);
  if (board !== 'done' && recordStatus) {
    const attempts =
      typeof inp.record?.attempts === 'number' && inp.record.attempts > 0
        ? ` · ${plural(inp.record.attempts, 'attempt')}`
        : '';
    why.push(`record: ${recordStatus}${attempts}`);
  }

  /* --- did anything run? ----------------------------------------- */

  const midWork = board === 'in-progress' || board === 'stuck';
  const advisory = midWork ? ' — advisory, the phase is mid-work' : '';

  if (verification === 'none') {
    // Ambiguity 4: a statement about OUR records, never about the work.
    if (board === 'done') why.push('verification: no run of this console verified this phase');
  } else if (verification === 'red') {
    const line =
      v && v.failed > 0
        ? `verification: red (${v.failed}/${v.ran} failed)`
        : `verification: red — ${v && v.reason ? v.reason : 'the recorded summary is not ok'}`;
    why.push(
      board === 'done' ? `${line} — the board reads done, the record disagrees` : `${line}${advisory}`,
    );
  } else if (verification === 'skipped') {
    if (v && v.notRun > 0 && v.ran === 0 && v.skipped === 0) {
      why.push(
        `verification: nothing runnable — ${plural(v.notRun, 'fragment')} left for a person${advisory}`,
      );
    } else if (v && v.skipped > 0) {
      const leads = v.leads.length ? ` (${v.leads.join(', ')})` : '';
      why.push(`verification: every command's lead is missing here${leads} — nothing was proven${advisory}`);
    } else {
      why.push(`verification: a summary was recorded but no command ran — nothing was proven${advisory}`);
    }
  } else if (verification === 'human') {
    const who = v && v.confirmedBy ? v.confirmedBy : 'a person';
    const n = v && v.notRun > 0 ? v.notRun : 1;
    why.push(`verification: ${plural(n, 'manual check')} confirmed by ${who} — no command ran`);
  } else {
    const ok = v ? v.ran - v.failed : 0;
    if (v && v.skipped > 0) {
      const leads = v.leads.length ? ` — ${v.leads.join(', ')} not installed here` : '';
      why.push(`verification: green with ${plural(v.skipped, 'check')} skipped${leads}`);
    } else {
      why.push(`verification: green (${ok}/${v ? v.ran : 0} ok)`);
    }
  }

  // Verified, unrecorded: the commands passed and the paperwork never caught up.
  if (midWork && (verification === 'green' || verification === 'human')) {
    why.push(
      `verification: ${verification === 'human' ? 'confirmed' : 'green'} but the handoff still reads ${handoff}`,
    );
  }

  if (v) {
    // Ambiguity 2 — provenance survives only when we were handed the array.
    if (v.viaTerminal) why.push('verification: a person ran at least one check in a terminal');
    // Gotcha: a suite that passed in the wrong directory and one that passed
    // in the right one look identical afterwards (state.ts:272-279).
    const dir = tidy(inp.record?.verifiedIn, 80);
    if (dir && dir !== '.') why.push(`verification: ran in ${dir}`);
    // Ambiguity 5 — which run answered. Say it or a stale red wins in silence.
    const runId = tidy(inp.record?.runId, 40);
    const at = tidy(inp.record?.verifiedAt, 40);
    if (runId || at) why.push(`verification: from run ${runId || 'unknown'}${at ? `, ${at}` : ''}`);
  }

  /* --- the gate --------------------------------------------------- */

  const qaMode = qaFact.mode;
  if (qa === 'off') {
    why.push('qa: off — no gate on this plan');
  } else if (qa === 'fail') {
    why.push(`qa: ${qaMode} and the recorded verdict is fail — dependents stay blocked`);
  } else if (qa === 'pending') {
    // Ambiguity 6 — quote the word we could not read, so it can be fixed.
    why.push(
      qaFact.result && qaFact.result !== 'pending'
        ? `qa: ${qaMode} and the recorded verdict "${qaFact.result}" is not one of pass/fail/waived/pending — read as no verdict`
        : `qa: ${qaMode} and no verdict is recorded`,
    );
  } else {
    why.push(`qa: ${qaMode} — ${qa}`);
  }

  // A fail row on a phase that is not done is legal, common, and worth saying.
  const strayFail = qaFact.result === 'fail' && board !== 'done';
  if (strayFail) why.push('qa: a fail verdict is recorded for a phase that is not done');
  // ...and a fail row under a gate that reads off is a contradiction we resolve
  // the conservative way: a recorded failure is a recorded failure.
  const mutedFail = qaFact.result === 'fail' && !qaFact.gating;
  if (mutedFail) why.push('qa: the gate reads off but a fail verdict is recorded — treating it as unproven');

  /* --- the verdict ------------------------------------------------ */

  const backed = verification === 'green' || verification === 'human';
  const gateClear = (qa === 'off' || qa === 'pass' || qa === 'waived') && qaFact.result !== 'fail';
  const evidenced = board === 'done' && !drifted && backed && gateClear;

  return { board, handoff, verification, qa, evidenced, why };
}
