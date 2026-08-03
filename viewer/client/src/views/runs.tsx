/**
 * Operations across every plan: what is running, what is waiting on a person,
 * and the live session console for whichever run is active. This is the page to
 * leave open on a second monitor.
 *
 * Ported from `RunsView`, the second export of `web/views/run.js`. **Nothing is
 * re-ported here** — the approval queue, the activity panels, the console and
 * its two hooks, the ask box, the auth card and the run tone table are all
 * Phase 4's, imported from `views/run/*`. This module is the ~120 lines that
 * are actually specific to "every run at once": picking the run worth watching,
 * and the table of all of them.
 *
 * It is a route of its own rather than a tab of the run view because it answers
 * a different question. `#/plan/:slug/run` is *this plan's* autopilot, with its
 * controls; this is the fleet.
 */

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type RunState } from '@/lib/api';
import {
  keys, useApprovals, useAuth, useConsoleState, useRuns, useTranscript,
} from '@/lib/queries';
import { money, relativeTime } from '@/lib/format';
import {
  Chip, Empty, Skeleton, TBody, TD, TH, THead, TR, Table, TableWrap, toast,
} from '@/components/ui';
import { planHref } from '@shared/routes.js';
import { ActivityPanels } from './run/activity';
import { ApprovalQueue, type Decide } from './run/approvals';
import { AskBox } from './run/ask-box';
import { LiveConsole, useLiveLines, useRunStream } from './run/console';
import { isLive } from './run/defaults';
import { RUN_TONE } from './run/header';
import { AuthCard, StaleServerNote, looksLikeAuthFailure } from './run/status';
import { Page } from './_page';

export default function RunsView() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();

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

  const { data: runs, isPending } = useRuns(enabled);
  const { data: queue } = useApprovals(enabled);
  const { data: auth } = useAuth(enabled);

  const { lines, activity, record, clear, hydrate } = useLiveLines();

  // The run worth watching: the live one, else the most recent. `useRuns`
  // returns them newest-first, so `[0]` is the fallback.
  const active = (runs ?? []).find((r) => isLive(r.status));
  const watching = active ?? runs?.[0];

  const { data: transcript } = useTranscript(
    watching?.slug,
    watching?.id,
    enabled && Boolean(watching),
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
      } catch (error) {
        toast((error as Error).message, 'error');
      } finally {
        void client.invalidateQueries({ queryKey: keys.approvals() });
        void client.invalidateQueries({ queryKey: keys.runs() });
      }
    })();
  }, [client]);

  if (stale) {
    return <Page title="Runs"><StaleServerNote /></Page>;
  }

  if (isPending && !runs) {
    return (
      <Page title="Runs" subtitle="Reading runs">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  const all = runs ?? [];

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

        <ActivityPanels activity={activity} live={Boolean(active)} />

        <LiveConsole
          lines={lines}
          onClear={clear}
          title="Session console"
          subtitle={active
            ? `${active.slug} · phase ${active.activePhase ?? '?'} · ${active.model}`
            : 'idle'}
          footer={active ? (
            <AskBox
              slug={active.slug}
              enabled={allowRun && active.activePhase != null}
              allowRun={allowRun}
              phase={active.activePhase}
            />
          ) : undefined}
        />

        {all.length ? <RunsTable runs={all} /> : (
          <Empty
            title="No runs yet"
            body="Open a plan and use its Autopilot tab to start one. Runs are recorded outside the repository, so nothing here shows up in git status."
          />
        )}
      </div>
    </Page>
  );
}

/** Every run, newest first. The plan cell is a link into that run's own tab. */
function RunsTable({ runs }: { runs: RunState[] }) {
  return (
    <TableWrap>
      <Table>
        <THead>
          <TR>
            <TH>Plan</TH>
            <TH>Run</TH>
            <TH>Status</TH>
            <TH>Phase</TH>
            <TH className="text-right">Spent</TH>
            <TH>Updated</TH>
          </TR>
        </THead>
        <TBody>
          {runs.map((r) => (
            <TR key={`${r.slug}-${r.id}`}>
              <TD>
                <a href={planHref(r.slug, 'run')} className="text-ink hover:text-action">{r.slug}</a>
              </TD>
              <TD><code className="font-mono text-2xs text-ink-faint">{r.id}</code></TD>
              <TD><Chip tone={RUN_TONE[r.status]}>{r.status}</Chip></TD>
              <TD className="font-mono tabular-nums">{r.activePhase ?? '—'}</TD>
              <TD className="text-right font-mono tabular-nums">{money(r.spentUsd)}</TD>
              <TD className="whitespace-nowrap text-2xs text-ink-faint">
                {relativeTime(Date.parse(r.updatedAt))}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}
