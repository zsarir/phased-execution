/**
 * The top of the dashboard: what is happening, and what is waiting on a person.
 *
 * These two are separated on purpose. "A run is going" is *information* — it
 * wants a clock and a link and nothing else. "A session is parked on a
 * permission card" is a *demand*, and a demand rendered in the same weight as
 * information is a demand nobody answers. So the live strip is calm and the
 * attention row is the only place on the page that may be amber.
 */

import { AlertTriangle, Bell, Bot, ChevronRight, CircleDot, Hand, Lock, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Card, Chip } from '@/components/ui';
import { useNow } from '@/lib/clock';
import { elapsed, money, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { looksLikeAuthFailure } from '@/lib/failures';
import {
  RECOVERY_LABELS, classifyIssue, classifyRun, liveRecovery,
  type RecoveryClass, type RecoveryTarget,
} from '@/lib/recovery';
import { phaseHref, planHref } from '@shared/routes.js';
import type { HealthIssue, RunState, TerminalSession } from '@/lib/api';
import { isLive } from '../run/defaults';
import { runStatusTitle } from '@/lib/status-vocab';
// Data + dialog only — the wizard never imports the pane, so this does not drag
// xterm into the dashboard chunk. See the note at the top of `agent/wizard.tsx`.
import { NewPlanWizardButton } from '../agent/wizard';

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

/** A run's status as a board word, so the dashboard and the run view agree. */
const RUN_WORD: Record<string, string> = {
  running: 'running',
  waiting: 'waiting on a limit',
  paused: 'paused',
  pausing: 'pausing',
  frozen: 'frozen',
  stopping: 'stopping',
  halting: 'halting',
  halted: 'halted',
  interrupted: 'interrupted',
  finished: 'finished',
};

export function LiveStrip({ runs }: { runs: RunState[] }) {
  const live = runs.filter((r) => isLive(r.status));
  // The clock ticks only while something is actually moving. A frozen session's
  // seconds are not passing in any sense the operator cares about.
  const now = useNow(live.some((r) => r.status === 'running'));

  if (!live.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {live.map((run) => {
        const started = run.child?.startedAt ? Date.parse(run.child.startedAt) : NaN;
        const running = run.status === 'running';
        return (
          <Card
            key={run.id}
            className={cn(
              'state-in-progress overflow-hidden border-progress/45',
              running && 'shadow-card',
            )}
          >
            <a
              href={planHref(run.slug, 'run')}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 hover:bg-surface-raised md:px-4"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <CircleDot size={15} className={cn('shrink-0 text-state', running && 'animate-pulse-soft')} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-display text-lg leading-tight">{run.slug}</span>
                  <span className="block truncate text-2xs text-ink-muted">
                    {run.activePhase != null ? `phase ${run.activePhase} · ` : ''}
                    <span title={runStatusTitle(run.status)}>{RUN_WORD[run.status] ?? run.status}</span>
                    {run.model ? ` · ${run.model}` : ''}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {Number.isFinite(started) && (
                  <Chip mono tone="busy">{elapsed(now - started)}</Chip>
                )}
                <Chip mono>{money(run.spentUsd)}</Chip>
                <span className="text-2xs text-ink-faint">Watch</span>
              </span>
            </a>
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Attention
 * ------------------------------------------------------------------ */

/**
 * What a card can *do* about the thing it is warning you about.
 *
 * Declarative on purpose. `demands()` decides which remedies exist and which
 * are unavailable and why; the dashboard performs them. Keeping the decision
 * pure is what makes "a halted run offers Continue and Dismiss, and Continue is
 * disabled without --allow-run" a fact a test can assert without a server, a
 * fetch mock or a click.
 *
 * `disabled` carries the *reason*, never a boolean: a greyed button with no
 * explanation is the same dead end as no button at all, which is what these
 * cards were.
 */
export type DemandActionId =
  | 'continue' | 'dismiss'
  | 'login' | 'recheck'
  | 'release' | 'release-all'
  | 'mark-read'
  /** The one-press plan recovery: confirm → stand down stale → recover → continue. */
  | 'auto-recover'
  /** The MCP park's one-button remedy: policy → continue, retry the parked phases. */
  | 'mcp-continue'
  /** Phase 4: hand what no rule can settle to a Claude session. */
  | 'start-recovery';

export interface DemandAction {
  id: DemandActionId;
  label: string;
  /** `action` is the one that resolves the card; the rest are `default`. */
  kind?: 'action' | 'default';
  /** Present means the remedy exists but cannot be taken — and says why. */
  disabled?: string;
  /** What it acts on, when the id alone does not say. */
  target?: { slug?: string; runId?: string; phase?: number };
  /** Which briefing to mint, on `start-recovery` only. */
  recoveryClass?: RecoveryClass;
  /**
   * A live session id turns the button into a link to it.
   *
   * Not a disabled state: "already running" is not a missing capability, it is
   * somewhere to go — and a greyed button would hide the one thing the operator
   * now wants, which is that session's terminal.
   */
  runningSessionId?: string;
}

export interface Demand {
  id: string;
  icon: ReactNode;
  label: string;
  detail: string;
  href: string;
  tone: 'action' | 'bad';
  /** The remedies. Empty is allowed — a link is still better than nothing. */
  actions: DemandAction[];
  /** The real issues behind a "plan error" card, expandable in place. */
  issues?: HealthIssue[];
}

/** Why an action is unavailable, in the words that say how to get it. */
const NEEDS_RUN = 'Runs are disabled. Restart the console with --allow-run.';
const NEEDS_WRITES = 'Writes are disabled. Restart the console with --allow-writes.';
const NEEDS_AGENT = 'Agent sessions are disabled. Restart the console with --allow-agent.';

/**
 * The phase a run stopped on.
 *
 * `halt.phase` when the runner recorded one, else whatever was active. A run
 * that halted before reaching any phase has neither, and a recovery for it is
 * plan-wide rather than phase-scoped — which is exactly what `undefined` means
 * downstream.
 */
/**
 * The one ask a person is left with, when the ladder wrote one: what is needed
 * and how to give it, per phase — then the run-level errand. The card's first
 * sentence, ahead of the halt's own words, because it is the sentence that says
 * what to DO. Minimal here; the full surface is the phase's Ways-forward panel.
 */
export function errandText(run: RunState): string | undefined {
  const phased = Object.entries(run.recoveries ?? {})
    .filter(([key, slot]) => slot.errand && /^\d+$/.test(key))
    .map(([, slot]) => slot.errand!)
    .sort((a, b) => a.phase - b.phase);
  const all = [...phased, ...(run.errand ? [run.errand] : [])];
  if (!all.length) return undefined;
  return all.map((e) => `${e.phase ? `phase ${e.phase} needs you — ` : ''}${e.need} (${e.how})`).join(' · ');
}

function haltPhase(run: RunState): number | undefined {
  return run.halt?.phase ?? run.activePhase ?? undefined;
}

/**
 * The recovery button for a target — or the chip that says one is already
 * working on it.
 *
 * One helper rather than four copies, because every surface that offers a
 * recovery needs the same three-way answer: no class fits (offer nothing), a
 * session is live (link to it), or the capability is off (say which flag).
 */
function recoveryAction(
  kind: RecoveryClass | undefined,
  target: RecoveryTarget & { runId?: string },
  { allowAgent, sessions }: { allowAgent: boolean; sessions?: readonly TerminalSession[] },
): DemandAction[] {
  if (!kind) return [];
  const running = liveRecovery(sessions, target);
  return [{
    id: 'start-recovery',
    label: running ? 'Recovery running' : RECOVERY_LABELS[kind],
    recoveryClass: kind,
    target,
    ...(running ? { runningSessionId: running.id } : {}),
    // A live recovery is never "disabled" — the button becomes a way to go
    // watch it. The gate only applies to starting a new one.
    ...(running || allowAgent ? {} : { disabled: NEEDS_AGENT }),
  }];
}

/**
 * Everything that is blocked on a person, in the order it costs to ignore.
 *
 * A permission card stops a session dead, so it leads. A halted run has already
 * stopped and will stay stopped. An expired lock is a phase nobody is working
 * that still looks taken. Health errors are last: they are wrong, but nothing
 * is waiting on them.
 *
 * Every card now carries its own remedy. That is the whole point of this pass:
 * five warnings, five plain links, and the fix for each one somewhere else in
 * the console — a dashboard that can only *report* is a dashboard you learn to
 * scroll past.
 */
export function demands({
  approvals,
  runs,
  unread,
  expiredLocks,
  issues = [],
  allowRun = false,
  allowWrites = false,
  allowAgent = false,
  signedOut = false,
  sessions,
}: {
  approvals: number;
  runs: RunState[];
  unread: number;
  expiredLocks: { slug: string; phase: number }[];
  /** Every health issue; the error-severity ones become the plan-errors card. */
  issues?: HealthIssue[];
  allowRun?: boolean;
  allowWrites?: boolean;
  /** `--allow-agent` — whether a recovery session can be minted at all. */
  allowAgent?: boolean;
  /** `claude auth status` says signed out — every run is auth-blocked. */
  signedOut?: boolean;
  /** Live sessions, so a card that already has a recovery running says so. */
  sessions?: readonly TerminalSession[];
}): Demand[] {
  const out: Demand[] = [];
  const recovery = (kind: RecoveryClass | undefined, target: RecoveryTarget & { runId?: string }) =>
    recoveryAction(kind, target, { allowAgent, sessions });

  if (approvals > 0) {
    out.push({
      id: 'approvals',
      icon: <Hand size={15} aria-hidden />,
      label: plural(approvals, 'permission card'),
      detail: 'A session is parked until you answer.',
      href: '#/runs',
      tone: 'action',
      actions: [],
    });
  }

  // A run the board has moved past — or that someone dismissed — is not waiting
  // on anyone. It keeps its record and its place on the Runs page; it just
  // stops being asked about here. See `server/runner/state.ts`.
  const halted = runs.filter(
    (r) => (r.status === 'halted' || r.status === 'interrupted') && !r.resolved,
  );
  for (const run of halted) {
    const auth = looksLikeAuthFailure(run, signedOut ? { loggedIn: false } as never : undefined);
    const target = { slug: run.slug, runId: run.id };
    out.push({
      id: `halt-${run.id}`,
      icon: <AlertTriangle size={15} aria-hidden />,
      label: `${run.slug} ${run.status}`,
      detail: run.halt?.reason ?? 'The run stopped before it finished.',
      href: planHref(run.slug, 'run'),
      tone: 'bad',
      actions: [
        // Signing in first, because continuing before it is a session that
        // reports success, spends a turn and changes nothing.
        ...(auth
          ? [
            { id: 'login', label: 'Open a sign-in terminal', kind: 'action',
              disabled: allowRun ? undefined : NEEDS_RUN, target } as DemandAction,
            { id: 'recheck', label: 'Check again', target } as DemandAction,
          ]
          : []),
        // The honest first press: confirm the stop against the board, stand
        // down what it settled, recover or continue what is real.
        ...(auth ? [] : [{
          id: 'auto-recover',
          label: 'Recover & continue',
          kind: 'action',
          disabled: allowRun ? undefined : NEEDS_RUN,
          target,
        } as DemandAction]),
        {
          id: 'continue',
          label: 'Continue',
          kind: 'default',
          disabled: allowRun ? undefined : NEEDS_RUN,
          target,
        },
        // The remedy for everything Continue cannot fix. Continue re-runs the
        // phase exactly as it was, which is the right move when the halt was
        // circumstance and the wrong one when the phase itself is broken —
        // that second case is what this is.
        ...recovery(
          classifyRun(run, { authFailure: auth }),
          { slug: run.slug, runId: run.id, ...(haltPhase(run) != null ? { phase: haltPhase(run)! } : {}) },
        ),
        // Never gated: dismissing a card is a judgement about what deserves
        // attention, and a console that cannot even do that is the dead end.
        { id: 'dismiss', label: 'Dismiss', target },
      ],
    });
  }

  // A PARKED run raised no card at all — which is how an MCP-parked plan sat
  // 85 minutes with its one-button remedy unreachable from here. Kind-aware:
  // the MCP park leads with continue-without-servers, a verification park
  // with the plan repair, anything else with Continue.
  const parked = runs.filter((r) => r.status === 'parked' && !r.resolved);
  for (const run of parked) {
    const target = { slug: run.slug, runId: run.id };
    const mcp = run.halt?.kind === 'mcp-preflight';
    out.push({
      id: `parked-${run.id}`,
      icon: <AlertTriangle size={15} aria-hidden />,
      label: `${run.slug} parked`,
      detail: errandText(run) ?? run.halt?.reason ?? run.finishedReason ?? 'Every remaining phase needs a person.',
      href: planHref(run.slug, 'run'),
      tone: 'bad',
      actions: [
        ...(mcp
          ? [{
            id: 'mcp-continue',
            label: 'Continue without these servers',
            kind: 'action',
            disabled: allowRun ? undefined : NEEDS_RUN,
            target,
          } as DemandAction]
          : [{
            id: 'continue',
            label: 'Continue',
            kind: 'action',
            disabled: allowRun ? undefined : NEEDS_RUN,
            target,
          } as DemandAction]),
        ...recovery(
          classifyRun(run),
          { slug: run.slug, runId: run.id, ...(haltPhase(run) != null ? { phase: haltPhase(run)! } : {}) },
        ),
        { id: 'dismiss', label: 'Dismiss', target },
      ],
    });
  }

  if (expiredLocks.length) {
    out.push({
      id: 'locks',
      icon: <Lock size={15} aria-hidden />,
      label: `${plural(expiredLocks.length, 'stale claim')}`,
      detail: `${expiredLocks.map((l) => `${l.slug} P${l.phase}`).join(', ')} — the lease ran out, so the phase reads as taken but nobody is in it.`,
      href: '#/stats',
      tone: 'bad',
      actions: expiredLocks.length === 1
        ? [{
          id: 'release',
          label: `Release ${expiredLocks[0].slug} P${expiredLocks[0].phase}`,
          kind: 'action',
          disabled: allowWrites ? undefined : NEEDS_WRITES,
          target: expiredLocks[0],
        },
        // Releasing frees the phase; taking it over also *does* it. Offered
        // only for a single unambiguous claim — a bulk takeover would mint one
        // session per lock, which is never what one press meant.
        ...recovery('stale-claim-takeover', expiredLocks[0])]
        : [
          { id: 'release-all', label: `Release all ${expiredLocks.length}`, kind: 'action',
            disabled: allowWrites ? undefined : NEEDS_WRITES },
          // Per-lock as well as bulk: one of several stale claims may be one
          // you want to leave alone, and "all or nothing" is not triage.
          ...expiredLocks.map((lock): DemandAction => ({
            id: 'release',
            label: `${lock.slug} P${lock.phase}`,
            disabled: allowWrites ? undefined : NEEDS_WRITES,
            target: lock,
          })),
        ],
    });
  }

  if (unread > 0) {
    out.push({
      id: 'unread',
      icon: <Bell size={15} aria-hidden />,
      label: plural(unread, 'unread notification'),
      detail: 'Runs, gates and failures you have not looked at.',
      href: '#/notifications',
      tone: 'action',
      actions: [{ id: 'mark-read', label: 'Mark all read', kind: 'action' }],
    });
  }

  // Closed plans are already out of this: `healthIssues()` drops the progress
  // kinds and demotes the structural ones to `info`, so a terminal plan cannot
  // produce an `error` here at all. Do not add a second closure check — the
  // severity IS the gate, and a client-side one would silently diverge from the
  // server's the next time the issue kinds change. (`expiredLocks` is the one
  // that does need gating, and gets it in `dashboard/index.tsx` where the plans
  // are — this function only renders what it is handed.)
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    // One card can list errors from several plans, and a repair session works
    // on ONE plan. Offer it only when they all belong to the same one —
    // otherwise the card links to Statistics, where each plan has its own row.
    const slugs = [...new Set(errors.map((issue) => issue.slug))];
    const repairable = slugs.length === 1 ? slugs[0] : undefined;
    out.push({
      id: 'errors',
      icon: <AlertTriangle size={15} aria-hidden />,
      label: plural(errors.length, 'plan error'),
      // The old copy was a hard-coded sentence — "A plan, handoff or index
      // disagrees with the board" — which was not even true of the issue on
      // this board (a recorded QA failure). The card names the real ones now.
      detail: errors.length === 1
        ? `${errors[0].slug}: ${errors[0].message}`
        : `${[...new Set(errors.map((e) => e.slug))].join(', ')} — expand for what each one says.`,
      href: '#/stats',
      tone: 'bad',
      actions: repairable
        ? recovery(classifyIssue(errors[0]), { slug: repairable })
        : [],
      issues: errors,
    });
  }

  return out;
}

/** Where an issue actually lives, so the card can link to it and not to a list. */
export function issueHref(issue: HealthIssue): string {
  switch (issue.kind) {
    // A QA failure is recorded in `test-status.md` next to the handoff.
    case 'qa-fail':
    case 'stale-handoff':
    case 'missing-handoff':
    case 'depends-drift':
    case 'index-drift':
      return issue.phase != null ? phaseHref(issue.slug, issue.phase) : planHref(issue.slug, 'handoffs');
    case 'phase-count':
    case 'undefined-dep':
    case 'engine':
      return planHref(issue.slug, 'route');
    default:
      return issue.phase != null ? phaseHref(issue.slug, issue.phase) : planHref(issue.slug);
  }
}

export function AttentionRow({
  items,
  onAction,
  busy,
}: {
  items: Demand[];
  /** Perform one. The dashboard owns the effects; this component owns nothing. */
  onAction?: (demand: Demand, action: DemandAction) => void;
  /** `${demand.id}:${action.id}` of whatever is in flight. */
  busy?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            'flex h-full flex-col gap-2 rounded-lg border px-3 py-2.5',
            item.tone === 'action'
              ? 'border-action/50 bg-action/8'
              : 'border-blocked/45 bg-blocked/8',
          )}
        >
          {/* The heading is the link; the buttons are siblings of it. It used
              to be one anchor wrapping the whole card, which is exactly why
              nothing actionable could live inside one. */}
          <a href={item.href} className="flex min-w-0 items-start gap-2.5 hover:opacity-80">
            <span className={cn('mt-0.5 shrink-0', item.tone === 'action' ? 'text-action' : 'text-blocked')}>
              {item.icon}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{item.label}</span>
              {/* Clamped, because five of these unclamped is the whole first
                  screen of a phone spent on things the card already named. The
                  page they link to has the full text. */}
              <span className="line-clamp-2 block text-2xs text-ink-muted md:line-clamp-none">
                {item.detail}
              </span>
            </span>
          </a>

          {item.issues?.length ? <IssueList issues={item.issues} /> : null}

          {item.actions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.actions.map((action) => {
                const key = `${action.id}:${action.target?.slug ?? ''}${action.target?.phase ?? ''}`;
                // A recovery already working on this becomes the way to go and
                // watch it, not a dead grey button. It is the only action that
                // can be *in progress somewhere else*.
                return action.runningSessionId ? (
                  <Button key={key} size="sm" variant="default" asChild>
                    <a href={`#/agent/${action.runningSessionId}`}>
                      <Bot size={13} aria-hidden />
                      {action.label}
                    </a>
                  </Button>
                ) : (
                  <Button
                    key={key}
                    size="sm"
                    variant={action.kind === 'action' ? 'action' : 'default'}
                    disabled={Boolean(action.disabled) || busy === `${item.id}:${action.id}`}
                    title={action.disabled}
                    onClick={() => onAction?.(item, action)}
                  >
                    {action.label}
                  </Button>
                );
              })}
            </div>
          )}
          {/* Said once per card rather than per button: three buttons each
              repeating "--allow-run is off" is noise, and none of them says it
              where a screen reader would reach it. */}
          {item.actions.some((a) => a.disabled) && (
            <p className="text-2xs text-ink-faint">
              {[...new Set(item.actions.map((a) => a.disabled).filter(Boolean))].join(' ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The real issues behind a "plan error" card.
 *
 * The card used to render one hard-coded sentence for any number of unrelated
 * problems — an undefined dependency, a blocked handoff and a recorded QA
 * failure all read as "a plan, handoff or index disagrees with the board", and
 * only one of those is even about the board. Each one names itself and links
 * where it actually lives.
 */
function IssueList({ issues }: { issues: HealthIssue[] }) {
  const [open, setOpen] = useState(false);
  if (issues.length === 1) return <IssueLine issue={issues[0]} />;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
      >
        <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
        {open ? 'Hide' : `Show all ${issues.length}`}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1">
          {issues.map((issue, at) => (
            <li key={`${issue.slug}-${issue.kind}-${issue.phase ?? at}`}>
              <IssueLine issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueLine({ issue }: { issue: HealthIssue }) {
  return (
    <a href={issueHref(issue)} className="block min-w-0 text-2xs text-ink-muted hover:text-action">
      <span className="font-mono text-ink-faint">
        {issue.slug}{issue.phase != null ? ` P${issue.phase}` : ''} · {issue.kind}
      </span>{' '}
      {issue.message}
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * The quiet state
 * ------------------------------------------------------------------ */

/**
 * Nothing running and nothing waiting is the normal case, not an empty state.
 * It is also the moment the dashboard is most useful, so it answers the only
 * question left: what would you start?
 */
export function AllQuiet({
  next,
  allowRun,
  allowAgent = false,
}: {
  next?: { slug: string; phase: number; title?: string };
  allowRun: boolean;
  /**
   * Without it the authoring button is simply absent here — a quiet card is not
   * the place to explain a missing flag. The dashboard's New plan card, which
   * is a capability inventory, is where the disabled version and its reason
   * live.
   */
  allowAgent?: boolean;
}) {
  return (
    <Card className="state-ready flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 md:px-4">
      <span className="min-w-0 flex-1 basis-full sm:basis-0">
        <span className="block text-md">Nothing is running.</span>
        {next
          ? (
            <span className="line-clamp-2 block text-2xs text-ink-muted">
              The board&rsquo;s next move is{' '}
              <span className="text-ink">{next.slug} phase {next.phase}</span>
              {next.title ? ` — ${next.title}` : ''}.
            </span>
          )
          : <span className="block text-2xs text-ink-muted">Nothing is ready to start either.</span>}
      </span>
      {/* Outside the `next` gate: with nothing ready, authoring the next plan is
          the ONLY move left, and that is exactly when this card used to offer
          nothing at all. */}
      <span className="flex shrink-0 flex-wrap gap-2">
        {next && (
          <>
            <Button size="sm" variant="action" asChild>
              <a href="#/ready">
                <Play size={13} aria-hidden />
                Open the board
              </a>
            </Button>
            {allowRun && (
              <Button size="sm" asChild>
                <a href={planHref(next.slug, 'run')}>Run it</a>
              </Button>
            )}
          </>
        )}
        {/* Primary only when there is no next move to be primary instead. */}
        <NewPlanWizardButton allowAgent={allowAgent} variant={next ? 'default' : 'action'} />
      </span>
    </Card>
  );
}
