/**
 * The session's declared outcome — the machine-readable record that replaces
 * guessing from prose.
 *
 * A session writes it with `scripts/phase-outcome.sh` to a path the runner
 * injects as `PE_OUTCOME_FILE`; the runner reads it once on session exit,
 * journals it, and deletes it. Born from a live run: a phase-8 session ended
 * its turn "waiting on the image build (34–65 min)" in free text, the runner
 * read the clean exit as completion, found no handoff, and halted. The file's
 * absence still means what it always meant — the session declared nothing —
 * so every legacy path is unchanged; the file's presence is new information.
 *
 * Staleness is guarded twice, independently: the runner deletes the path
 * before every spawn, and `readOutcome` rejects anything written before the
 * attempt started or naming a different slug/phase. A leftover file from a
 * crashed attempt must never speak for the next one.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runDir } from './state.ts';

/**
 * `partial` — "work remains; resume me" — is the one a session declares when
 * it must stop before the exit criteria (its budget, its context) without
 * anything being WRONG: the runner reads it as situation `work-in-progress`
 * at once and the ladder's first rung continues the session, where the clean
 * exit used to read as a failed phase and buy a closeout that could not do
 * the work. `reason` conventionally names why: `budget`, `context`, `other`.
 */
export type PhaseOutcomeStatus = 'complete' | 'waiting-external' | 'blocked' | 'needs-human' | 'partial';

export type PhaseOutcome = {
  version: 1;
  slug: string;
  phase: number;
  status: PhaseOutcomeStatus;
  reason?: string;
  /** ISO time the session suggests re-checking at (waiting-external only). */
  resume_after?: string;
  watch: string[];
  written_at: string;
};

const STATUSES: readonly string[] = ['complete', 'waiting-external', 'blocked', 'needs-human', 'partial'];

/** Where a given attempt's outcome file lives, keyed by run and phase. */
export function outcomeFileFor(root: string, slug: string, runId: string, phase: number): string {
  return join(runDir(root, slug), `run-${runId}-p${phase}-outcome.json`);
}

/**
 * Read and validate an outcome file. Returns null for anything that must not
 * be trusted: unreadable, unparseable, wrong slug/phase, unknown status, or
 * written before this attempt started. Null is always safe — it degrades to
 * the legacy "the session declared nothing" path.
 */
export function readOutcome(
  path: string,
  expect: { slug: string; phase: number; notBefore?: string },
): PhaseOutcome | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: Partial<PhaseOutcome>;
  try {
    parsed = JSON.parse(raw) as Partial<PhaseOutcome>;
  } catch {
    return null;
  }
  if (parsed.version !== 1) return null;
  if (parsed.slug !== expect.slug) return null;
  if (parsed.phase !== expect.phase) return null;
  if (typeof parsed.status !== 'string' || !STATUSES.includes(parsed.status)) return null;
  if (typeof parsed.written_at !== 'string' || !parsed.written_at) return null;
  if (expect.notBefore && parsed.written_at < expect.notBefore) return null;
  const watch = Array.isArray(parsed.watch)
    ? parsed.watch.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0).slice(0, 8)
    : [];
  return {
    version: 1,
    slug: parsed.slug,
    phase: parsed.phase,
    status: parsed.status as PhaseOutcomeStatus,
    ...(typeof parsed.reason === 'string' && parsed.reason ? { reason: parsed.reason.slice(0, 500) } : {}),
    ...(typeof parsed.resume_after === 'string' && parsed.resume_after
      ? { resume_after: parsed.resume_after }
      : {}),
    watch,
    written_at: parsed.written_at,
  };
}

/** Remove a consumed (or stale) outcome file. Never throws — best-effort. */
export function consumeOutcome(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch { /* best-effort */ }
}
