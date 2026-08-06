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

import type { AccountView, AuthStatus, RunState } from './api';

/**
 * Does this run's halt look like a sign-in problem?
 *
 * Two independent signals, and the first is the stronger one: if `claude auth
 * status` says signed out, every run is auth-blocked whatever its reason says.
 * The pattern is the fallback for a run that halted *before* the login expired
 * — `run-8134ac98` on this board halted with an "authentication failed" reason,
 * and its reason is the only record of that.
 *
 * A run that names its own account overrides the machine-login probe: `auth`
 * only ever answers for the machine login, and a healthy machine login says
 * nothing about the profile the run was paying with (and vice versa — an
 * expired machine login must not paint an `info`-account run as auth-blocked).
 */
export function looksLikeAuthFailure(
  run: Pick<RunState, 'halt' | 'accountId'> | null | undefined,
  auth?: AuthStatus | undefined,
  account?: AccountView | undefined,
): boolean {
  if (run?.accountId && account && account.id === run.accountId) {
    if (account.authState === 'expired' || account.authState === 'signed-out') return true;
    return /sign(ed)? in|authenticat/i.test(run?.halt?.reason ?? '');
  }
  if (!run?.accountId && auth && auth.loggedIn === false) return true;
  return /sign(ed)? in|authenticat/i.test(run?.halt?.reason ?? '');
}
