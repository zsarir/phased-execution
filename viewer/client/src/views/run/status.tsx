/**
 * Everything the run needs to tell you, in one ordered place.
 *
 * ## What this replaces
 *
 * The old run view grew its notices one at a time, each rendered wherever it
 * happened to be written: a read-only banner, a halt, a wait-window, a pause, a
 * freeze, a paused-between-phases, a finished-reason, a scope, a permission
 * profile, a usage warning. Eleven `Banner` call sites, none of which knew the
 * others existed. On a real run three or four were live at once, in source order
 * rather than importance, and together they pushed the approval queue — the one
 * thing that actually needs a person — below the fold on a phone.
 *
 * So the notices became data. `runNotes()` is a pure function from run state to
 * an ordered list, and the ordering is a single declared priority rather than
 * the order somebody happened to add code in.
 *
 * ## The order, and why it is this one
 *
 * ```
 * approval > halt/ended > pause > frozen > waiting-window > budget
 *          > scoped > profile > read-only
 * ```
 *
 * It descends by *how much it needs you*. An approval is a session parked with
 * its hand up. A halt is a run that has stopped and will not restart itself. A
 * pause or a freeze is a state somebody asked for and is waiting on. A usage
 * window is a thing that will bite later. Scope, profile and read-only are
 * standing facts about how this run was configured — worth knowing, never
 * urgent.
 *
 * ## Where the count of nine went
 *
 * §Phase 4 names nine slots. `web/views/run.js` has **eleven** `Banner` call
 * sites plus two cards, and the reconciliation is exact:
 *
 * - `pausing` and `paused` are one slot (`pause`) — they are two spellings of a
 *   pause at different distances, and they are mutually exclusive statuses.
 * - `finishedReason` was unnamed in the plan's list. It is kept as its own slot
 *   (`ended`) rather than folded into `halt`, because a run that finished
 *   cleanly must not render under a heading called Halted; the two are mutually
 *   exclusive by construction (`!run.halt` guards it).
 * - `approval` is the queue, which stays a section of its own — it has evidence,
 *   inputs and a rule builder, and a stack of one-line notices is not where an
 *   interactive form belongs. It is first in the order, which is what the
 *   priority was for.
 * - `auth` stays a card for the same reason (see `AuthCard` below).
 * - `stale` is not in the stack at all: a console whose server predates the
 *   autopilot cannot render this tab, so it replaces the view rather than
 *   annotating it.
 */

import type { ReactNode } from 'react';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, StatusStack, toast, type StatusNote }
  from '@/components/ui';
import { api, type AuthStatus, type ConsoleState, type RunState } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useState } from 'react';

/** The declared order. Index in this array IS the priority. */
export const NOTE_ORDER = [
  'halt',
  'ended',
  'pause',
  'frozen',
  'waiting-window',
  'budget',
  'scoped',
  'profile',
  'read-only',
] as const;

export type NoteId = (typeof NOTE_ORDER)[number];

/** A note plus the action that resolves it, before ordering. */
interface RunNote extends StatusNote {
  id: NoteId;
}

const at = (iso: string | number | undefined): string =>
  iso == null ? '' : new Date(iso).toLocaleString();

/**
 * Every notice this run is currently raising, worst-first.
 *
 * Pure and exported so a test can force each state and assert exactly one slot
 * lights up — which is the property the old eleven-call-site version could not
 * be given at all.
 */
