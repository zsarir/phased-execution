/**
 * What went wrong last time, written for the session that has to try again.
 *
 * ## The problem this solves
 *
 * A phase whose verification went red is retried by handing its session the
 * SAME boot prompt it got the first time. The engine's prompt is a statement of
 * the job, and it is identical on attempt one and attempt four — so the second
 * session opens knowing everything about what it is supposed to do and nothing
 * about the fact that someone already tried, or that `npm test` came back with
 * eleven failures in one file. It re-derives that by running the suite again,
 * which costs minutes, or it does not re-derive it at all and writes the same
 * code a second time.
 *
 * Everything needed was already on the run record. This module turns it into
 * the paragraph a colleague would have said out loud while handing the work
 * over: here is what failed, here is the exact command, here is the end of its
 * output.
 *
 * ## Why it is capped, and why the cap is small
 *
 * 4 KB. The recovery briefing next door gets 16 KB because it IS the whole
 * prompt; this one is an insert into a boot prompt that already exists, and
 * every byte of it competes with the plan's own instructions for the session's
 * attention. A test log is also the least trustworthy thing here — it describes
 * a tree that has since been edited — so when the budget runs out, evidence is
 * what goes, in the order below. The session can always re-run the command.
 *
 * ## Why it says the repository is right
 *
 * The header tells the session to verify what follows rather than believe it.
 * That is not politeness: this text is a snapshot from before the retry, and a
 * session that treats a stale failure as a live fact will "fix" something that
 * is no longer broken. The one durable rule is that the repository wins.
 *
 * ## Why it is a near-leaf
 *
 * It imports the text helpers from `recovery.ts` (a leaf) and nothing else at
 * runtime, so it is unit-testable with a record literal — no runner, no repo,
 * no spawn. `PhaseRecord` arrives as a type-only import, which is erased.
 */

import { assemble, indent, oneLine, tail, type Block } from '../recovery.ts';
import type { PhaseRecord } from './state.ts';

/**
 * An insert, not a document. Small enough that it cannot crowd out the plan's
 * own words in the prompt it is appended to.
 */
export const MAX_FAILURE_CONTEXT_BYTES = 4096;

/** Enough of a log to see which assertion failed. */
const OUTPUT_TAIL_BYTES = 700;
/** More than three failing commands is a broken tree, not a diagnosis. */
const MAX_FAILED_COMMANDS = 3;
const MAX_NOT_RUN = 6;

/**
 * What the builder reads. A subset of `PhaseRecord`, spelled out so a test can
 * hand it a literal and so it is obvious that nothing else on the record — cost,
 * turns, session ids — belongs in a prompt.
 */
export type FailureFacts =
  Pick<PhaseRecord, 'phase'>
  & Partial<Pick<PhaseRecord, 'attempts' | 'verification' | 'lint' | 'said'>>;

/**
 * The failure paragraph for a phase's next attempt, or `''` when there is
 * nothing to say.
 *
 * `halt` is the run's own halt reason **for this phase** — the caller filters,
 * because a halt recorded against phase 3 explains nothing about phase 5 and
 * quoting it would be worse than silence.
 *
 * Sections are dropped bottom-up when the whole thing is over budget: the
 * attempt count first (the header already implies it), then the session's
 * closing words, the lint line, the commands nobody ran, the failing commands,
 * and last the halt reason. The header is never dropped — without it the
 * session cannot tell a stale report from a live one.
 */
export function failureContext(record: FailureFacts, halt?: string | null): string {
  const blocks = failureBlocks(record, halt);

  // A record with nothing on it gets no insert at all. Appending a bare header
  // that says "here is what happened" followed by nothing is worse than saying
  // nothing: it reads as "the last attempt failed silently".
  if (!blocks.some((block) => block.text.trim())) return '';

  const header = {
    text: [
      `What happened on the previous attempt(s) of phase ${record.phase} — verify against the`,
      'repository; where they disagree the repository is right.',
    ].join('\n'),
  };

  return assemble([header, ...blocks], MAX_FAILURE_CONTEXT_BYTES);
}

/**
 * The evidence paragraphs, without the header — shared by the retry insert
 * above and the re-board briefs below, so a failing command is quoted the same
 * way whichever prompt carries it. Ordered by drop rank (see `failureContext`).
 */
