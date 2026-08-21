/**
 * The pulse: what a plan is DOING right now, drawn rather than listed.
 *
 * The run page answers "what happened"; this answers the question an operator
 * actually has while a run is alive — which phases are moving this second, in
 * what vehicle, for how long, what is queued behind what, and what is parked
 * waiting on the outside world. One component serves both askers: the plan
 * page mounts it above the route cards with the board in hand, and the global
 * `#/pulse` view mounts one per plan with whatever the run state alone knows.
 *
 * Everything here is derived per render from `RunState` + the board — no
 * stored cursor, same rule as the engine. The only state is the clock tick
 * that keeps the elapsed timers honest while anything is live.
 */

import { useEffect, useState } from 'react';
import { Bot, CircleDashed, Clock3, Eye, Hourglass, Lock, RefreshCw, Snowflake, Terminal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { rungLabel, situationLabelFor } from '@/lib/ladder';
import { runStatusTitle } from '@/lib/status-vocab';
import { RUN_TONE } from '@/views/run/header';
import { RunStrip } from '@/components/charts';
import { Chip } from '@/components/ui';
import { navigate } from '@/router';
import { planHref } from '@shared/routes.js';
import type { ConvergeView, ForeignSession, PhaseRecord, RunState } from '@/lib/api';

/* ---------------- derivation (exported for tests) ---------------- */

export interface PulseLane {
  phase: number;
  title?: string;
  /** How it is running — the vehicle, in words. */
  vehicle: string;
  status: string;
  startedAt?: string;
  model?: string;
  costUsd?: number;
  attempts?: number;
  frozen: boolean;
  sessionId?: string;
}

export interface PulseWait {
  phase: number;
  title?: string;
  kind: 'queued' | 'parked';
  /** The reason, in the run's own words. */
  why: string;
  /** Counts down while set — a park's wake-up, a lock's lease. */
  until?: string;
  since?: string;
  watch?: string[];
}

const LIVE_RUN = new Set(['running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting']);

/** The vehicle a hook-reported session is, in words — the Pulse's other lane kind. */
export function foreignVehicle(session: Pick<ForeignSession, 'kind'>): string {
  return session.kind === 'agent' ? 'Console agent' : session.kind === 'autopilot' ? 'Autopilot session' : 'Terminal session';
}

/**
 * The hook-reported sessions that belong on a plan's pulse: live, and
 * correlated to THIS plan (a lock's `session=`, or the owner and the clock).
 * A lane of the run itself is already drawn from the run; the registry's copy
 * of it (same session id) is not drawn twice.
 */
export function foreignLanesFor(
  sessions: readonly ForeignSession[] | undefined, slug: string, run?: RunState | null,
): ForeignSession[] {
  if (!sessions?.length) return [];
  const own = new Set(Object.values(run?.children ?? {}).map((child) => child.sessionId).filter(Boolean));
  return sessions
    .filter((s) => s.presence === 'live' && s.plan?.slug === slug && !own.has(s.sessionId))
    .sort((a, b) => (a.plan!.phase - b.plan!.phase) || a.startedAt.localeCompare(b.startedAt));
}

/**
 * The convergence loop's last pass, in lines a person can scan: "re-boarded
 * P12 (Never started → Re-board fresh)", "released a stale claim on P3",
 * "left an errand on P5 — …", "looked at P2 — nothing to climb". Every word
 * for a situation or a rung is the shared table's (`lib/ladder.ts`), so the
 * line and the journal agree.
 */
export function convergenceLines(view: ConvergeView): string[] {
  const lines: string[] = [];
  const at = (n: number | null | undefined) => (n == null ? 'the run' : `P${n}`);
  for (const action of view.actions) {
    const prefix = action.ok ? '' : 'failed: ';
    switch (action.kind) {
      case 'relaunch': {
        for (const r of action.reboard ?? []) {
          lines.push(`${prefix}re-boarded P${r.phase} (${situationLabelFor(r.situation)} → ${rungLabel(r.rung, undefined, r.situation)})`);
        }
        for (const n of action.rearm ?? []) lines.push(`${prefix}re-armed P${n}'s lock wait`);
        if (!action.reboard?.length && !action.rearm?.length) lines.push(`${prefix}continued the run — ${action.why}`);
        break;
      }
      case 'heal':
        if (action.launched) {
          lines.push(`${prefix}${at(action.phase)}: ${action.situation ? situationLabelFor(action.situation) : 'healing'}${action.rung ? ` → ${rungLabel(action.rung, undefined, action.situation)}` : ''}`);
        } else {
          lines.push(`${prefix}looked at ${at(action.phase)} — ${action.why}`);
        }
        break;
      case 'release-debris':
        lines.push(`${prefix}released a stale claim on P${action.phase}${action.owner ? ` (${action.owner})` : ''}`);
        break;
      case 'errand':
        lines.push(`${prefix}left an errand on ${at(action.phase)}${action.need ? ` — ${action.need}` : ''}`);
        break;
      default:
        lines.push(`${prefix}left it alone — ${action.why}`);
    }
  }
  if (!lines.length) lines.push(view.noop ? 'nothing to do' : 'nothing to report');
  return lines;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isLiveRun(run: RunState | null | undefined): boolean {
  return Boolean(run && LIVE_RUN.has(run.status));
}

function record(run: RunState, phase: number): PhaseRecord | undefined {
  return run.phases?.[String(phase)];
}

/** Which phases are moving right now, and in what. */
export function pulseLanes(run: RunState, titles?: Map<number, string>): PulseLane[] {
  if (!isLiveRun(run)) return [];
  const lanes = new Map<number, PulseLane>();
  for (const child of Object.values(run.children ?? {})) {
    const rec = record(run, child.phase);
    lanes.set(child.phase, {
      phase: child.phase,
      title: titles?.get(child.phase),
      vehicle: 'Autopilot session',
      status: rec?.status ?? 'running',
      startedAt: rec?.startedAt ?? child.startedAt,
      model: rec?.actualModel ?? rec?.model ?? run.model,
      costUsd: rec?.costUsd,
      attempts: rec?.attempts,
      frozen: Boolean(child.frozen),
      sessionId: child.sessionId,
    });
  }
  // The mirror lane: a single-lane run has an active phase and no `children`.
  if (!lanes.size && run.activePhase != null && run.status === 'running') {
    const rec = record(run, run.activePhase);
    lanes.set(run.activePhase, {
      phase: run.activePhase,
      title: titles?.get(run.activePhase),
      vehicle: 'Autopilot session',
      status: rec?.status ?? 'running',
      startedAt: rec?.startedAt,
      model: rec?.actualModel ?? rec?.model ?? run.model,
      costUsd: rec?.costUsd,
      attempts: rec?.attempts,
      frozen: false,
      sessionId: rec?.sessionId,
    });
  }
  return [...lanes.values()].sort((a, b) => a.phase - b.phase);
}

/** Everything held back — queued behind something, or parked on the world. */
export function pulseWaits(run: RunState, titles?: Map<number, string>): PulseWait[] {
  const waits: PulseWait[] = [];
  for (const rec of Object.values(run.phases ?? {})) {
    if (rec.status === 'queued') {
      waits.push({
        phase: rec.phase,
        title: titles?.get(rec.phase),
        kind: 'queued',
        why: rec.lockWaitSince
          ? 'queued behind a lock another session holds'
          : 'queued for a free lane',
        since: rec.lockWaitSince,
      });
    } else if (rec.status === 'waiting' || (rec.parkedUntil && rec.status !== 'done')) {
      waits.push({
        phase: rec.phase,
        title: titles?.get(rec.phase),
        kind: 'parked',
        why: rec.parkReason ?? 'waiting on something outside this machine',
        until: rec.parkedUntil,
        watch: rec.watch,
      });
    }
  }
  return waits.sort((a, b) => a.phase - b.phase);
}

/* ---------------- time ---------------- */

/** A 1s clock, running only while something is worth timing. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/* ---------------- the panel ---------------- */

export interface PlanPulseProps {
  slug: string;
  run: RunState;
  /** Board facts, when the caller has them (the plan page does). */
  board?: { phase: number; title: string; state: string; dependsOn?: number[] }[];
  /** Global view: the header links to the plan. */
  linkHeader?: boolean;
  className?: string;
  /** Hook-reported sessions working this plan by hand (or in another console) — drawn as lanes of their own kind. */
  foreign?: readonly ForeignSession[];
  /** The convergence loop's last pass on this plan (`GET /api/converge`, SSE `run:converge`) — the convergence line. */
  converge?: ConvergeView | null;
}

export function PlanPulse({ slug, run, board, linkHeader, className, foreign, converge }: PlanPulseProps) {
  const titles = board ? new Map(board.map((p) => [p.phase, p.title])) : undefined;
  const lanes = pulseLanes(run, titles);
  const waits = pulseWaits(run, titles);
  const others = foreignLanesFor(foreign, slug, run);
  const live = isLiveRun(run);
  const now = useNow((live && lanes.length > 0) || others.length > 0);
  // A pass older than a day is history, not a heartbeat; a plan nothing
  // touched in that long reads idle here, whatever the loop once did to it.
  const recentConverge = converge && converge.slug === slug && now - Date.parse(converge.at) < DAY_MS ? converge : null;
  const convergeLines = recentConverge ? convergenceLines(recentConverge) : [];

  // Up next, from the board: open phases whose dependencies are not done yet —
  // the queue the SCHEDULER sees, not just the records the run has touched.
  const upNext = (board ?? [])
    .filter((p) => p.state === 'waiting')
    .filter((p) => !lanes.some((l) => l.phase === p.phase) && !waits.some((w) => w.phase === p.phase))
    .slice(0, 8);

  if (!lanes.length && !waits.length && !live && !others.length && !recentConverge) return null;

  const strip = board
    ? board.map((p) => {
      const rec = run.phases?.[String(p.phase)];
      return {
        phase: p.phase,
        status: rec?.status ?? (p.state === 'done' ? 'done' : p.state === 'ready' ? 'pending' : 'waiting'),
        detail: p.title,
      };
    })
    : Object.values(run.phases ?? {})
      .sort((a, b) => a.phase - b.phase)
      .map((r) => ({ phase: r.phase, status: r.status }));

  return (
    <section
      aria-label={`What ${slug} is doing right now`}
      className={cn('rounded-lg border border-rule bg-surface shadow-card', className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5">
        <span className="relative flex size-2.5 shrink-0" aria-hidden>
          <span className={cn(
            'absolute inline-flex h-full w-full rounded-full',
            live ? 'animate-ping bg-progress/60' : 'bg-ink-faint/40',
          )}
          />
          <span className={cn('relative inline-flex size-2.5 rounded-full', live ? 'bg-progress' : 'bg-ink-faint')} />
        </span>
        {linkHeader
          ? (
            <a
              href={planHref(slug, 'run')}
              className="min-w-0 truncate font-medium text-ink hover:underline"
              onClick={(event) => { event.preventDefault(); navigate(planHref(slug, 'run')); }}
            >
              {slug}
            </a>
          )
          : <span className="font-medium text-ink">Right now</span>}
        <Chip tone={RUN_TONE[run.status as keyof typeof RUN_TONE] ?? 'neutral'} title={runStatusTitle(run.status)}>
          {run.status}
        </Chip>
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
          {money(run.spentUsd)} spent
        </span>
      </header>

      {strip.length > 0 && (
        <div className="px-4 pt-3">
          <RunStrip phases={strip} />
        </div>
      )}

      <div className="flex flex-col gap-1 p-2">
        {lanes.map((lane) => (
          <button
            key={lane.phase}
            type="button"
            disabled={!lane.sessionId}
            onClick={() => lane.sessionId && navigate(planHref(slug, 'run'))}
            className={cn(
              'flex w-full items-center gap-3 rounded-md border-l-4 bg-ground-deep/60 px-3 py-2 text-left',
              lane.frozen ? 'border-gated' : 'border-progress',
            )}
            title={lane.frozen
              ? 'This lane is frozen (SIGSTOP) — Continue lives on the run page'
              : `Phase ${lane.phase} is being worked on right now — open the run page`}
          >
            <span className="font-mono text-lg font-semibold tabular-nums text-ink">P{lane.phase}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{lane.title ?? `Phase ${lane.phase}`}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                <Chip tone={lane.frozen ? 'gate' : 'busy'} dot className={cn(!lane.frozen && 'animate-pulse-soft')}>
                  {lane.frozen
                    ? <><Snowflake size={11} aria-hidden /> frozen</>
                    : <><Bot size={11} aria-hidden /> {lane.vehicle}</>}
                </Chip>
                {lane.status === 'verifying' && <Chip tone="busy">verifying</Chip>}
                {lane.model && <span className="font-mono">{lane.model}</span>}
                {(lane.attempts ?? 0) > 1 && <span>attempt {lane.attempts}</span>}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-sm tabular-nums text-ink" aria-label="running for">
                <Clock3 size={12} className="mr-1 inline-block align-[-1px] text-ink-faint" aria-hidden />
                {lane.startedAt ? fmtElapsed(now - Date.parse(lane.startedAt)) : '—'}
              </span>
              {Boolean(lane.costUsd) && (
                <span className="block font-mono text-2xs tabular-nums text-ink-faint">{money(lane.costUsd!)}</span>
              )}
            </span>
          </button>
        ))}

        {others.map((session) => (
          <div
            key={`foreign-${session.sessionId}`}
            data-testid="foreign-lane"
            className="flex w-full items-center gap-3 rounded-md border-l-4 border-ink-faint/70 bg-ground-deep/40 px-3 py-2"
            title={`${foreignVehicle(session)} ${session.sessionId} — reported by the session-presence hook${session.plan?.strong ? '' : ' (matched by owner and time, not by the lock)'}`}
          >
            <span className="font-mono text-lg font-semibold tabular-nums text-ink">P{session.plan!.phase}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{titles?.get(session.plan!.phase) ?? `Phase ${session.plan!.phase}`}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                <Chip tone="neutral" dot>
                  <Terminal size={11} aria-hidden /> {foreignVehicle(session)}
                </Chip>
                {session.user && <span className="font-mono">{session.user}{session.host ? `@${session.host}` : ''}</span>}
                {session.plan && !session.plan.strong && <span>probably</span>}
                {session.turns > 0 && <span>{session.turns} {session.turns === 1 ? 'turn' : 'turns'}</span>}
              </span>
            </span>
            <span className="shrink-0 font-mono text-sm tabular-nums text-ink" aria-label="in the session for">
              <Clock3 size={12} className="mr-1 inline-block align-[-1px] text-ink-faint" aria-hidden />
              {fmtElapsed(now - Date.parse(session.startedAt))}
            </span>
          </div>
        ))}

        {waits.map((wait) => (
          <div
            key={`${wait.kind}-${wait.phase}`}
            className="flex items-center gap-3 rounded-md border-l-4 border-action/70 bg-ground-deep/40 px-3 py-2"
          >
            <span className="font-mono text-lg font-semibold tabular-nums text-ink-muted">P{wait.phase}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{wait.title ?? `Phase ${wait.phase}`}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                <Chip tone="warn">
                  {wait.kind === 'queued'
                    ? <><Lock size={11} aria-hidden /> queued</>
                    : <><Hourglass size={11} aria-hidden /> waiting</>}
                </Chip>
                <span className="min-w-0 truncate">{wait.why}</span>
                {wait.watch?.map((ref) => (
                  <Chip key={ref} tone="neutral" className="font-mono">
                    <Eye size={10} aria-hidden /> {ref}
                  </Chip>
                ))}
              </span>
            </span>
            <span className="shrink-0 font-mono text-sm tabular-nums text-ink-muted">
              {wait.until
                ? <>wakes in {fmtElapsed(Date.parse(wait.until) - now)}</>
                : wait.since
                  ? <>{fmtElapsed(now - Date.parse(wait.since))} so far</>
                  : null}
            </span>
          </div>
        ))}

        {recentConverge && (
          <div
            data-testid="converge-line"
            className="flex flex-wrap items-start gap-x-2 gap-y-0.5 px-3 py-2 text-2xs text-ink-muted"
            title="The convergence loop's last pass on this plan: at boot, on a docs change, every sweep, a minute after a stop, or on Recover & continue."
          >
            <RefreshCw size={12} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden />
            <span className="text-ink-faint">Converge</span>
            <span className="font-mono text-ink-faint">{recentConverge.trigger} · {fmtElapsed(Math.max(0, now - Date.parse(recentConverge.at)))} ago</span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-x-2">
              {convergeLines.map((line, index) => <span key={index}>{line}</span>)}
            </span>
          </div>
        )}

        {upNext.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-2xs text-ink-muted">
            <CircleDashed size={12} className="text-ink-faint" aria-hidden />
            <span className="mr-1">Up next</span>
            {upNext.map((p) => (
              <Chip key={p.phase} tone="neutral" title={p.title}>
                P{p.phase}
                {p.dependsOn && p.dependsOn.length > 0 && (
                  <span className="text-ink-faint"> after {p.dependsOn.map((d) => `P${d}`).join(' ')}</span>
                )}
              </Chip>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
