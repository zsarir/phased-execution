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
 *   directly (`useSessionStream`, inside each `SessionPanes`) and appended.
 * - **The monolith is eight modules.** This one is composition and the two
 *   things that genuinely need to live at the top: the `act()` wrapper and the
 *   `busy` label it drives.
 *
 * ## One window per session
 *
 * The page had one console because a run had one session. It can now drive
 * several phases at once, so the console is a tab strip: a **Run** tab carrying
 * the whole run's narration, and one tab per live or queued lane, each owning its
 * own console, task list and tool log (`session-panes.tsx`). Two sessions'
 * sentences in one window is a page that is wrong with nothing on it to say so.
 */

import { useCallback, useState } from 'react';
import { Empty, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@/components/ui';
import { api, type PhaseEta, type PlanDetail, type QueueEntry, type RunState } from '@/lib/api';
import {
  useAccounts,
  useApprovals,
  useAuth,
  useConsoleState,
  useQueue,
  useRun,
  useRunScopes,
  useSessions,
} from '@/lib/queries';
import { keys } from '@/lib/queries';
import { useNow } from '@/lib/clock';
import { elapsed } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { isLive } from './defaults';
import { ApprovalQueue, type Decide } from './approvals';
import { Controls } from './lane-setup';
import { LiveConsole } from './console';
import { RunHeader, RunTiles } from './tiles';
import { PhaseTable } from './phase-table';
import { NextSteps } from './ways-forward';
import {
  QueuedPane,
  SessionPanes,
  laneId,
  lanesOf,
  queueEntryFor,
  resolveTab,
  type Lane,
} from './session-panes';
import { LaneControls, laneFrozen } from './lane-controls';
import { WaitingPane, waitingOf } from './waiting-pane';
import { AuthCard, RunStatusStack, StaleServerNote, looksLikeAuthFailure } from './status-strip';
import { RunHistory } from './history';
import { RecoveryActions } from '@/components/recovery-actions';

export function RunView({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const planPhases = detail.phases;
  const planSkills = detail.plan?.sessionBudget?.skills ?? [];
  const planMcp = detail.plan?.sessionBudget?.mcpServers ?? [];

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

  const [busy, setBusy] = useState('');

  const run = detailRun?.run ?? null;
  const live = isLive(run?.status);

  // Admission — the only place an answer to "why is this not running" can come
  // from, because the answer is always about some OTHER plan. The queue is asked
  // for only when this run actually has a phase in it: on the ordinary page
  // nothing renders the answer, and a request whose result is never read is a
  // request that should not have been made.
  const queuedHere = lanesOf(run).some((lane) => lane.queued);
  const { data: admission } = useQueue(enabled && queuedHere);
  const { data: scopes } = useRunScopes(slug, enabled && Boolean(run));

  const approvals = (queue ?? []).filter((a) => a.status === 'pending');

  /* ---- recovery: what an AI session could put right, and whether one is on it ---- */
  const { data: terminals } = useSessions(state);
  const allowAgent = Boolean(state?.allowAgent);
  // The run's OWN account decides whether this is an auth halt: the machine
  // login's probe says nothing about the profile a pinned run pays with.
  const { data: accountsState } = useAccounts();
  const runAccount = run?.accountId
    ? accountsState?.accounts.find((candidate) => candidate.id === run.accountId)
    : undefined;
  const authFailure = Boolean(looksLikeAuthFailure(run, auth, runAccount));
  const haltPhase = run?.halt?.phase ?? run?.activePhase ?? undefined;

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
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
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
    },
    [client, slug],
  );

  const decide: Decide = useCallback(
    (id, decision, reason, remember, rule) => {
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
    },
    [act],
  );

  if (stale) return <StaleServerNote />;
  if (isPending && !detailRun) return <Spinner label="Reading run state" />;

  const phases = Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase);
  const history = detailRun?.history ?? [];

  return (
    <div className="flex flex-col gap-4">
      {run && (
        <RunHeader run={run} live={live} eta={detailRun?.eta ?? null} phaseEta={detailRun?.phaseEta ?? []} />
      )}

      {/* First, always: a session parked with its hand up is the only thing on
          this page that is waiting on a person. */}
      <ApprovalQueue approvals={approvals} allowRun={allowRun} onDecide={decide} />

      {authFailure && (
        <AuthCard
          auth={auth}
          allowRun={allowRun}
          account={runAccount}
          onRecheck={() => {
            if (run?.accountId) {
              // Re-read THAT account, not the machine login — this is the
              // "I signed in over there, look again" button.
              void api
                .accountRefresh(run.accountId)
                .then(() => client.invalidateQueries({ queryKey: keys.accounts() }))
                .catch(() => client.invalidateQueries({ queryKey: keys.accounts() }));
              return;
            }
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
        onClearScope={() =>
          void act('scope', async () => {
            await api.runSettings(slug, { onlyPhases: [] });
            toast('Scope cleared — this run continues through the whole plan', 'ok');
          })
        }
        onGuard={() =>
          void act('profile', async () => {
            await api.runSettings(slug, { permissionProfile: 'guarded' });
            toast('Back to Guarded — the next call that matters raises a card', 'ok');
          })
        }
        recovery={{
          ...(authFailure ? { authFailure: true } : {}),
          target: {
            slug,
            ...(haltPhase != null ? { phase: haltPhase } : {}),
            ...(run?.id ? { runId: run.id } : {}),
          },
        }}
      />

      {/* The plan-level recovery, one press: confirm the stop against the
          board, stand down what it settled, recover or continue what is real.
          The phase-level offers live on the halt banner and each row. */}
      {run && !live && !run.resolved && ['halted', 'interrupted', 'parked'].includes(run.status) && (
        <RecoveryActions target={{ slug, runId: run.id }} ctx={{ run }} max={2} legend />
      )}

      {/* Every stopped phase's cause in its own words, with the action that
          moves it — a status word alone was a dead end (reported twice). */}
      <NextSteps slug={slug} planPhases={planPhases} run={run} live={live} authFailure={authFailure} />

      <Controls
        slug={slug}
        run={run}
        live={live}
        busy={busy}
        allowRun={allowRun}
        planPhases={planPhases}
        planSkills={planSkills}
        planMcp={planMcp}
        qaMode={detail.summary.qaMode}
        allowWrites={Boolean(state?.allowWrites)}
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
          queue={admission?.entries}
          scopes={scopes?.scopes}
          phaseEta={detail.eta?.perPhase}
          recovery={{
            allowAgent,
            authFailure,
            sessions: terminals?.sessions,
            qaMode: detail.summary.qaMode,
            planSkills,
            allowWrites: Boolean(state?.allowWrites),
          }}
        />
      ) : (
        <Empty
          title="No run yet"
          body={`Nothing has been run for ${slug}. Starting one works the same whether the plan is fresh or half finished — the board decides where to begin.`}
        />
      )}

      {/* The console before the panels.
          What the session is saying right now is the thing you came to read —
          and it carries the ask box, the one control on this page that is only
          useful *while* you are watching. The task list and the tool log are
          the summary of what it said, so they read after it. */}
      {run ? (
        <SessionTabs
          slug={slug}
          run={run}
          live={live}
          allowRun={allowRun}
          enabled={enabled}
          entries={admission?.entries}
          scopes={scopes?.scopes}
          phaseEta={detailRun?.phaseEta ?? []}
          detail={detail}
        />
      ) : (
        <LiveConsole lines={[]} subtitle="idle" />
      )}

      <RunHistory history={history} />
    </div>
  );
}

/**
 * One tab per session, and one for the run itself.
 *
 * The page used to have a single console because a run had a single session. It
 * now drives up to `maxParallel` phases whose scopes do not overlap, and the
 * honest rendering of that is one window each: a phase's console, task list and
 * tool log are about that phase, and merging two of them produces a page that is
 * wrong in a way nothing on it can show.
 *
 * The **Run** tab is deliberately kept and deliberately first. It is the whole
 * run's narration — every lane, unfiltered — which is what this page showed
 * before, what a deep link lands on, and the right view when the question is
 * "what is this run doing" rather than "what is phase 6 doing".
 *
 * Tab state is in the page, not the route: `#/plan/:slug/run` addresses the run,
 * and a lane is a thing that exists for twenty minutes. A URL that outlived its
 * tab would be a link to a pane that is not there.
 */
function SessionTabs({
  slug,
  run,
  live,
  allowRun,
  enabled,
  entries,
  scopes,
  phaseEta,
  detail,
}: {
  slug: string;
  run: RunState;
  live: boolean;
  allowRun: boolean;
  enabled: boolean;
  entries?: QueueEntry[] | undefined;
  scopes?: { phase: number; scope: string[]; conflicts: string[] }[] | undefined;
  phaseEta?: PhaseEta[] | undefined;
  detail: PlanDetail;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const lanes = lanesOf(run);
  // One clock for every lane subtitle — ticking only while something runs.
  const now = useNow(live && lanes.some((lane) => !lane.queued));

  // The second queue: dependency-waiting phases, one aggregate tab. Only while
  // the run is live — a finished run's leftovers belong to the phase table —
  // and never a phase that already has a lane tab (the two snapshots can skew).
  const waiting = live ? waitingOf(detail, new Set(lanes.map((lane) => lane.phase))) : [];

  // Explicit pick while it exists → the sole live lane → Run. See resolveTab.
  const value = picked === 'waiting' && waiting.length ? 'waiting' : resolveTab(picked, lanes);

  return (
    <Tabs value={value} onValueChange={setPicked}>
      <TabsList>
        <TabsTrigger value="run">
          Run
          {lanes.length > 1 && (
            <span className="ml-1.5 font-mono text-2xs text-ink-faint tabular-nums">{lanes.length}</span>
          )}
        </TabsTrigger>
        {lanes.map((lane) => (
          <TabsTrigger key={laneId(lane)} value={laneId(lane)}>
            Phase {lane.phase}
            {lane.queued && <span className="ml-1.5 text-2xs text-ink-faint">queued</span>}
          </TabsTrigger>
        ))}
        {waiting.length > 0 && (
          <TabsTrigger value="waiting">
            Waiting
            <span className="ml-1.5 font-mono text-2xs text-ink-faint tabular-nums">{waiting.length}</span>
          </TabsTrigger>
        )}
      </TabsList>

      {/* `forceMount` on every panel, with the hiding done here.
          A pane that unmounts drops its SSE subscription, so glancing at another
          lane would silently cost every line the first one printed while you
          were away — and the replay endpoint cannot fill that gap, because it is
          fetched once and those lines are newer than it. */}
      <TabsContent value="run" forceMount hidden={value !== 'run'}>
        <SessionPanes
          slug={slug}
          runId={run.id}
          live={live}
          allowRun={allowRun}
          enabled={enabled}
          runLevel
          title="Run console"
          subtitle={run.activePhase != null ? `phase ${run.activePhase} · ${run.model}` : run.status}
          askPhase={run.activePhase}
        />
      </TabsContent>

      {lanes.map((lane) => (
        <TabsContent key={laneId(lane)} value={laneId(lane)} forceMount hidden={value !== laneId(lane)}>
          {lane.queued ? (
            <QueuedPane
              phase={lane.phase}
              entry={queueEntryFor(entries, slug, lane.phase)}
              scope={scopes?.find((s) => s.phase === lane.phase)?.scope}
              control={
                <LaneControls
                  slug={slug}
                  phase={lane.phase}
                  live={live}
                  allowRun={allowRun}
                  frozen={null}
                  queued
                />
              }
            />
          ) : (
            <SessionPanes
              slug={slug}
              runId={run.id}
              phase={lane.phase}
              live={live}
              allowRun={allowRun}
              enabled={enabled}
              subtitle={laneSubtitle(lane, run, now, phaseEta)}
              control={
                <LaneControls
                  slug={slug}
                  phase={lane.phase}
                  live={live && lane.status === 'running'}
                  allowRun={allowRun}
                  frozen={laneFrozen(run, lane.phase)}
                />
              }
            />
          )}
        </TabsContent>
      ))}

      {waiting.length > 0 && (
        <TabsContent value="waiting">
          <WaitingPane rows={waiting} />
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * A lane pane's one-line vitals: status · model · elapsed / ~estimate.
 *
 * The same facts the phases table shows, repeated where the operator is
 * actually looking while a session runs — the pane header — so "how long has
 * this been going and is that normal" never needs a scroll.
 */
function laneSubtitle(lane: Lane, run: RunState, now: number, phaseEta?: PhaseEta[]): string {
  const record = run.phases[String(lane.phase)];
  const started = record?.startedAt ? Date.parse(record.startedAt) : null;
  const eta = phaseEta?.find((estimate) => estimate.phase === lane.phase);
  const clock = started != null ? elapsed(Math.max(0, now - started)) : null;
  const withEta = clock && eta ? `${clock} / ~${elapsed(eta.estMs)}` : clock;
  return [lane.status, run.model, withEta].filter(Boolean).join(' · ');
}

export default RunView;