export function runNotes({
  run,
  live,
  allowRun,
  busy,
  onClearScope,
  onGuard,
}: {
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  busy?: string;
  onClearScope?: () => void;
  onGuard?: () => void;
}): RunNote[] {
  const notes: RunNote[] = [];

  if (run?.halt) {
    notes.push({
      id: 'halt',
      severity: 'error',
      title: 'Halted.',
      body: (
        <>
          {run.halt.reason}
          {run.halt.phase != null && <span className="text-ink-faint"> (phase {run.halt.phase})</span>}
        </>
      ),
    });
  }

  // Why the loop stopped, for every ending that is not a halt. A run that stops
  // after one phase because it was scoped to one phase is the most-reported
  // "it doesn't advance", and it used to be invisible.
  if (!live && !run?.halt && run?.finishedReason) {
    notes.push({
      id: 'ended',
      severity: run.status === 'finished' ? 'ok' : 'info',
      title: run.status === 'finished' ? 'Run finished.' : 'Run stopped.',
      body: run.finishedReason,
    });
  }

  if (run?.status === 'pausing') {
    notes.push({
      id: 'pause',
      severity: 'warn',
      title: 'Pause armed.',
      body: (
        <>
          {run.pause?.afterPhase != null
            ? `Phase ${run.pause.afterPhase} will finish and be verified, then the run stops.`
            : 'The run stops at the next phase boundary.'}
          {run.pause?.requestedAt && (
            <span className="text-ink-faint"> (asked for {relativeTime(Date.parse(run.pause.requestedAt))})</span>
          )}
          <span className="mt-2 block text-ink-muted">
            Nothing is cut off — a pause always waits for a phase to reach a boundary, so the work in
            flight is finished and checked rather than abandoned. Use <strong>Stop now</strong> if you
            need it to end sooner than that.
          </span>
        </>
      ),
    });
  } else if (run?.status === 'paused') {
    notes.push({
      id: 'pause',
      severity: 'info',
      title: 'Paused between phases.',
      body: 'Continue picks up from the board, so nothing has to be remembered about where it stopped.',
    });
  }

  if (run?.status === 'frozen') {
    notes.push({
      id: 'frozen',
      severity: 'warn',
      title: 'Frozen mid-phase.',
      body: (
        <>
          {run.freeze?.phase != null ? `Phase ${run.freeze.phase} is` : 'The session is'} stopped where
          it stood — the process is alive and holding its session, it is simply not being scheduled.
          Continue picks up mid-token.
          {run.freeze?.escalateAt && (
            <span className="mt-2 block text-ink-muted">
              Left frozen past {new Date(run.freeze.escalateAt).toLocaleTimeString()} it converts to a
              checkpoint instead: the session is asked to stop and its id is saved, so Continue resumes
              it rather than starting the phase over. A stopped process holds memory and a prompt cache
              that expires anyway, so an overnight freeze is not the cheap option it looks like.
            </span>
          )}
        </>
      ),
    });
  }

  if (run?.waitUntil) {
    notes.push({
      id: 'waiting-window',
      severity: 'warn',
      body: (
        <>
          Waiting for a usage window to reopen at {at(run.waitUntil)}. Nothing is wrong — the run
          resumes by itself.
        </>
      ),
    });
  }

  // The account's own figure, reported by the session rather than estimated.
  if (run?.limits && run.limits.status !== 'allowed' && (run.limits.utilization ?? 0) >= 0.75) {
    const percent = Math.round((run.limits.utilization ?? 0) * 100);
    const window = (run.limits.window ?? 'usage').replace(/_/g, ' ');
    notes.push({
      id: 'budget',
      severity: 'warn',
      title: `${percent}% of your ${window} window is used.`,
      body: (
        <>
          {run.limits.resetsAt ? `It resets ${at(run.limits.resetsAt * 1000)}. ` : ''}
          A long run started now may stop partway and wait — the session reports this itself, so it is
          the account's own figure rather than an estimate.
        </>
      ),
    });
  }

  if (run?.onlyPhases?.length) {
    notes.push({
      id: 'scoped',
      severity: 'info',
      title: 'Scoped run.',
      body: (
        <>
          This run drives{' '}
          {run.onlyPhases.length === 1
            ? `phase ${run.onlyPhases[0]} only`
            : `phases ${run.onlyPhases.join(', ')} only`}
          , then stops — it will not carry on into whatever those unblock. That is set by{' '}
          <em>Run only this</em> on a phase row.
        </>
      ),
      action: allowRun && onClearScope ? (
        <Button size="sm" variant="default" disabled={Boolean(busy)} onClick={onClearScope}>
          {busy === 'scope' ? 'Clearing…' : 'Run the whole plan'}
        </Button>
      ) : undefined,
    });
  }

  // A run with the guard rails down must never look like an ordinary one. The
  // selector is inside Controls, which scrolls away; this stays at the top.
  if (run?.permissionProfile && run.permissionProfile !== 'guarded') {
    const bypass = run.permissionProfile === 'bypass';
    notes.push({
      id: 'profile',
      severity: 'warn',
      title: bypass ? 'Bypass permissions.' : 'Trusted run.',
      body: bypass
        ? 'Nothing raises an approval card and the CLI is not asking either — this run is held only by the deny list.'
        : 'Nothing raises an approval card. The deny list still refuses pushes, destructive git, deploys and publishes, and does so even if this console dies.',
      action: live && allowRun && onGuard ? (
        <Button size="sm" variant="default" disabled={Boolean(busy)} onClick={onGuard}>
          {busy === 'profile' ? 'Switching…' : 'Go back to Guarded'}
        </Button>
      ) : undefined,
    });
  }

  if (!allowRun) {
    notes.push({
      id: 'read-only',
      severity: 'info',
      body: (
        <>
          This console is read-only for runs. Restart it with <code className="font-mono">--allow-run</code>{' '}
          to start, pause or approve anything. You can still watch a run that another console started.
        </>
      ),
    });
  }

  return notes.sort((a, b) => NOTE_ORDER.indexOf(a.id) - NOTE_ORDER.indexOf(b.id));
}

