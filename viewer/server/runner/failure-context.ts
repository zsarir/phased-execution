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
