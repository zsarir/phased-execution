/**
 * Which failure a recovery session is for, decided from what a page already
 * holds.
 *
 * The server owns the prompt; this owns the *offer*. A card knows it is looking
 * at a halted run, a failed phase row or a plan error — this turns that into the
 * one class whose briefing actually fits, so a button never launches a session
 * told the wrong story.
 *
 * Pure, and deliberately free of React and of `api.ts`: the choosing rules are
 * the part worth testing without a network, and `test/recovery-sessions.test.ts`
 * imports this file directly to hold `RECOVERY_CLASSES` equal to the server's.
 */

/**
 * Mirrors `server/recovery.ts` — the server is the source of truth and refuses
 * anything off this list by name. A test asserts the two arrays are identical,
 * so drift fails the suite rather than a click.
 */
export const RECOVERY_CLASSES = [
  'halted-verification',
  'halted-missing-handoff',
  'interrupted-resume',
  'auth-interrupted',
  'stale-claim-takeover',
  'plan-repair',
] as const;

export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

/** What the button says. Short enough to sit beside Continue and Dismiss. */
export const RECOVERY_LABELS: Record<RecoveryClass, string> = {
  'halted-verification': 'Fix with AI',
  'halted-missing-handoff': 'Finish with AI',
  'interrupted-resume': 'Resume with AI',
  'auth-interrupted': 'Resume with AI',
  'stale-claim-takeover': 'Take over with AI',
  'plan-repair': 'Repair with AI',
};

/** What it will actually do, for the title attribute and the confirm copy. */
export const RECOVERY_BLURBS: Record<RecoveryClass, string> = {
  'halted-verification':
    'Opens a Claude session that diagnoses the failing verification, fixes the cause and finishes the phase.',
  'halted-missing-handoff':
    'Opens a Claude session that checks the phase against the repository and writes the handoff it never wrote.',
  'interrupted-resume':
    'Opens a Claude session that reads the working tree, claims the phase and carries it to its exit criteria.',
  'auth-interrupted':
    'Opens a Claude session that picks the phase up now that the CLI is signed in again.',
  'stale-claim-takeover':
    'Opens a Claude session that takes the expired claim and finishes the phase.',
  'plan-repair':
    'Opens a Claude session that repairs the plan, its handoffs or its INDEX until validate.sh passes.',
};

/** What a recovery session is attached to. Two of these match when both agree. */
export type RecoveryTarget = { slug?: string; phase?: number };

/**
 * The identity a duplicate is judged by — `(slug, phase)`, not the class.
 *
 * Two sessions repairing one phase from different angles edit the same files,
 * and the second one is never what anyone meant to press. Mirrors
 * `recoveryKey` on the server, which enforces it.
 */
export function recoveryKey(target: RecoveryTarget): string {
  return `${target.slug ?? ''}#${target.phase ?? ''}`;
}

/** A minimal session shape, so this file need not import the API types. */
type SessionLike = {
  id: string;
  exited?: unknown;
  meta?: { recovery?: { kind: string; slug?: string; phase?: number; runId?: string } };
};

/**
 * The live recovery session for a target, if one is running.
 *
 * Read off the sessions list every page already holds, which is what makes the
 * button become a chip with no extra request — and makes it change back the
 * moment the `sessions` event says the process ended.
 */
export function liveRecovery<T extends SessionLike>(
  sessions: readonly T[] | undefined,
  target: RecoveryTarget,
): T | undefined {
  if (!sessions?.length) return undefined;
  const key = recoveryKey(target);
  return sessions.find((session) =>
    !session.exited && session.meta?.recovery && recoveryKey(session.meta.recovery) === key);
}

/* ------------------------------------------------------------------ *
 * Choosing the class
 * ------------------------------------------------------------------ */

/**
 * The runner's own words, matched rather than guessed at.
 *
 * `runner.ts` writes exactly two shapes of halt worth a distinct briefing: a
 * phase whose verification commands came back red, and a session that ended
 * cleanly having never written a handoff (`closed()`'s "the board still
 * reads…"). Matching the reason text is what lets a card offer the right one
 * without a second request for the diagnosis.
 */
const NO_HANDOFF = /no handoff was written|not marked complete|ended cleanly but the board/i;
const VERIFICATION = /did not verify|failing validate\.sh|verification/i;

type RunLike = {
  status: string;
  halt?: { reason: string } | null;
  resolved?: unknown;
};

/**
 * Which recovery a stopped run wants — or `undefined` when none does.
 *
 * Order matters and is the whole content of this function. Authentication
 * first, because every other reading of an auth halt is wrong and the fix is
 * not an AI session at all (the server refuses to mint one while signed out).
 * Then the two halts the runner names precisely. An interruption, or a halt
 * whose reason matches nothing, falls to the generic resume: assess the tree,
 * claim, carry on — which is true of any run that stopped mid-phase.
 */
export function classifyRun(
  run: RunLike | null | undefined,
  opts: { authFailure?: boolean } = {},
): RecoveryClass | undefined {
  if (!run) return undefined;
  if (run.status !== 'halted' && run.status !== 'interrupted') return undefined;
  if (opts.authFailure) return 'auth-interrupted';

  const reason = run.halt?.reason ?? '';
  if (NO_HANDOFF.test(reason)) return 'halted-missing-handoff';
  if (VERIFICATION.test(reason)) return 'halted-verification';
  return 'interrupted-resume';
}

/**
 * Which recovery a phase row wants.
 *
 * A phase table knows its own record's status, which is more specific than the
 * run's: a `failed` phase failed a check, an `interrupted` one never got to
 * finish. `done` and `skipped` want nothing — the invariant is that a recovery
 * is only ever offered for a phase that is genuinely stuck.
 */
export function classifyPhase(
  status: string,
  run?: RunLike | null,
  opts: { authFailure?: boolean } = {},
): RecoveryClass | undefined {
  if (opts.authFailure) return 'auth-interrupted';
  switch (status) {
    case 'failed':
      // The run's halt reason is the only thing that distinguishes "verification
      // went red" from "nothing was ever written down", and both land here.
      return NO_HANDOFF.test(run?.halt?.reason ?? '') ? 'halted-missing-handoff' : 'halted-verification';
    case 'interrupted':
    case 'running':
    case 'verifying':
    case 'pending':
      return 'interrupted-resume';
    default:
      return undefined;
  }
}

/** Every health issue is repaired by the same class; the prompt branches by kind. */
export function classifyIssue(issue: { severity?: string }): RecoveryClass | undefined {
  return issue.severity === 'error' || issue.severity === 'warning' ? 'plan-repair' : undefined;
}

/**
 * Classification for a phase the BOARD calls stuck — a handoff whose
 * frontmatter reads blocked/in-progress. Such a phase often has no run record
 * at all (the work happened in another session), so `classifyPhase` has
 * nothing to read; the board state itself is the fact. The repair is
 * plan-repair's stale-handoff job: establish what really happened, finish it
 * if finishable, and set the status the repository supports.
 */
export function classifyBoardPhase(state: string): RecoveryClass | undefined {
  return state === 'stuck' ? 'plan-repair' : undefined;
}
