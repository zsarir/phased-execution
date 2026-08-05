/**
 * Closure, read once for the whole client.
 *
 * A plan whose `status:` is terminal is **closed**: the operator has said nobody
 * is coming back to it. The console still renders it in full — closing quiets a
 * plan, it never hides one — but every surface that asks for a person's
 * attention has to skip it, or the estate keeps nagging about work that will
 * never happen.
 *
 * ## Why this file exists rather than a `plan.closed` check at each site
 *
 * The predicate already has two implementations by necessity — `plan_is_closed()`
 * in `scripts/phase-graph.sh` and `isClosedStatus()` in `server/analysis/stats.ts`
 * — because bash and the server each need it before the other can answer. A third
 * would be one too many, so this is the only reading in the client and it prefers
 * the server's own `closed` flag whenever the payload carries it.
 *
 * ## What the server does and does not gate (read this before adding a surface)
 *
 * `healthIssues()` drops the progress issues and demotes the structural ones to
 * `info`, and the **portfolio aggregates** (`totals.ready`, `remainingWeight`,
 * `remainingSessions`, `readyQueue`, `stalled`) exclude closed plans. But a
 * plan's **own** fields are deliberately left honest — `stats.ready` is
 * `board.ready` verbatim, and `locks`, `qaFailures`, `stuck` and `remainingWeight`
 * likewise, because a closed plan's board must still say what never got done.
 *
 * So a closed plan arrives at the client with a populated `ready` array. Anything
 * that turns `ready` into a call to action — the ready board, a "start this"
 * badge, a nav count — MUST filter on `isClosed` itself. That asymmetry is the
 * whole reason this module is exported rather than inlined.
 */

/** The terminal statuses, in the same order and spelling as the server's. */
export const CLOSED_STATUSES = ['complete', 'abandoned', 'superseded'] as const;

export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

/** Just the word — for a payload that carries a status and nothing else. */
export function isClosedStatus(raw?: string): boolean {
  const status = raw?.trim().toLowerCase();
  return status !== undefined && (CLOSED_STATUSES as readonly string[]).includes(status);
}

/** As much of a plan as closure depends on. Anything summary-shaped satisfies it. */
export interface ClosableLike {
  status?: string;
  /** The server's own reading. Absent from an older server, hence the fallback. */
  closed?: boolean;
  closedOn?: string;
  closedReason?: string;
}

/**
 * Is this plan closed?
 *
 * The server's `closed` flag wins when present so the two cannot disagree mid
 * release; the status word is the fallback for a console talking to a server
 * that predates the field.
 */
export function isClosed(plan: ClosableLike | undefined): boolean {
  if (!plan) return false;
  if (typeof plan.closed === 'boolean') return plan.closed;
  return isClosedStatus(plan.status);
}

/**
 * The one-line explanation behind the CLOSED badge.
 *
 * Always leads with the status word, because "closed" alone raises the question
 * this answers: closed *how* — finished, or given up on?
 */
export function closedTitle(plan: ClosableLike | undefined): string {
  if (!plan) return '';
  const status = plan.status?.trim().toLowerCase() || 'closed';
  const parts = [CLOSED_HELP[status as ClosedStatus] ?? `This plan is ${status}.`];
  if (plan.closedReason) parts.push(plan.closedReason);
  if (plan.closedOn) parts.push(`Closed ${plan.closedOn}.`);
  parts.push('It reports no work and no warnings. Reopen it to bring it back.');
  return parts.join('\n\n');
}

/** What each terminal word means — the vocabulary the badge and the Guide share. */
export const CLOSED_HELP: Record<ClosedStatus, string> = {
  complete: 'Every phase is done and the plan was closed out.',
  abandoned: 'Work stopped here deliberately and is not being resumed.',
  superseded: 'Another plan took this one over.',
};