export function failureBlocks(record: FailureFacts, halt?: string | null): Block[] {
  const blocks: Block[] = [];

  if (halt?.trim()) {
    blocks.push({ text: `Why the run stopped: ${oneLine(halt, 400)}`, drop: 60 });
  }

  const failed = (record.verification?.ran ?? []).filter((entry) => !entry.ok);
  if (failed.length) {
    const lines: string[] = ['The verification command(s) that failed:', ''];
    for (const entry of failed.slice(0, MAX_FAILED_COMMANDS)) {
      lines.push(`  $ ${oneLine(entry.command, 200)}`);
      if (entry.code != null) lines.push(`  exit ${entry.code}`);
      if (entry.output) lines.push(indent(tail(entry.output, OUTPUT_TAIL_BYTES)));
      lines.push('');
    }
    blocks.push({ text: lines.join('\n').trimEnd(), drop: 50 });
  } else if (record.verification && !record.verification.ok && record.verification.reason) {
    // No command failed, yet it did not pass — the interesting case is a plan
    // whose verification could not be run at all, and the reason IS the finding.
    blocks.push({ text: `Verification: ${oneLine(record.verification.reason, 300)}`, drop: 50 });
  }

  const notRun = record.verification?.notRun ?? [];
  if (notRun.length) {
    blocks.push({
      text: [
        'Verification the runner would not execute itself (still unproven):',
        '',
        ...notRun.slice(0, MAX_NOT_RUN).map(
          (entry) => `  ${oneLine(entry.text, 160)} — ${oneLine(entry.reason, 120)}`),
      ].join('\n'),
      drop: 40,
    });
  }

  if (record.lint && !record.lint.ok) {
    blocks.push({ text: `The plan stopped linting: ${oneLine(record.lint.summary, 400)}`, drop: 30 });
  }

  if (record.said?.trim()) {
    blocks.push({
      text: ['What the previous session said as it stopped:', '', indent(tail(record.said, 500))].join('\n'),
      drop: 20,
    });
  }

  const attempts = record.attempts ?? 0;
  if (attempts > 0) {
    blocks.push({
      text: `This phase has been attempted ${attempts} time${attempts === 1 ? '' : 's'} already.`,
      drop: 10,
    });
  }

  return blocks;
}

/* ------------------------------------------------------------------ *
 * The re-board briefs — RESUMING and UNBLOCK
 *
 * What the runner appends to the engine's boot prompt (or sends to the phase's
 * own session) when the ladder boards a phase that has history: `resume` for
 * unfinished work on disk, `unblock` for a handoff that declares the phase
 * blocked. Same shape as the retry insert — the engine's text is never
 * rewritten, the brief follows it — and the same rule about evidence: it is a
 * snapshot, the repository wins, and it is shed before the instruction is.
 *
 * Neither brief ever says "do not start new work". That sentence belongs to
 * the closeout, and it was the closeout's brief that looped three times on a
 * phase whose cure was to DO the work ($13, measured).
 * ------------------------------------------------------------------ */

/** A brief is larger than the retry insert (it carries the Outstanding text) and still an insert. */
export const MAX_BRIEF_BYTES = 6 * 1024;
const OUTSTANDING_MAX_BYTES = 1_500;
const MAX_DIRTY_PATHS = 12;

/** Everything a brief may quote. Every field is a fact somebody read; absent means unknown. */
export type BriefFacts = FailureFacts & {
  slug?: string;
  /** The handoff as the store reads it; `exists: false` when none was written. */
  handoff?: { exists: boolean; status?: string; outstanding?: string };
  /** The working tree's answer (`situation.ts` `workEvidence`) plus the first uncommitted paths, when read. */
  work?: { did: boolean | null; why: string; dirty?: number; commits?: number; paths?: string[] };
  /** Where `scripts/` lives, for the outcome commands a brief quotes. Absent: a relative `scripts/` path. */
  scriptsDir?: string;
  /** The run's halt reason FOR THIS PHASE, when the caller has one. */
  halt?: string | null;
};

const outcomeScript = (facts: BriefFacts): string =>
  `bash ${facts.scriptsDir ?? 'scripts'}/phase-outcome.sh ${facts.slug ?? '<slug>'} ${facts.phase}`;

/**
 * The evidence paragraphs a re-board brief carries: the handoff, what it left
 * Outstanding, the working tree, then the retry insert's own blocks (the
 * failing commands, the unrun fragments, the last words, the attempt count).
 */
