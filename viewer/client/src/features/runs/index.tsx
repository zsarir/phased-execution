/**
 * Runs — the fleet, and whatever it is asking of you.
 *
 * This is a route of its own rather than a tab of the run view because it
 * answers a different question. `#/plan/:slug/run` is *this plan's* autopilot,
 * with its controls; this is every run there has ever been.
 *
 * ## Ordered by urgency, not by category
 *
 * The same rule the dashboard follows. A session parked with its hand up outranks
 * a session that is merely running, which outranks the record of two hundred that
 * have finished. So: approvals, then the login that is blocking one, then the
 * live console, then the fleet.
 *
 * ## The console gets out of the way
 *
 * It used to occupy a fixed sixteen rems whether or not anything was running,
 * which pushed the page's actual content below the fold on every screen and
 * fetched a transcript nobody had asked to read. Now a live run opens it and an
 * idle one collapses it to a line naming the last run — expandable, and only
 * then is the transcript fetched.
 *
 * ## Every live session, not the one that happened to be first
 *
 * The console watched a single run, which was the whole truth until a pool could
 * drive several at once — and then it was a page about "every run there has ever
 * been" that could show exactly one of the two that were live, with nothing on
 * screen admitting the other existed. It is a tab strip now, one per live lane
 * across every plan, labelled `slug · P<n>` because two tabs reading "Phase 5"
 * here are two different plans.
 *
 * The single console survives for the case that has no lane: a finished run you
 * picked in order to re-read it.
 *
 * ## What is not re-implemented here
 *
 * The approval queue, the auth card, and the session panes (console, panels, ask
 * box) all come from `views/run/*`. What is specific to "every run at once" is
 * picking which lane to watch, and the fleet itself.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Radio } from 'lucide-react';
import { api, type QueueEntry, type RunState } from '@/lib/api';
import {
  keys,
  useApprovals,
  useAuth,
  useConsoleState,
  usePlans,
  useQueue,
  useRuns,
  useSpend,
} from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { relativeTime } from '@/lib/format';
import {
  Banner,
  Card,
  Chip,
  Empty,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@/components/ui';
import { ApprovalQueue, type Decide } from './approvals';
import { LiveConsole } from './console';
import { isLive } from './defaults';
import { LaneControls, laneFrozen } from './lane-controls';
import {
  QueuedPane,
  SessionPanes,
  crossLaneId,
  lanesAcross,
  queueEntryFor,
  type Lane,
} from './session-panes';
import { AuthCard, StaleServerNote, looksLikeAuthFailure } from './status-strip';
import { Page } from '@/views/_page';
import { Controls } from './fleet-toolbar';
import { Fleet, FleetTiles } from './fleet-table';
import {
  NO_FILTERS,
  applyFilters,
  isSortId,
  outcomeCounts,
  planOptions,
  sortRows,
  toRows,
  type Filters,
  type RunRow,
  type SortId,
} from './model';

export default function RunsView() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  // The client is served fresh from disk; the server is whatever Node loaded at
  // startup. Upgrading the skill under a running console leaves this page
  // talking to an API that has no run endpoints, and the honest thing to show
  // is why — not a stack of failed requests.
  //
  // `enabled` waits for `/api/state` to answer rather than assuming the server
  // is current: `stale` is false while the state query is still pending, so
  // gating on `!stale` alone fires every run request once *before* learning the
  // endpoints are not there — the 404s this check exists to prevent.
  const stale = state != null && state.autopilot === false;
  const enabled = state != null && !stale;
  const allowRun = Boolean(state?.allowRun);

  const { data: runs, isPending, error } = useRuns(enabled);
  // The day cap's own figure, not the sum of the rows on screen — see
  // `FleetTiles`. Held here so the tiles stay a pure render of what they are
  // given, which is what lets them be tested without a query client.
  const { data: spend } = useSpend(enabled);
  const { data: queue } = useApprovals(enabled);
  const { data: auth } = useAuth(enabled);

  const [watchId, setWatchId] = useState<string | undefined>();
  const [tab, setTab] = useState<string | undefined>();
  const [local, setLocal] = useState({ query: '', plan: '' });

  // The run worth watching: whichever one you picked, else the live one, else
  // the most recent. `useRuns` returns them newest-first, so `[0]` is the
  // fallback. A pick wins over a live run — you asked for that one.
  const active = (runs ?? []).find((r) => isLive(r.status));
  const picked = watchId ? (runs ?? []).find((r) => r.id === watchId) : undefined;
  const watching = picked ?? active ?? runs?.[0];

  // Open when something is running, or when you opened it. A collapsed console
  // fetches nothing: a transcript is the largest payload this console reads, and
  // reading one to render a box nobody expanded is the cost the old page paid on
  // every visit.
  const consoleOpen = Boolean(active) || prefs.runsConsole;

  /* ---------------- every live session, whoever owns it ---------------- */

  /**
   * This page's question is "every run there has ever been", so its console has
   * to reach every session there is now — including two plans running at once,
   * which the single watched console could not express at all. It showed one
   * run's lines and no way to know the others existed.
   */
  const lanes = useMemo(() => lanesAcross((runs ?? []).filter((r) => isLive(r.status))), [runs]);
  const { data: admission } = useQueue(enabled && lanes.some((l) => l.queued));

  // A pick of a FINISHED run is a request to read that one, and there is no lane
  // for it — so the old single console survives exactly for that, and for a page
  // with nothing live at all.
  const replaying = picked && !isLive(picked.status) ? picked : lanes.length ? undefined : watching;

  const approvals = (queue ?? []).filter((a) => a.status === 'pending');

  /**
   * Answer a card, then re-read — the invalidation in `finally`, not in `try`.
   *
   * A card answered on a phone leaves this tab holding one that no longer
   * exists; pressing it 404s, and that failure is exactly the case where
   * re-reading matters most. `void` rather than `await`, because
   * `invalidateQueries` resolves only once the refetch settles.
   */
  const decide: Decide = useCallback(
    (id, decision, reason, remember, rule) => {
      void (async () => {
        try {
          const result = await api.decide(id, decision, reason, remember, rule);
          if (result?.error) toast(result.error, 'warn');
          else if (result?.wrote) {
            toast(
              `${decision === 'allow' ? 'Approved' : 'Denied'} · wrote ${result.wrote} (${result.scope})`,
              'ok',
            );
          } else {
            toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
          }
        } catch (err) {
          toast((err as Error).message, 'error');
        } finally {
          void client.invalidateQueries({ queryKey: keys.approvals() });
          void client.invalidateQueries({ queryKey: keys.runs() });
        }
      })();
    },
    [client],
  );

  // Clearing the tab is what makes Watch mean anything once there are several:
  // with a tab explicitly chosen, the pick would set `watchId` and change
  // nothing on screen. Cleared, the derivation below follows the pick.
  const onWatch = useCallback(
    (row: RunRow) => {
      setWatchId(row.id);
      setTab(undefined);
      setPrefs({ runsConsole: true });
    },
    [setPrefs],
  );

  /**
   * Dismiss a stopped run's card, or put it back.
   *
   * The manual half of the resolver the read path applies automatically. Both
   * write the same annotation; neither deletes anything, so this row stays
   * exactly where it is — it just stops being counted as waiting on someone.
   */
  const [resolvingId, setResolvingId] = useState<string | undefined>();
  const onResolve = useCallback(
    (row: RunRow, resolve: boolean) => {
      setResolvingId(row.id);
      void (async () => {
        try {
          await (resolve ? api.runResolve(row.slug, row.id) : api.runUnresolve(row.slug, row.id));
          toast(resolve ? 'Dismissed — it will stop asking' : 'Back on the dashboard', 'ok');
        } catch (err) {
          toast((err as Error).message, 'error');
        } finally {
          setResolvingId(undefined);
          void client.invalidateQueries({ queryKey: keys.runs() });
        }
      })();
    },
    [client],
  );

  /**
   * Freeze / continue / stop a run from its fleet row — whole-run verbs. The
   * per-session versions live in the run's console tabs, where a session has a
   * face; a table row only honestly refers to the run entire.
   */
  const onLifecycle = useCallback(
    (row: RunRow, verb: 'freeze' | 'thaw' | 'stop') => {
      setResolvingId(row.id);
      void (async () => {
        try {
          if (verb === 'freeze') {
            const { run: after } = await api.runFreeze(row.slug);
            const held = after?.status === 'frozen' || Boolean(after?.freeze);
            toast(
              held
                ? `${row.slug} frozen — its sessions are stopped where they stood`
                : `Nothing to freeze on ${row.slug}.`,
              held ? 'ok' : 'warn',
            );
          } else if (verb === 'thaw') {
            const { run: after } = await api.runThaw(row.slug);
            const still = after?.status === 'frozen' || Boolean(after?.freeze);
            toast(
              still
                ? `${row.slug} could not be continued — open the autopilot and look at the status`
                : `${row.slug} continued — the sessions pick up mid-token`,
              still ? 'warn' : 'ok',
            );
          } else {
            await api.runStop(row.slug);
            toast(`${row.slug} stopping — sessions get SIGTERM and the run winds down`, 'ok');
          }
        } catch (err) {
          toast((err as Error).message, 'error');
        } finally {
          setResolvingId(undefined);
          void client.invalidateQueries({ queryKey: keys.runs() });
        }
      })();
    },
    [client],
  );

  /* ---------------- the fleet ---------------- */

  const all = useMemo(() => toRows(runs ?? []), [runs]);
  const filters: Filters = useMemo(
    () => ({ ...local, outcome: prefs.runsOutcome ?? '' }),
    [local, prefs.runsOutcome],
  );
  const sortId: SortId = isSortId(prefs.runsSort) ? prefs.runsSort : 'updated';
  const visible = useMemo(() => sortRows(applyFilters(all, filters), sortId), [all, filters, sortId]);
  const counts = useMemo(() => outcomeCounts(all), [all]);
  const plans = useMemo(() => planOptions(all), [all]);
  // The repos each plan touches — what decides what may run beside it. From
  // the (cached) plans list; a missing summary just means no chips.
  const { data: summaries } = usePlans(enabled);
  const reposBySlug = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const s of summaries ?? []) {
      // PlanSummary is deliberately loose on the wire; narrow at the point of use.
      const repos = Array.isArray(s.repos) ? s.repos.filter((r): r is string => typeof r === 'string') : [];
      if (repos.length) map[s.slug] = repos;
    }
    return map;
  }, [summaries]);

  const onFilters = (patch: Partial<Filters>) => {
    const { outcome, ...rest } = patch;
    if (outcome !== undefined) setPrefs({ runsOutcome: outcome });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  /* ---------------- the branches ---------------- */

  if (stale) {
    return (
      <Page title="Runs">
        <StaleServerNote />
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Runs">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  if (isPending && !runs) {
    return (
      <Page title="Runs" subtitle="Reading runs">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Runs"
      subtitle={
        active
          ? `${active.slug} is running — phase ${active.activePhase ?? '?'}`
          : 'Nothing running right now'
      }
      actions={approvals.length ? <Chip tone="warn">{approvals.length} waiting on you</Chip> : undefined}
    >
      <div className="flex flex-col gap-4">
        {/* First, always: a session parked with its hand up is the only thing
            on this page that is waiting on a person. */}
        <ApprovalQueue approvals={approvals} allowRun={allowRun} onDecide={decide} />

        {looksLikeAuthFailure(active ?? null, auth) && (
          <AuthCard
            auth={auth}
            allowRun={allowRun}
            onRecheck={() => {
              void client.invalidateQueries({ queryKey: keys.auth() });
              void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
            }}
          />
        )}

        {consoleOpen ? (
          <div className="flex flex-col gap-3">
            {replaying ? (
              <SessionPanes
                slug={replaying.slug}
                runId={replaying.id}
                live={isLive(replaying.status)}
                allowRun={allowRun}
                enabled={enabled}
                title="Session console"
                subtitle={consoleSubtitle(active, replaying)}
                askPhase={isLive(replaying.status) ? replaying.activePhase : null}
              />
            ) : lanes.length ? (
              <LaneTabs
                lanes={lanes}
                runs={runs}
                picked={tab}
                onPick={setTab}
                preferredRunId={picked && isLive(picked.status) ? picked.id : undefined}
                allowRun={allowRun}
                enabled={enabled}
                entries={admission?.entries}
              />
            ) : (
              // Opened on a source that has never run anything: an empty tab
              // strip is a thinner nothing than the console saying what it
              // would show, and that copy is the whole point of opening it.
              <LiveConsole lines={[]} title="Session console" subtitle="idle" />
            )}
            {!active && (
              <button
                type="button"
                onClick={() => {
                  setPrefs({ runsConsole: false });
                  setWatchId(undefined);
                }}
                className="self-start text-2xs text-ink-faint hover:text-action"
              >
                Hide the console while nothing is running
              </button>
            )}
          </div>
        ) : (
          <IdleConsole run={watching} onOpen={() => setPrefs({ runsConsole: true })} />
        )}

        {all.length ? (
          <section className="flex flex-col gap-3" aria-label="The fleet">
            <FleetTiles rows={visible} spend={spend} />
            <Card className="p-3">
              <Controls
                sortId={sortId}
                onSort={(id) => setPrefs({ runsSort: id })}
                filters={filters}
                onFilters={onFilters}
                grouped={Boolean(prefs.runsGroup)}
                onGrouped={(value) => setPrefs({ runsGroup: value })}
                counts={counts}
                plans={plans}
                hidden={all.length - visible.length}
              />
            </Card>
            {visible.length ? (
              <Fleet
                rows={visible}
                grouped={Boolean(prefs.runsGroup)}
                reposBySlug={reposBySlug}
                onWatch={onWatch}
                // Only while the console is actually showing it. A row
                // reading "In the console" above a console that is folded
                // away is a claim about something you cannot see.
                watchingId={consoleOpen ? watching?.id : undefined}
                onResolve={onResolve}
                onLifecycle={onLifecycle}
                allowRun={allowRun}
                busyId={resolvingId}
              />
            ) : (
              <Empty
                title="No run matches"
                body={`The fleet holds ${all.length} run${all.length === 1 ? '' : 's'}. Widen the filters to see them.`}
                action={
                  <button
                    type="button"
                    className="text-sm text-action hover:underline"
                    onClick={() => {
                      setLocal({ query: '', plan: '' });
                      setPrefs({ runsOutcome: NO_FILTERS.outcome });
                    }}
                  >
                    Clear the filters
                  </button>
                }
              />
            )}
          </section>
        ) : (
          <Empty
            title="No runs yet"
            body="Open a plan and use its Autopilot tab to start one. Runs are recorded outside the repository, so nothing here shows up in git status."
          />
        )}
      </div>
    </Page>
  );
}

/**
 * Every live session on the machine, one tab each.
 *
 * Labelled `slug · P<n>` rather than by phase alone, because on this page two
 * tabs reading "Phase 5" are two different plans — the fact the run page can take
 * for granted and this one cannot.
 *
 * `forceMount` for the reason it is used on the run page: a pane that unmounts
 * unsubscribes, and the lines it misses while hidden are newer than the replay
 * that would otherwise have covered them.
 */
function LaneTabs({
  lanes,
  runs,
  picked,
  onPick,
  preferredRunId,
  allowRun,
  enabled,
  entries,
}: {
  lanes: readonly Lane[];
  /** The runs behind the lanes — where each lane's freeze is recorded. */
  runs: readonly RunState[] | undefined;
  picked: string | undefined;
  onPick: (id: string) => void;
  /** The run the fleet's Watch button asked for, until a tab is chosen by hand. */
  preferredRunId: string | undefined;
  allowRun: boolean;
  enabled: boolean;
  entries?: QueueEntry[] | undefined;
}) {
  const ids = lanes.map(crossLaneId);
  const runOf = (lane: Lane) => (runs ?? []).find((run) => run.id === lane.runId);
  const preferred = preferredRunId
    ? ids[lanes.findIndex((lane) => lane.runId === preferredRunId)]
    : undefined;
  const value = picked && ids.includes(picked) ? picked : (preferred ?? ids[0] ?? '');

  return (
    <Tabs value={value} onValueChange={onPick}>
      <TabsList>
        {lanes.map((lane) => (
          <TabsTrigger key={crossLaneId(lane)} value={crossLaneId(lane)}>
            <span className="font-mono">{lane.slug}</span>
            <span className="ml-1.5 text-ink-faint">P{lane.phase}</span>
            {lane.queued && <span className="ml-1.5 text-2xs text-ink-faint">queued</span>}
          </TabsTrigger>
        ))}
      </TabsList>

      {lanes.map((lane) => (
        <TabsContent
          key={crossLaneId(lane)}
          value={crossLaneId(lane)}
          forceMount
          hidden={value !== crossLaneId(lane)}
        >
          {lane.queued ? (
            <QueuedPane
              phase={lane.phase}
              entry={queueEntryFor(entries, lane.slug, lane.phase)}
              control={
                <LaneControls
                  slug={lane.slug}
                  phase={lane.phase}
                  live
                  allowRun={allowRun}
                  frozen={null}
                  queued
                />
              }
            />
          ) : (
            <SessionPanes
              slug={lane.slug}
              runId={lane.runId}
              phase={lane.phase}
              live
              allowRun={allowRun}
              enabled={enabled}
              title={`${lane.slug} · phase ${lane.phase}`}
              subtitle={lane.status}
              control={
                <LaneControls
                  slug={lane.slug}
                  phase={lane.phase}
                  live={lane.status === 'running'}
                  allowRun={allowRun}
                  frozen={laneFrozen(runOf(lane), lane.phase)}
                />
              }
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** What the console is showing: the live run, the one you picked, or nothing. */
function consoleSubtitle(active: RunState | undefined, watching: RunState | undefined): string {
  if (watching && !isLive(watching.status)) return `${watching.slug} · ${watching.id} · ${watching.status}`;
  if (active) return `${active.slug} · phase ${active.activePhase ?? '?'} · ${active.model}`;
  if (watching) return `${watching.slug} · ${watching.id} · ${watching.status}`;
  return 'idle';
}

/**
 * The console, folded away.
 *
 * It still names what it would show, because "Session console" alone gives no
 * reason to press it — and the reason is usually that the last run is the one
 * you came to read about.
 */
function IdleConsole({ run, onOpen }: { run: RunState | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-rule bg-surface-raised px-3 py-2 text-left hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)"
    >
      <Radio size={14} className="shrink-0 text-ink-faint" aria-hidden />
      <span className="shrink-0 text-sm">Session console</span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
        {run
          ? `idle · last: ${run.slug} ${run.status} ${relativeTime(Date.parse(run.updatedAt))}`
          : 'idle · nothing has run in this source'}
      </span>
      <ChevronRight size={14} className="shrink-0 text-ink-faint" aria-hidden />
    </button>
  );
}
