/**
 * `#/pulse` — every plan's heartbeat on one page.
 *
 * The same panel the plan page shows, once per plan, live-first: what is
 * being worked on this second across the whole console, what is queued, what
 * is parked, and what just finished. The Runs page is the ledger (every run,
 * sortable, forever); this is the *now* — you glance at it from a phone to
 * answer "is anything moving, and is anything stuck waiting for me".
 *
 * Data is the runs list the fleet already keeps fresh over SSE — no new
 * endpoint, no polling of its own.
 */

import { Activity, Terminal } from 'lucide-react';
import { Chip, Empty } from '@/components/ui';
import { PlanPulse, fmtElapsed, foreignVehicle, isLiveRun, pulseLanes, pulseWaits, useNow } from '@/components/pulse';
import { Page } from '../_page';
import { useConsoleState, useRuns, useSessionRegistry, useConverge } from '@/lib/queries';
import { isResolved } from '@/views/runs/model';
import type { ForeignSession, RunState } from '@/lib/api';
import type { ViewProps } from '@/router';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The one run per plan this page talks about — the newest that still matters. */
export function pulseRuns(runs: readonly RunState[]): RunState[] {
  const newestPerPlan = new Map<string, RunState>();
  for (const run of runs) {
    const seen = newestPerPlan.get(run.slug);
    if (!seen || Date.parse(run.updatedAt) > Date.parse(seen.updatedAt)) {
      newestPerPlan.set(run.slug, run);
    }
  }
  const rank = (run: RunState): number => {
    if (isLiveRun(run)) return 0;
    if (!isResolved(run) && ['halted', 'interrupted', 'parked'].includes(run.status)) return 1;
    return 2;
  };
  return [...newestPerPlan.values()]
    .filter((run) => rank(run) < 2 || Date.now() - Date.parse(run.updatedAt) < DAY_MS)
    .sort((a, b) => rank(a) - rank(b)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Hook-reported sessions that no plan row on this page will draw: live ones
 * with no plan (a `claude` in the repository that claimed nothing) or whose
 * plan has no run to mount a pulse on, plus what ended in the last hour —
 * the "just left" the operator actually asks about.
 */
export function otherSessions(sessions: readonly ForeignSession[] | undefined, rows: readonly RunState[], now = Date.now()): ForeignSession[] {
  if (!sessions?.length) return [];
  const shown = new Set(rows.map((run) => run.slug));
  const own = new Set(rows.flatMap((run) => Object.values(run.children ?? {}).map((child) => child.sessionId)));
  return sessions
    .filter((s) => !own.has(s.sessionId))
    .filter((s) => (s.presence === 'live' && !(s.plan && shown.has(s.plan.slug)))
      || (s.presence === 'ended' && s.endedAt != null && now - Date.parse(s.endedAt) < HOUR_MS))
    .sort((a, b) => (a.presence === 'live' ? 0 : 1) - (b.presence === 'live' ? 0 : 1) || b.lastSeen.localeCompare(a.lastSeen));
}

const HOUR_MS = 60 * 60 * 1000;

export default function PulseView(_props: ViewProps) {
  const { data: state } = useConsoleState();
  const { data: runs } = useRuns(state?.autopilot !== false);
  const { data: registry } = useSessionRegistry();
  const { data: converge } = useConverge(state?.autopilot !== false);
  const rows = pulseRuns(runs ?? []);
  const convergeFor = (slug: string) => converge?.reports.find((report) => report.slug === slug) ?? null;
  const foreign = registry?.sessions;
  const others = otherSessions(foreign, rows);
  const foreignLive = (foreign ?? []).filter((s) => s.presence === 'live').length;
  const now = useNow(others.some((s) => s.presence === 'live'));

  const lanes = rows.reduce((n, run) => n + pulseLanes(run).length, 0);
  const waits = rows.reduce((n, run) => n + pulseWaits(run).length, 0);

  return (
    <Page
      title="Pulse"
      subtitle={lanes || waits || foreignLive
        ? [
          lanes ? `${lanes} ${lanes === 1 ? 'phase' : 'phases'} being worked on right now` : null,
          waits ? `${waits} waiting` : null,
          foreignLive ? `${foreignLive} ${foreignLive === 1 ? 'session' : 'sessions'} reported by the hook` : null,
        ].filter(Boolean).join(' · ')
        : 'What every plan is doing right now'}
    >
      <div className="flex w-full max-w-3xl flex-col gap-4">
        {rows.length === 0 && others.length === 0
          ? (
            <Empty
              icon={<Activity size={28} aria-hidden />}
              title="Nothing is moving"
              body="No plan has a live, queued or recently finished run, and no session has reported itself. Start one from a plan's Autopilot tab and its lanes appear here."
            />
          )
          : rows.map((run) => (
            <PlanPulse key={run.slug} slug={run.slug} run={run} linkHeader foreign={foreign} converge={convergeFor(run.slug)} />
          ))}

        {converge && (
          <p className="text-2xs text-ink-faint" data-testid="converge-status">
            Convergence {converge.automatic
              ? `runs by itself here — at boot, on a docs change, a minute after a stop${converge.everyMs > 0 ? ` and every ${Math.round(converge.everyMs / 60_000)} min` : ''}`
              : 'is manual on this console (runs disabled or --no-converge) — Recover & continue still runs a pass'}
            {converge.pending.length ? ` · ${converge.pending.length} ${converge.pending.length === 1 ? 'pass' : 'passes'} queued` : ''}
            {converge.running.length ? ` · converging ${converge.running.join(', ')}` : ''}.
          </p>
        )}

        {others.length > 0 && (
          <section aria-label="Other sessions" className="rounded-lg border border-rule bg-surface shadow-card">
            <header className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5">
              <Terminal size={14} className="text-ink-faint" aria-hidden />
              <span className="font-medium text-ink">Other sessions</span>
              <span className="text-2xs text-ink-faint">reported by the session-presence hook</span>
            </header>
            <div className="flex flex-col gap-1 p-2">
              {others.map((session) => (
                <div
                  key={session.sessionId}
                  data-testid="other-session"
                  className="flex items-center gap-3 rounded-md border-l-4 border-ink-faint/50 bg-ground-deep/40 px-3 py-2"
                  title={`${foreignVehicle(session)} ${session.sessionId} in ${session.cwd}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {session.plan ? `${session.plan.slug} · P${session.plan.phase}` : session.root ?? session.cwd}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                      <Chip tone={session.presence === 'live' ? 'busy' : 'neutral'} dot={session.presence === 'live'}>
                        {foreignVehicle(session)}{session.presence === 'ended' ? ' · ended' : ''}
                      </Chip>
                      {session.user && <span className="font-mono">{session.user}{session.host ? `@${session.host}` : ''}</span>}
                      <span className="font-mono text-ink-faint">{session.sessionId.slice(0, 8)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-ink-muted">
                    {session.presence === 'live'
                      ? fmtElapsed(now - Date.parse(session.startedAt))
                      : session.endedAt ? `ended ${fmtElapsed(now - Date.parse(session.endedAt))} ago` : null}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
