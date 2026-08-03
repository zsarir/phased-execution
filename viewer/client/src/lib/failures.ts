/**
 * Reading a failure well enough to offer the right remedy.
 *
 * A halt reason is prose written by whatever noticed the problem, and the
 * console's job is to turn it into "here is the button". That classification
 * lived inside `views/run/status.tsx`, which made it reachable only from the
 * run page — so the dashboard card for exactly the same halt offered a link and
 * nothing else, even though the fix was one component away.
 *
 * It lives here now because it belongs to no single view: the run page, the
 * runs fleet and the dashboard all ask the same question of the same string.
 */

import type { AuthStatus, RunState } from './api';

/**
 * Does this run's halt look like a sign-in problem?
 *
 * Two independent signals, and the first is the stronger one: if `claude auth
 * status` says signed out, every run is auth-blocked whatever its reason says.
 * The pattern is the fallback for a run that halted *before* the login expired
 * — `run-8134ac98` on this board halted with "authentication failed — run
 * /login in this workspace", and its reason is the only record of that.
 */
export function looksLikeAuthFailure(
  run: Pick<RunState, 'halt'> | null | undefined,
  auth?: AuthStatus | undefined,
): boolean {
  if (auth && auth.loggedIn === false) return true;
  return /sign(ed)? in|authenticat/i.test(run?.halt?.reason ?? '');
}
