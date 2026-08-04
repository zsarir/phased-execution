/**
 * Performing what a "Waiting on you" card offers.
 *
 * The split is deliberate and it is the whole design of this pass: `now.tsx`
 * decides *which* remedies a card has and which are unavailable and why — pure
 * data, testable with no network — and this decides what pressing one does.
 *
 * Every one of them follows the same three rules, learned from the run page's
 * `act()` helper:
 *
 *  - one action in flight at a time, keyed `demand:action`, so a card cannot be
 *    double-fired and the button that is working says so;
 *  - the result is a toast, always, including the failures — a card that
 *    silently does nothing is what these were before;
 *  - the affected queries are invalidated in `finally`, because the case where
 *    re-reading matters most is the one where the request failed.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type RunState } from '@/lib/api';
import { keys } from '@/lib/queries';
import { toast } from '@/components/ui';
import { useReleaseLock } from '@/components/release-lock';
import { startRecovery } from '@/lib/start-recovery';
import type { Demand, DemandAction } from './now';

export function useDemandActions(runs: readonly RunState[]): {
  onAction: (demand: Demand, action: DemandAction) => void;
  busy?: string;
} {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | undefined>();
  const { release, releaseAllExpired } = useReleaseLock();

  const onAction = useCallback((demand: Demand, action: DemandAction) => {
    const key = `${demand.id}:${action.id}`;
    const slug = action.target?.slug;
    const runId = action.target?.runId;
    const run = runId ? runs.find((r) => r.id === runId) : undefined;

    setBusy(key);
    void (async () => {
      try {
        switch (action.id) {
          case 'continue': {
            if (!slug || !run) throw new Error('That run is no longer on the board — reload.');
            // Continue with the settings the run already had, not this
            // console's defaults: the route always sends an autonomy, and a
            // bare continue would quietly move a `halt-on-everything` run to
            // `keep-going`. `onlyPhases` is deliberately not sent — the runner
            // reads its absence as "continue the whole plan".
            await api.runStart(slug, {
              resumeRunId: run.id,
              model: run.model,
              effort: run.effort,
              autonomy: run.autonomy,
              permissionProfile: run.permissionProfile,
            });
            toast(`Continuing ${slug}`, 'ok');
            break;
          }
          case 'dismiss': {
            if (!slug || !runId) throw new Error('That run is no longer on the board — reload.');
            await api.runResolve(slug, runId);
            toast('Dismissed — the run keeps its record on the Runs page', 'ok');
            break;
          }
          case 'login': {
            const result = await api.authLogin();
            toast(
              result.opened
                ? 'A terminal is open on the sign-in — finish there, then choose Check again.'
                : result.detail ?? 'Run `claude auth login` in a terminal.',
              result.opened ? 'ok' : 'warn',
            );
            break;
          }
          case 'recheck': {
            // Forced, not cached: the whole point is to learn that signing in
            // over there worked.
            const fresh = await api.auth(true);
            client.setQueryData(keys.auth(), fresh);
            toast(fresh.loggedIn ? 'Signed in — you can continue the run.' : 'Still signed out.',
              fresh.loggedIn ? 'ok' : 'warn');
            break;
          }
          case 'release': {
            if (!slug || action.target?.phase == null) throw new Error('That claim is gone — reload.');
            await release(slug, action.target.phase);
            break;
          }
          case 'release-all':
            await releaseAllExpired();
            break;
          case 'mark-read': {
            const { changed } = await api.markNotificationsRead();
            toast(changed ? `Marked ${changed} read` : 'Nothing was unread', 'ok');
            break;
          }
          case 'start-recovery': {
            // A live one is a link, not a button — `AttentionRow` renders it as
            // an anchor and never calls this. Reaching here means starting one.
            if (!slug || !action.recoveryClass) throw new Error('That card is stale — reload.');
            await startRecovery(client, {
              recoveryClass: action.recoveryClass,
              slug,
              ...(action.target?.phase != null ? { phase: action.target.phase } : {}),
              ...(runId ? { runId } : {}),
            });
            break;
          }
        }
      } catch (error) {
        toast((error as Error).message, 'error');
      } finally {
        setBusy(undefined);
        void client.invalidateQueries({ queryKey: keys.runs() });
        void client.invalidateQueries({ queryKey: keys.plans() });
        void client.invalidateQueries({ queryKey: keys.stats() });
        void client.invalidateQueries({ queryKey: keys.state() });
      }
    })();
  }, [client, release, releaseAllExpired, runs]);

  return { onAction, busy };
}