/**
 * The stack itself.
 *
 * `max` is deliberately generous here and not the primitive's default of three:
 * every note in this list is a fact about the run's own state, and hiding "you
 * are on bypass" behind an "and 2 more" is the failure the consolidation existed
 * to prevent. The ordering is what does the work; the cap is only a backstop.
 */
export function RunStatusStack(props: Parameters<typeof runNotes>[0]) {
  return <StatusStack notes={runNotes(props)} max={NOTE_ORDER.length} order="given" />;
}

/**
 * A console talking to a server that predates the autopilot.
 *
 * The client is served fresh from disk; the server is whatever Node loaded at
 * startup. Upgrading the skill under a running console leaves this page talking
 * to an API with no run endpoints, and the honest thing to show is why — not a
 * stack of failed requests.
 */
export function StaleServerNote() {
  return (
    <Banner severity="warn">
      <div>
        <strong>This console is running an older build.</strong> The page you are looking at was
        loaded from disk, but the server behind it started before the autopilot existed, so its run
        endpoints are not there — that is what the 404s in the browser console are.
        <p className="mt-2">
          Stop it and start it again to pick up the new server. Adding{' '}
          <code className="font-mono">--allow-run</code> is what actually turns the autopilot on;
          without it this page works but stays read-only.
        </p>
      </div>
    </Banner>
  );
}

/**
 * An expired login.
 *
 * The cheapest thing here to fix and the most confusing to hit, because a
 * signed-out session does not look like a failure: it reports success, uses one
 * turn, costs nothing and changes nothing. The card names what happened and puts
 * the fix one click away, because "run /login in this workspace" is an
 * instruction a browser cannot carry out.
 *
 * A card rather than a stack note: it has two buttons and a command block, and a
 * one-line notice is not where those belong.
 */
export function AuthCard({
  auth,
  allowRun,
  onRecheck,
}: {
  auth: AuthStatus | undefined;
  allowRun: boolean;
  onRecheck: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const command = 'claude auth login';

  const signIn = async () => {
    setBusy(true);
    try {
      const result = await api.authLogin();
      setOpened(true);
      toast(
        result.opened
          ? 'A terminal is open on the sign-in — finish there, then choose Check again.'
          : result.detail ?? 'Run the command below in a terminal.',
        result.opened ? 'ok' : 'warn',
      );
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Claude Code is signed out</CardTitle>
        {auth?.checkedAt && (
          <span className="text-2xs text-ink-faint">checked {relativeTime(Date.parse(auth.checkedAt))}</span>
        )}
      </CardHeader>
      <CardBody>
        <p className="max-w-prose text-sm text-ink-muted">
          Sessions still start, spend a turn and report success — they simply cannot do anything. That
          is why a run can look like it worked and changed nothing.
          {auth?.detail && <span className="text-2xs"> ({auth.detail})</span>}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={!allowRun || busy} onClick={() => void signIn()}>
            {busy ? 'Opening a terminal…' : 'Open a terminal and sign in'}
          </Button>
          <Button variant="default" onClick={onRecheck}>
            Check again
          </Button>
        </div>

        {opened && (
          <p className="mt-2 text-2xs text-ink-faint">
            Finish signing in over there, then choose <strong>Check again</strong> and start the run.
          </p>
        )}
        <p className="mt-3 text-2xs text-ink-faint">Or run it yourself:</p>
        <pre className="mt-1 overflow-x-auto rounded border border-rule bg-ground px-2 py-1.5 font-mono text-2xs">
          {command}
        </pre>
        {!allowRun && (
          <p className="mt-2 text-2xs text-ink-faint">
            Opening a terminal needs <code className="font-mono">--allow-run</code>; the command above
            works regardless.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

// Moved to `lib/failures.ts` — the dashboard asks the same question of the same
// halt reason, and a classifier only the run page could reach is why its card
// offered a link where this page offered the fix. Re-exported so the several
// call sites here and in `views/runs` keep importing it from where they always
// have.
export { looksLikeAuthFailure } from '@/lib/failures';

/** Narrow a console state to the two flags the run view gates on. */
export function runFlags(state: ConsoleState | undefined): { allowRun: boolean; autopilot: boolean } {
  return {
    allowRun: Boolean(state?.allowRun),
    // Absent means an older server; `undefined` must not read as "off" for a
    // console that simply has not answered yet.
    autopilot: state?.autopilot !== false,
  };
}

export type { RunNote, ReactNode };
