/**
 * The client half of the recovery vocabulary — now a re-export.
 *
 * Every word (labels, blurbs, titles), every classifier and the pure
 * action function live in `shared/recovery-model.js`, imported by this
 * client, by `server/recovery.ts` and by `server/service.ts` alike — so a
 * button, a tooltip, a notification and the unattended healer can never
 * drift apart again. What stays here is the client-only glue: the live
 * session lookup that turns a button into a chip, typed against the shapes
 * a page already holds.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// (`test/recovery-sessions.test.ts` precedent) and node resolves no Vite alias.
export {
  MECHANISMS,
  MECHANISM_LEGEND,
  WAYS_FORWARD,
  HALT_KINDS,
  KIND_PROFILE,
  RECOVERY_CLASSES,
  RECOVERY_TITLES,
  RECOVERY_LABELS,
  RECOVERY_BLURBS,
  ACTION_VOCAB,
  FLAG_OFF,
  RECOVERY_BUSY,
  NO_HANDOFF_OFFER_RE,
  VERIFICATION_OFFER_RE,
  recoveryActionsFor,
  recoveryKey,
} from '../../../shared/recovery-model.js';

import {
  classifyRun as classifyRunShared,
  classifyPhase as classifyPhaseShared,
  classifyIssue as classifyIssueShared,
  classifyBoardPhase as classifyBoardPhaseShared,
  recoveryKey as keyOf,
} from '../../../shared/recovery-model.js';

/** The run shape the classifiers read — matches what every page holds. */
export type RunLike = {
  status: string;
  halt?: { reason?: string; kind?: string; phase?: number } | null;
  resolved?: unknown;
};

/* The shared classifiers are JSDoc-typed as `string | undefined`; these
 * wrappers narrow the answers to the class union the components expect. */

export function classifyRun(
  run: RunLike | null | undefined, opts: { authFailure?: boolean } = {},
): RecoveryClass | undefined {
  return classifyRunShared(run, opts) as RecoveryClass | undefined;
}

export function classifyPhase(
  status: string, run?: RunLike | null, opts: { authFailure?: boolean } = {},
): RecoveryClass | undefined {
  return classifyPhaseShared(status, run, opts) as RecoveryClass | undefined;
}

export function classifyIssue(issue: { severity?: string }): RecoveryClass | undefined {
  return classifyIssueShared(issue) as RecoveryClass | undefined;
}

export function classifyBoardPhase(state: string): RecoveryClass | undefined {
  return classifyBoardPhaseShared(state) as RecoveryClass | undefined;
}

/** Mirrors `server/recovery.ts` — narrowed here for TS; the runtime array is shared. */
export type RecoveryClass =
  | 'halted-verification'
  | 'halted-missing-handoff'
  | 'interrupted-resume'
  | 'auth-interrupted'
  | 'stale-claim-takeover'
  | 'plan-repair';

/** What a recovery session is attached to. Two of these match when both agree. */
export type RecoveryTarget = { slug?: string; phase?: number };

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
  const key = keyOf(target);
  return sessions.find((session) =>
    !session.exited && session.meta?.recovery && keyOf(session.meta.recovery) === key);
}
