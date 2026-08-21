/**
 * The top of the dashboard: what is happening, and what is waiting on a person.
 *
 * These two are separated on purpose. "A run is going" is *information* — it
 * wants a clock and a link and nothing else. "A session is parked on a
 * permission card" is a *demand*, and a demand rendered in the same weight as
 * information is a demand nobody answers. So the live strip is calm and the
 * attention row is the only place on the page that may be amber.
 */

import { AlertTriangle, Bot, ChevronRight, CircleDot, Hand, KeyRound, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Card, Chip } from '@/components/ui';
import { ErrandCard } from '@/components/errand';
import { useNow } from '@/lib/clock';
import { elapsed, money, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { looksLikeAuthFailure } from '@/lib/failures';
import { errandsOf, situationLabelFor } from '@/lib/ladder';
import {
  RECOVERY_LABELS,
  classifyRun,
  liveRecovery,
  type RecoveryClass,
  type RecoveryTarget,
} from '@/lib/recovery';
import { phaseHref, planHref } from '@shared/routes.js';
import type { Errand, HealthIssue, RunState, TerminalSession } from '@/lib/api';
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
            className={cn('state-in-progress overflow-hidden border-progress/45', running && 'shadow-card')}
          >
            <a
              href={planHref(run.slug, 'run')}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 hover:bg-surface-raised md:px-4"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <CircleDot
                  size={15}
                  className={cn('shrink-0 text-state', running && 'animate-pulse-soft')}
                  aria-hidden
                />
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
                  <Chip mono tone="busy">
                    {elapsed(now - started)}
                  </Chip>
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
  | 'continue'
  | 'dismiss'
  | 'login'
  | 'recheck'
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
  /** The errands behind the card — what is needed and how, per phase — rendered in place. */
  errands?: Errand[];
}

/** Why an action is unavailable, in the words that say how to get it. */
const NEEDS_RUN = 'Runs are disabled. Restart the console with --allow-run.';
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
  const all = errandsOf(run);
  if (!all.length) return undefined;
  return all.map(errandLine).join(' · ');
}

/** One errand as one sentence: "phase 4 needs you — <need> (<how>)". */
function errandLine(e: Errand): string {
  return `${e.phase ? `phase ${e.phase} needs you — ` : ''}${e.need} (${e.how})`;
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
  return [
    {
      id: 'start-recovery',
      label: running ? 'Recovery running' : RECOVERY_LABELS[kind],
      recoveryClass: kind,
      target,
      ...(running ? { runningSessionId: running.id } : {}),
      // A live recovery is never "disabled" — the button becomes a way to go
      // watch it. The gate only applies to starting a new one.
      ...(running || allowAgent ? {} : { disabled: NEEDS_AGENT }),
    },
  ];
}

/**
 * Everything that is blocked on a person — and ONLY that — in the order it
 * costs to ignore.
 *
 * Since the convergence loop, "waiting on you" has a narrow meaning: a
 * permission card (a session stopped dead until you answer), a sign-in (no
 * session can give it), and the ERRANDS the ladder leaves — the one ask per
 * phase when every automatic rung is spent or the situation was a person's
 * from the start (a manual gate, a credential, a blocker no machine category
 * fits). A halted run with no errand is not waiting on you: the loop
 * classifies it and climbs, or writes the errand that brings it here. The only
 * stop that still raises a card without one is a stop nothing automatic will
 * touch — a run that opted out of auto-recovery, or a console that cannot run
 * — and that card says so in the errand's own shape.
 *
 * Every card carries its own remedy, disabled with the reason when it cannot
 * be taken — a dashboard that can only *report* is a dashboard you learn to
 * scroll past.
 */
