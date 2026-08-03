/**
 * The autopilot: what the run is doing, and the controls to change it.
 *
 * Two audiences at once. Sitting at the desk you want the transcript, the costs
 * and the board. On a phone at 11pm you want one question answered — "does this
 * need me?" — so approvals come first, carry their evidence, and are answerable
 * without scrolling past anything.
 *
 * Every number here comes from the server's run state. Nothing is recomputed in
 * the browser, for the same reason the board never is: two sources of truth
 * disagree eventually, and the one on screen is the one that gets believed.
 *
 * ## What changed from the 1,646-line original
 *
 * - **The nine-plus banners are one `StatusStack`** with a declared priority
 *   (`status.tsx`), instead of eleven independent call sites in source order.
 * - **The data plane is TanStack Query**, so the page no longer blanks itself on
 *   every event: the old view held the run in `useState` and set it to `null`
 *   before each refetch. Nothing here calls `refresh()`; the cache is
 *   invalidated by `EVENT_EFFECTS` and re-renders when the answer changes.
 * - **The firehose stays out of the cache.** `run:stream` is subscribed to
 *   directly (`useRunStream`) and appended.
 * - **The monolith is eight modules.** This one is composition and the two
 *   things that genuinely need to live at the top: the `act()` wrapper and the
 *   `busy` label it drives.
 */

import { useCallback, useEffect, useState } from 'react';
import { Empty, Spinner, toast } from '@/components/ui';
import { api, type PlanDetail } from '@/lib/api';
import { useApprovals, useAuth, useConsoleState, useRun, useSkills, useTranscript } from '@/lib/queries';
import { keys } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { isLive } from './defaults';
import { ActivityPanels } from './activity';
import { ApprovalQueue, type Decide } from './approvals';
import { AskBox } from './ask-box';
import { Controls } from './controls';
import { LiveConsole, useLiveLines, useRunStream } from './console';
import { RunHeader, RunTiles } from './header';
import { PhaseTable } from './phase-table';
import { AuthCard, RunStatusStack, StaleServerNote, looksLikeAuthFailure } from './status';
import { RunHistory } from './history';

export function RunView({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const planPhases = detail.phases;
  const planSkills = detail.plan?.sessionBudget?.skills ?? [];

  const client = useQueryClient();
  const { data: state } = useConsoleState();
  // The client is served fresh from disk; the server is whatever Node loaded at
  // startup. Upgrading the skill under a running console leaves this page talking
  // to an API that has no run endpoints, and the honest thing to show is why —
  // not a stack of failed requests.
  const stale = state != null && state.autopilot === false;
  const allowRun = Boolean(state?.allowRun);
  const enabled = !stale;

  const { data: detailRun, isPending } = useRun(slug, enabled);
  const { data: queue } = useApprovals(enabled);
  const { data: auth } = useAuth(enabled);
  const { data: skills } = useSkills(enabled);

  const [busy, setBusy] = useState('');
  const { lines, activity, record, clear, hydrate } = useLiveLines();

  const run = detailRun?.run ?? null;
  const live = isLive(run?.status);

  // Replay before the live stream matters, so the window is populated on arrival
  // rather than waiting for the next thing to happen — which, on a run that
  // already finished, is never.
  const { data: transcript } = useTranscript(slug, run?.id, enabled && Boolean(run));
  useEffect(() => { hydrate(transcript); }, [transcript, hydrate]);

  useRunStream(record, enabled);

  const approvals = (queue ?? []).filter((a) => a.status === 'pending');

  /**
   * Run one action, then re-read.
   *
   * The invalidation is in `finally`, not in `try`, and that is the whole fix. A
   * card answered on a phone leaves this tab holding one that no longer exists;
   * pressing it 404s, the error is toasted — and with the refresh inside the
   * `try` it was skipped, so the phantom stayed on screen and the next press
   * 404'd again. The failure is exactly the case where re-reading matters most.
   *
   * `void`, never `await`: `invalidateQueries` resolves only once the refetch
   * settles, and awaiting it here would hold `busy` set for the length of a
   * network round trip after the action has already landed.
   */
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
      void client.invalidateQueries({ queryKey: keys.run(slug) });
      void client.invalidateQueries({ queryKey: keys.approvals() });
      void client.invalidateQueries({ queryKey: keys.plan(slug) });
    }
  }, [client, slug]);

  const decide: Decide = useCallback((id, decision, reason, remember, rule) => {
    void act('decide', async () => {
      const result = await api.decide(id, decision, reason, remember, rule);
      // The rule is reported back rather than assumed: a card can be answered and
      // the remembering still refused (an unparseable rule), and saying
      // "Approved" to both would hide the half that failed.
      if (result?.error) toast(result.error, 'warn');
      else if (result?.wrote) {
        toast(
          `${decision === 'allow' ? 'Approved' : 'Denied'} · wrote ${result.wrote} (${result.scope})`,
          'ok',
        );
      } else {
        toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
      }
    });
  }, [act]);

  if (stale) return <StaleServerNote />;
  if (isPending && !detailRun) return <Spinner label="Reading run state" />;

  const phases = Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase);
  const history = detailRun?.history ?? [];

  return (
    <div className="flex flex-col gap-4">
      {run && <RunHeader run={run} live={live} eta={detailRun?.eta ?? null} />}

      {/* First, always: a session parked with its hand up is the only thing on
          this page that is waiting on a person. */}
      <ApprovalQueue approvals={approvals} allowRun={allowRun} onDecide={decide} />

      {looksLikeAuthFailure(run, auth) && (
        <AuthCard
          auth={auth}
          allowRun={allowRun}
          onRecheck={() => {
            void client.invalidateQueries({ queryKey: keys.auth() });
            void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
          }}
        />
      )}

      <RunStatusStack
        run={run}
        live={live}
        allowRun={allowRun}
        busy={busy}
        onClearScope={() => void act('scope', async () => {
          await api.runSettings(slug, { onlyPhases: [] });
          toast('Scope cleared — this run continues through the whole plan', 'ok');
        })}
        onGuard={() => void act('profile', async () => {
          await api.runSettings(slug, { permissionProfile: 'guarded' });
          toast('Back to Guarded — the next call that matters raises a card', 'ok');
        })}
      />

      <Controls
        slug={slug}
        run={run}
        live={live}
        busy={busy}
        allowRun={allowRun}
        planPhases={planPhases}
        planSkills={planSkills}
        skills={skills ?? []}
        onAct={act}
      />

      {run && <RunTiles run={run} phases={phases} />}

      {planPhases.length ? (
        <PhaseTable
          slug={slug}
          run={run}
          planPhases={planPhases}
          live={live}
          allowRun={allowRun}
          onAct={act}
        />
      ) : (
        <Empty
          title="No run yet"
          body={`Nothing has been run for ${slug}. Starting one works the same whether the plan is fresh or half finished — the board decides where to begin.`}
        />
      )}

      <ActivityPanels activity={activity} live={live} />

      <LiveConsole
        lines={lines}
        onClear={clear}
        subtitle={run?.activePhase != null ? `phase ${run.activePhase} · ${run.model}` : run?.status ?? 'idle'}
        footer={
          <AskBox
            slug={slug}
            enabled={Boolean(allowRun && live && run?.activePhase != null)}
            allowRun={allowRun}
            phase={run?.activePhase}
          />
        }
      />

      <RunHistory history={history} />
    </div>
  );
}

export default RunView;
