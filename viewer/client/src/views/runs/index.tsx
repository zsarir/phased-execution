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
 * ## What is not re-implemented here
 *
 * The approval queue, the auth card, the activity panels, the console and its two
 * hooks, and the ask box are all Phase 4's, imported from `views/run/*`. What is
 * specific to "every run at once" is picking the one worth watching, and the
 * fleet itself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Radio } from 'lucide-react';
import { api, type RunState } from '@/lib/api';
import {
  keys, useApprovals, useAuth, useConsoleState, useRuns, useTranscript,
} from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { relativeTime } from '@/lib/format';
import { Banner, Card, Chip, Empty, Skeleton, toast } from '@/components/ui';
import { ActivityPanels } from '../run/activity';
import { ApprovalQueue, type Decide } from '../run/approvals';
import { AskBox } from '../run/ask-box';
import { LiveConsole, useLiveLines, useRunStream } from '../run/console';
import { isLive } from '../run/defaults';
import { AuthCard, StaleServerNote, looksLikeAuthFailure } from '../run/status';
import { Page } from '../_page';
import { Controls } from './controls';
import { Fleet, FleetTiles } from './fleet';
import {
  NO_FILTERS, applyFilters, isSortId, outcomeCounts, planOptions, sortRows, toRows,
  type Filters, type RunRow, type SortId,
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
  const { data: queue } = useApprovals(enabled);
  const { data: auth } = useAuth(enabled);

  const [watchId, setWatchId] = useState<string | undefined>();
  const [local, setLocal] = useState({ query: '', plan: '' });

  const { lines, activity, record, clear, hydrate } = useLiveLines();

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

  const { data: transcript } = useTranscript(
    watching?.slug,
    watching?.id,
    enabled && Boolean(watching) && consoleOpen,
  );
  useEffect(() => { hydrate(transcript); }, [transcript, hydrate]);

  useRunStream(record, enabled);

  const approvals = (queue ?? []).filter((a) => a.status === 'pending');

  /**
   * Answer a card, then re-read — the invalidation in `finally`, not in `try`.
   *
   * A card answered on a phone leaves this tab holding one that no longer
   * exists; pressing it 404s, and that failure is exactly the case where
   * re-reading matters most. `void` rather than `await`, because
   * `invalidateQueries` resolves only once the refetch settles.
   */
  const decide: Decide = useCallback((id, decision, reason, remember, rule) => {
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
  }, [client]);

  const onWatch = useCallback((row: RunRow) => {
    setWatchId(row.id);
    setPrefs({ runsConsole: true });
  }, [setPrefs]);

  /* ---------------- the fleet ---------------- */

  const all = useMemo(() => toRows(runs ?? []), [runs]);
  const filters: Filters = useMemo(
    () => ({ ...local, outcome: prefs.runsOutcome ?? '' }),
    [local, prefs.runsOutcome],
  );
  const sortId: SortId = isSortId(prefs.runsSort) ? prefs.runsSort : 'updated';
  const visible = useMemo(
    () => sortRows(applyFilters(all, filters), sortId),
    [all, filters, sortId],
  );
  const counts = useMemo(() => outcomeCounts(all), [all]);
  const plans = useMemo(() => planOptions(all), [all]);

  const onFilters = (patch: Partial<Filters>) => {
    const { outcome, ...rest } = patch;
    if (outcome !== undefined) setPrefs({ runsOutcome: outcome });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  /* ---------------- the branches ---------------- */

  if (stale) {
    return <Page title="Runs"><StaleServerNote /></Page>;
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
      subtitle={active
        ? `${active.slug} is running — phase ${active.activePhase ?? '?'}`
        : 'Nothing running right now'}
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

        {consoleOpen
          ? (
            <div className="flex flex-col gap-3">
              <ActivityPanels activity={activity} live={Boolean(active)} />
              <LiveConsole
                lines={lines}
                onClear={clear}
                title="Session console"
                subtitle={consoleSubtitle(active, watching)}
                footer={active ? (
                  <AskBox
                    slug={active.slug}
                    enabled={allowRun && active.activePhase != null}
                    allowRun={allowRun}
                    phase={active.activePhase}
                  />
                ) : undefined}
              />
              {!active && (
                <button
                  type="button"
                  onClick={() => { setPrefs({ runsConsole: false }); setWatchId(undefined); }}
                  className="self-start text-2xs text-ink-faint hover:text-action"
                >
                  Hide the console while nothing is running
                </button>
              )}
            </div>
          )
          : <IdleConsole run={watching} onOpen={() => setPrefs({ runsConsole: true })} />}

        {all.length ? (
          <section className="flex flex-col gap-3" aria-label="The fleet">
            <FleetTiles rows={visible} />
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
            {visible.length
              ? (
                <Fleet
                  rows={visible}
                  grouped={Boolean(prefs.runsGroup)}
                  onWatch={onWatch}
                  // Only while the console is actually showing it. A row
                  // reading "In the console" above a console that is folded
                  // away is a claim about something you cannot see.
                  watchingId={consoleOpen ? watching?.id : undefined}
                />
              )
              : (
                <Empty
                  title="No run matches"
                  body={`The fleet holds ${all.length} run${all.length === 1 ? '' : 's'}. Widen the filters to see them.`}
                  action={(
                    <button
                      type="button"
                      className="text-sm text-action hover:underline"
                      onClick={() => { setLocal({ query: '', plan: '' }); setPrefs({ runsOutcome: NO_FILTERS.outcome }); }}
                    >
                      Clear the filters
                    </button>
                  )}
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

/** What the console is showing: the live run, the one you picked, or nothing. */
function consoleSubtitle(active: RunState | undefined, watching: RunState | undefined): string {
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