export function briefEvidence(facts: BriefFacts): Block[] {
  const blocks: Block[] = [];
  const handoff = facts.handoff;
  if (handoff) {
    blocks.push({
      text: handoff.exists
        ? `Handoff: a handoff exists for phase ${facts.phase} and reads "${oneLine(handoff.status ?? 'unknown', 40)}".`
        : `Handoff: none has been written for phase ${facts.phase} yet.`,
      drop: 70,
    });
    if (handoff.outstanding?.trim()) {
      blocks.push({
        text: ['Outstanding, as the handoff left it:', '', indent(tail(handoff.outstanding.trim(), OUTSTANDING_MAX_BYTES))].join('\n'),
        drop: 45,
      });
    }
  }
  const work = facts.work;
  if (work) {
    let line: string;
    if (work.did === null) line = `Working tree: ${oneLine(work.why, 200)}.`;
    else if (!work.did) line = `Working tree: clean — ${oneLine(work.why, 200)}.`;
    else {
      const paths = (work.paths ?? []).slice(0, MAX_DIRTY_PATHS);
      const more = (work.dirty ?? paths.length) - paths.length;
      line = `Working tree: ${oneLine(work.why, 200)}`
        + (paths.length ? ` — uncommitted: ${paths.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '')
        + '.';
    }
    blocks.push({ text: line, drop: 65 });
  }
  blocks.push(...failureBlocks(facts, facts.halt));
  return blocks;
}

/** The RESUMING instruction — SKILL.md Mode 2 step 2, as the autopilot drives it. */
export function resumeInstruction(facts: BriefFacts): string {
  return [
    `RESUMING phase ${facts.phase} — this phase was started before and is NOT finished. You are`,
    'CONTINUING it, not starting it over. Read `git status` and `git diff` FIRST: anything uncommitted',
    'is an earlier session\'s work on this very phase — never `git stash`, `git checkout --` or',
    '`git reset` it away. Re-claim the phase lock (`--force` only when `status` says the lease expired),',
    'then carry the phase to its exit criteria (the handoff\'s Outstanding section, when there is one,',
    'says what is left), run the plan\'s §Verification, commit the changed files with explicit paths, and',
    'write the handoff `complete`. If you must stop with work still left (budget, context), write the',
    'handoff `in-progress` and declare it so the supervisor resumes you instead of reading a failure:',
    `    ${outcomeScript(facts)} partial --reason <budget|context|other>`,
  ].join('\n');
}

/**
 * The boot-prompt insert for a `resume` boarding — or, with `instruction`,
 * the whole prompt for an own-session `continue`: the instruction, then the
 * evidence under a header that says the repository wins.
 */
export function resumeBrief(facts: BriefFacts, instruction: string = resumeInstruction(facts)): string {
  const header = {
    text: [
      'What the supervisor knows about the earlier attempt(s) — verify against the repository;',
      'where they disagree the repository is right.',
    ].join('\n'),
  };
  return assemble([{ text: instruction }, header, ...briefEvidence(facts)], MAX_BRIEF_BYTES);
}

/** The UNBLOCK instruction — one bounded session, explicitly allowed to do the work. */
export function unblockInstruction(facts: BriefFacts): string {
  return [
    `UNBLOCK phase ${facts.phase} — the handoff for this phase declares it BLOCKED, and this is ONE`,
    'bounded unblock session. You are explicitly allowed — asked — to do the work that unblocks it',
    'yourself wherever a machine can: build what is unbuilt, fix what is red, finish what is partial,',
    're-run what timed out. Read `git status` and `git diff` FIRST and never discard earlier work.',
    'If the blocker is genuinely an operator\'s — a credential nobody on this machine holds, a',
    'person\'s approval, a third party, a manual gate — do not improvise around it: declare exactly',
    'what is needed and from whom, then stop:',
    `    ${outcomeScript(facts)} needs-human --reason "<the exact errand: what, from whom>"`,
    'Otherwise carry the phase to its exit criteria, run the plan\'s §Verification, commit the changed',
    'files with explicit paths, and write the handoff `complete`.',
  ].join('\n');
}

/** The boot-prompt insert for an `unblock` boarding: instruction, the Outstanding text, the evidence. */
export function unblockBrief(facts: BriefFacts): string {
  const outstanding = facts.handoff?.outstanding?.trim();
  const blocks: Block[] = [{ text: unblockInstruction(facts) }];
  // Load-bearing, not droppable: the Outstanding text IS what the session is
  // being asked to act on. Capped at source instead.
  blocks.push({
    text: outstanding
      ? ['The handoff\'s Outstanding section, as it was left:', '', indent(tail(outstanding, OUTSTANDING_MAX_BYTES))].join('\n')
      : 'The handoff declares the phase blocked but its Outstanding section is empty — read the handoff itself for the blocker.',
  });
  const rest = briefEvidence({ ...facts, handoff: facts.handoff ? { ...facts.handoff, outstanding: undefined } : facts.handoff });
  return assemble([...blocks, ...rest], MAX_BRIEF_BYTES);
}