export function demands({
  approvals,
  runs,
  allowRun = false,
  allowAgent = false,
  signedOut = false,
  sessions,
}: {
  approvals: number;
  runs: RunState[];
  allowRun?: boolean;
  /** `--allow-agent` — whether a recovery session can be minted at all. */
  allowAgent?: boolean;
  /** `claude auth status` says signed out — every run under the machine login is auth-blocked. */
  signedOut?: boolean;
  /** Live sessions, so a card that already has a recovery running says so. */
  sessions?: readonly TerminalSession[];
}): Demand[] {
  const out: Demand[] = [];
  const recovery = (kind: RecoveryClass | undefined, target: RecoveryTarget & { runId?: string }) =>
    recoveryAction(kind, target, { allowAgent, sessions });
  const needRun = allowRun ? undefined : NEEDS_RUN;

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

  // A sign-in is intrinsically human: no session can do it, and nothing under
  // the machine login starts or resumes until someone does.
  if (signedOut) {
    out.push({
      id: 'sign-in',
      icon: <KeyRound size={15} aria-hidden />,
      label: 'Claude is signed out on this machine',
      detail:
        'Nothing can start or resume under the machine login until you sign in — claude auth login, or a console profile under Settings ▸ Accounts.',
      href: '#/settings',
      tone: 'bad',
      actions: [
        { id: 'login', label: 'Open a sign-in terminal', kind: 'action', disabled: needRun },
        { id: 'recheck', label: 'Check again' },
      ],
    });
  }

  // A run the board has moved past — or that someone dismissed — is not
  // waiting on anyone. It keeps its record and its place on the Runs page; it
  // just stops being asked about here. See `server/runner/state.ts`.
  const stopped = runs.filter((r) => !r.resolved && !isLive(r.status) && r.status !== 'finished');

  // The ladder's errands: one card per run, leading with the first ask.
  for (const run of stopped) {
    const errands = errandsOf(run);
    if (!errands.length) continue;
    const lead = errands[0];
    const auth =
      looksLikeAuthFailure(run, signedOut ? ({ loggedIn: false } as never) : undefined) ||
      errands.some((e) => e.situation === 'resource-wall:auth');
    const mcp = run.halt?.kind === 'mcp-preflight' || errands.some((e) => e.situation === 'mcp-unavailable');
    const target = { slug: run.slug, runId: run.id };
    const phase = lead.phase || haltPhase(run);
    out.push({
      id: `errand-${run.id}`,
      icon: <Hand size={15} aria-hidden />,
      label: `${run.slug} — ${
        errands.length === 1
          ? lead.phase
            ? `phase ${lead.phase} needs you`
            : 'needs you'
          : `${errands.length} phases need you`
      }`,
      detail: `${situationLabelFor(lead.situation)}: ${errandLine(lead)}${errands.length > 1 ? ` · +${errands.length - 1} more` : ''}`,
      href: planHref(run.slug, 'run'),
      tone: 'bad',
      errands,
      actions: [
        // Signing in first, because continuing before it is a session that
        // reports success, spends a turn and changes nothing.
        ...(auth
          ? [
              {
                id: 'login',
                label: 'Open a sign-in terminal',
                kind: 'action',
                disabled: needRun,
                target,
              } as DemandAction,
              { id: 'recheck', label: 'Check again', target } as DemandAction,
            ]
          : []),
        // An MCP errand's one-button remedy: carry on without the servers.
        ...(mcp
          ? [
              {
                id: 'mcp-continue',
                label: 'Continue without these servers',
                kind: 'action',
                disabled: needRun,
                target,
              } as DemandAction,
            ]
          : []),
        // "I did what it asked — look again": the honest press after an
        // errand. It re-reads the board, stands down what the errand settled,
        // and continues or climbs what is left.
        ...(auth || mcp
          ? []
          : [
              {
                id: 'auto-recover',
                label: 'Recover & continue',
                kind: 'action',
                disabled: needRun,
                target,
              } as DemandAction,
            ]),
        { id: 'continue', label: 'Continue', kind: 'default', disabled: needRun, target },
        ...recovery(classifyRun(run, { authFailure: auth }), {
          slug: run.slug,
          runId: run.id,
          ...(phase != null ? { phase } : {}),
        }),
        // Never gated: dismissing a card is a judgement about what deserves
        // attention, and a console that cannot even do that is the dead end.
        { id: 'dismiss', label: 'Dismiss', target },
      ],
    });
  }

  // Stops nothing automatic will touch. The loop climbs only runs that opted
  // into auto-recovery, and only from a console that may run — a stop outside
  // that is the operator's, and it is said in the errand's own shape so the
  // card reads like every other ask. An operator's own stop is not an ask.
  for (const run of stopped) {
    if (errandsOf(run).length) continue;
    if (!(run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked')) continue;
    if (run.stoppedBy === 'operator') continue;
    if (allowRun && run.autoRecover) continue; // the loop owns it: it climbs, or it writes the errand
    const auth = looksLikeAuthFailure(run, signedOut ? ({ loggedIn: false } as never) : undefined);
    const target = { slug: run.slug, runId: run.id };
    const phase = haltPhase(run);
    const errand: Errand = {
      phase: phase ?? 0,
      situation: 'unknown',
      tried: [],
      need: !allowRun
        ? 'A console that may run — this one is read-only for runs, so nothing climbs this stop by itself.'
        : 'Your decision — auto-recovery is off for this run, so nothing climbs this stop by itself.',
      how: !allowRun
        ? 'Restart the console with --allow-run, then press Recover & continue (or Continue).'
        : 'Press Recover & continue to let the ladder climb once, Continue to resume as it was, or Dismiss.',
      at: run.halt?.at ?? run.updatedAt ?? '',
    };
    out.push({
      id: `halt-${run.id}`,
      icon: <AlertTriangle size={15} aria-hidden />,
      label: `${run.slug} ${run.status}`,
      detail:
        run.halt?.reason ?? errandText(run) ?? run.finishedReason ?? 'The run stopped before it finished.',
      href: planHref(run.slug, 'run'),
      tone: 'bad',
      errands: [errand],
      actions: [
        ...(auth
          ? [
              {
                id: 'login',
                label: 'Open a sign-in terminal',
                kind: 'action',
                disabled: needRun,
                target,
              } as DemandAction,
              { id: 'recheck', label: 'Check again', target } as DemandAction,
            ]
          : [
              {
                id: 'auto-recover',
                label: 'Recover & continue',
                kind: 'action',
                disabled: needRun,
                target,
              } as DemandAction,
            ]),
        { id: 'continue', label: 'Continue', kind: 'default', disabled: needRun, target },
        ...recovery(classifyRun(run, { authFailure: auth }), {
          slug: run.slug,
          runId: run.id,
          ...(phase != null ? { phase } : {}),
        }),
        { id: 'dismiss', label: 'Dismiss', target },
      ],
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
            item.tone === 'action' ? 'border-action/50 bg-action/8' : 'border-blocked/45 bg-blocked/8',
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

          {item.errands?.length ? <ErrandList errands={item.errands} /> : null}

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
 * The errands behind a card — the ask itself, in place. One renders whole;
 * several fold behind the first, because five asks unfolded is the whole
 * first screen of a phone spent on what the card already named.
 */
function ErrandList({ errands }: { errands: Errand[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? errands : errands.slice(0, 1);
  return (
    <div className="flex flex-col gap-1.5" data-testid="demand-errands">
      {shown.map((errand) => (
        <ErrandCard
          key={`${errand.phase}-${errand.situation}-${errand.at}`}
          errand={errand}
          situationLabel={situationLabelFor(errand.situation)}
          compact
        />
      ))}
      {errands.length > 1 && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          {open ? 'Hide' : `Show all ${errands.length}`}
        </button>
      )}
    </div>
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
        {next ? (
          <span className="line-clamp-2 block text-2xs text-ink-muted">
            The board&rsquo;s next move is{' '}
            <span className="text-ink">
              {next.slug} phase {next.phase}
            </span>
            {next.title ? ` — ${next.title}` : ''}.
          </span>
        ) : (
          <span className="block text-2xs text-ink-muted">Nothing is ready to start either.</span>
        )}
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
