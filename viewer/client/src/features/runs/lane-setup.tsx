/**
 * The controls: the four ways to stop a run, and the door to everything else.
 *
 * ## The form is `RunSetup`, and it is behind a sheet
 *
 * Every field this card used to declare for itself — model, effort, autonomy,
 * budgets, permissions, branch, skills, MCP, the per-phase matrix — moved into
 * `features/run-setup` in Phase 6, where the launch dialog, the agent launcher
 * and Settings ▸ Automation render the same component. In Phase 7 it moved
 * again, off the page and into `settings-sheet.tsx`: a screenful of controls
 * touched once a run does not belong above the console on a phone. The mode
 * mapping went with it (no run is `start`, a stopped one `continue`, a live
 * one `live` — a settings patch, not a launch).
 *
 * What is left here is what is genuinely pressed WHILE watching: the four
 * verbs, and the account row.
 *
 * ## Two pauses, deliberately named apart
 *
 * **Pause after this phase** waits for the phase to finish and be verified.
 * **Freeze now** stops the session where it stands, holding its context. Calling
 * both "Pause" is how an operator ends up pressing the wrong one while watching a
 * phase do the wrong thing — so they are named for what they do to the work in
 * flight, not for how they feel.
 *
 * ## Stop is a dialog, not a `confirm()`
 *
 * The old one used the browser's native `confirm()`. That is not focus-trapped,
 * cannot be styled, blocks the event loop and — on a phone, where this console is
 * most often used — renders as an OS sheet with two indistinguishable buttons.
 * A `AlertDialog` says what stopping costs *before* the choice, which is the part
 * that was missing.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  toast,
} from '@/components/ui';
import { api, type AccountView, type PhaseView, type RunState } from '@/lib/api';
import { keys, useAccounts } from '@/lib/queries';
import { SettingsSheet } from './settings-sheet';

/**
 * Which skills the picker opens on.
 *
 * A run that EXISTS answers for itself, empty list included: `state.skills` is
 * deleted when it is empty (`applySettings`, `newRun`), so an absent list on a
 * real run means the operator turned them all off — and re-seeding the machine
 * defaults over that would make the box impossible to untick. Only a run that
 * does not exist yet gets the defaults, which is exactly when the server would
 * apply them.
 *
 * The rule now lives in `features/run-setup/run-setup.tsx` `seedFor`, which is
 * where every surface reads it; this stays exported because it is the smallest
 * statement of the rule and `run.test.tsx` pins it here. Both are asserted.
 */
export function seedSkills(run: RunState | null, defaultSkills: string[]): string[] {
  return run ? (run.skills ?? []) : [...defaultSkills];
}

export function Controls({
  slug,
  run,
  live,
  busy,
  allowRun,
  planPhases,
  planSkills,
  planMcp = [],
  qaMode,
  allowWrites,
  onAct,
}: {
  slug: string;
  run: RunState | null;
  live: boolean;
  busy: string;
  allowRun: boolean;
  planPhases: PhaseView[];
  planSkills: string[];
  /** What the plan attaches to every session — shown, never unticked here. */
  planMcp?: string[];
  /** The plan's qa-mode; `off` offers the launch-time QA toggle. */
  qaMode?: string;
  /** Whether the console may turn QA on — a different flag from allowRun. */
  allowWrites?: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const resumable = Boolean(run) && !live && run?.status !== 'finished';
  const disabled = !allowRun || Boolean(busy);
  const pausing = run?.status === 'pausing';
  const stopping = run?.status === 'stopping';
  // A draining halt: sessions are still live (Stop applies), but a pause or a
  // freeze aimed at "the current phase" is aimed at a run that already stopped
  // admitting — the server refuses both, so the buttons say so up front.
  const halting = run?.status === 'halting';
  // `frozen` status now means EVERY session is frozen; a single frozen lane of
  // several leaves the run `running` with the freeze recorded on the run —
  // either way this card must offer the Continue.
  const frozen = run?.status === 'frozen' || Boolean(run?.freeze);
  /** A freeze that ran past its threshold left a session to resume, not a fresh start. */
  const checkpointed = Object.values(run?.phases ?? {}).some((p) => p.resumeSessionId);

  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline">
        {/* The title says what the run IS; the button below says what pressing
            it DOES. They used to say the same words in both places, which read
            as one label rendered twice — and it was: `getByText` found two. */}
        <CardTitle>{frozen ? 'Frozen' : live ? 'Running' : resumable ? 'Stopped' : 'No run yet'}</CardTitle>
        <span className="max-w-prose text-2xs text-ink-faint">
          {frozen
            ? 'The session is alive and stopped. Nothing has been lost.'
            : resumable
              ? checkpointed
                ? 'Picks up the checkpointed session with --resume, rather than starting the phase over.'
                : 'Picks up from the board, not from a saved position.'
              : 'Fresh or half-finished is the same button — the done-set decides where it begins.'}
        </span>
      </CardHeader>

      <CardBody className="flex flex-col gap-3">
        {/* The fields are behind `Settings` now.
            They were open on the page, all of them, above the thing anybody
            came to read — a screenful of controls on a phone between the
            status line and the console, for a set of values touched about
            once a run. What stayed out here is the part that IS pressed while
            watching: the verbs, and the account row. */}
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSheet
            slug={slug}
            run={run}
            live={live}
            allowRun={allowRun}
            planPhases={planPhases}
            planSkills={planSkills}
            planMcp={planMcp}
            {...(qaMode !== undefined ? { qaMode } : {})}
            {...(allowWrites !== undefined ? { allowWrites } : {})}
            trigger={
              <Button variant={live ? 'ghost' : 'action'} disabled={!allowRun}>
                {live ? 'Settings' : resumable ? 'Continue this run' : 'Start a run'}
              </Button>
            }
          />
          {live && (
            <span className="max-w-prose text-2xs text-ink-faint">
              Settings apply from the <strong>next</strong> phase — the session running now was started with
              its model and budget fixed in its own command line.
            </span>
          )}
        </div>

        {live && (
          <div className="flex flex-wrap items-center gap-2">
            {pausing ? (
              <Button
                variant="action"
                disabled={disabled}
                onClick={() =>
                  void onAct('resume', async () => {
                    const { run: after } = await api.runResume(slug);
                    toast(
                      after?.status === 'pausing'
                        ? 'The pause could not be cancelled — reload and look at the status'
                        : 'Pause cancelled — the run carries on',
                      after?.status === 'pausing' ? 'warn' : 'ok',
                    );
                  })
                }
              >
                {busy === 'resume' ? 'Cancelling…' : 'Cancel pause — keep going'}
              </Button>
            ) : (
              <Button
                disabled={disabled || stopping || halting}
                onClick={() =>
                  void onAct('pause', async () => {
                    // Report what the SERVER did, not what the click intended. A
                    // pause that lands on nothing used to answer 200 and say
                    // nothing at all, which read as "it worked".
                    const { run: after } = await api.runPause(slug);
                    if (after?.status === 'pausing') {
                      toast(
                        after.pause?.afterPhase != null
                          ? `Pause armed — phase ${after.pause.afterPhase} finishes first`
                          : 'Pause armed — stopping at the next phase boundary',
                        'ok',
                      );
                    } else {
                      toast('Nothing to pause: no phase is running on this run.', 'warn');
                    }
                  })
                }
              >
                {busy === 'pause' ? 'Arming…' : 'Pause after this phase'}
              </Button>
            )}

            {frozen ? (
              <Button
                variant="action"
                disabled={disabled}
                onClick={() =>
                  void onAct('thaw', async () => {
                    const { run: after } = await api.runThaw(slug);
                    const still = after?.status === 'frozen' || Boolean(after?.freeze);
                    toast(
                      still
                        ? 'The session could not be continued — reload and look at the status'
                        : 'Continued — the session picks up mid-token',
                      still ? 'warn' : 'ok',
                    );
                  })
                }
              >
                {busy === 'thaw' ? 'Continuing…' : 'Continue the frozen session'}
              </Button>
            ) : (
              <Button
                disabled={disabled || stopping || halting || run?.activePhase == null}
                title="Stops EVERY running session where it stands, losing nothing. One session's tab has the freeze scoped to it alone."
                onClick={() =>
                  void onAct('freeze', async () => {
                    const { run: after } = await api.runFreeze(slug);
                    const held = after?.status === 'frozen' || Boolean(after?.freeze);
                    const count = Object.values(after?.children ?? {}).filter((child) => child.frozen).length;
                    toast(
                      held
                        ? count > 1
                          ? `Frozen — ${count} sessions are stopped where they stood`
                          : `Frozen — phase ${after?.freeze?.phase ?? ''} is stopped where it stood`.trim()
                        : 'Nothing to freeze: no session is running on this run.',
                      held ? 'ok' : 'warn',
                    );
                  })
                }
              >
                {busy === 'freeze' ? 'Freezing…' : 'Freeze now'}
              </Button>
            )}

            <StopButton
              disabled={disabled}
              busy={busy === 'stop'}
              onStop={() => void onAct('stop', () => api.runStop(slug))}
            />
          </div>
        )}

        {!allowRun && (
          <span className="text-2xs text-ink-faint">
            Controls need <code className="font-mono">--allow-run</code>.
          </span>
        )}

        <SwitchAccountRow slug={slug} run={run} disabled={disabled} />
      </CardBody>
    </Card>
  );
}

/** How an account reads in a picker: name, email, plan, and its 5-hour meter. */
function accountOptionLabel(account: AccountView, current: string): string {
  const name = account.builtIn
    ? (account.name ?? 'machine login')
    : (account.name ?? account.email ?? account.id);
  const email = !account.builtIn || account.name ? account.email : undefined;
  const five = account.usage?.buckets.five_hour?.utilization;
  return [
    name,
    email && email !== name ? `(${email})` : null,
    account.plan ? `· ${account.plan}` : null,
    typeof five === 'number' ? `· 5h ${Math.round(five)}%` : null,
    account.id === current ? '· current' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Which account this run spends, and the verb to move it NOW. Not a settings
 * field: settings say what the NEXT phase uses; this checkpoints a live
 * session (SIGTERM, session id kept) and re-attempts under the other login
 * without waiting for anything.
 *
 * EVERY account is listed, the current one marked — the old options-minus-
 * current select read as "the console only knows one account" on a machine
 * with two, which is precisely the question this row exists to answer.
 */
export function SwitchAccountRow({
  slug,
  run,
  disabled,
}: {
  slug: string;
  run: RunState | null | undefined;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const { data: accountsState } = useAccounts();
  const accounts = accountsState?.accounts ?? [];
  const current = run?.accountId ?? 'default';
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!run || (accounts.length < 2 && !accountsState?.allowAccounts)) return null;

  const currentView = accounts.find((account) => account.id === current);
  const currentLabel = currentView
    ? accountOptionLabel(currentView, '').replace(/ · current$/, '')
    : current === 'default'
      ? 'machine login'
      : current;

  if (accounts.length < 2) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">
          Account: <span className="normal-case text-ink-muted">{currentLabel}</span>
        </span>
        <a href="#/settings" className="text-2xs text-ink-faint underline hover:text-action">
          Add another account in Settings to switch mid-run
        </a>
      </div>
    );
  }

  // Truthful by construction: the select shows where the run IS until a choice
  // is made, and survives the run switching underneath it.
  const value = choice ?? current;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
      <span className="text-2xs uppercase tracking-wide text-ink-faint">
        Account: <span className="normal-case text-ink-muted">{currentLabel}</span>
      </span>
      <select
        className="h-8 [@media(hover:none)]:min-h-(--tap-min) max-w-72 rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
        value={value}
        disabled={disabled || busy}
        onChange={(event) => setChoice(event.target.value)}
        aria-label="Account for this run"
      >
        <option value="auto">auto — most headroom</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {accountOptionLabel(account, current)}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={disabled || busy || value === current}
        title={
          value === current
            ? 'The run is already on this account — pick another, or auto.'
            : 'A live session is checkpointed (its session id kept) and re-attempted under the chosen account right away.'
        }
        onClick={() => {
          setBusy(true);
          api
            .runSwitchAccount(slug, value)
            .then((outcome) => {
              toast(
                outcome.ok
                  ? 'Switched — the next session runs under the other account.'
                  : (outcome.reason ?? 'Could not switch.'),
                outcome.ok ? 'ok' : 'warn',
              );
              if (outcome.ok) setChoice(null);
              void client.invalidateQueries({ queryKey: keys.runs() });
              void client.invalidateQueries({ queryKey: keys.run(slug) });
            })
            .catch((error: Error) => toast(String(error.message ?? error), 'error'))
            .finally(() => setBusy(false));
        }}
      >
        Switch account
      </Button>
    </div>
  );
}

function StopButton({ disabled, busy, onStop }: { disabled: boolean; busy: boolean; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="danger" disabled={disabled}>
          {busy ? 'Stopping…' : 'Stop now'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title="Stop the run now?"
        confirmLabel="Stop now"
        cancelLabel="Keep running"
        destructive
        onConfirm={() => {
          setOpen(false);
          onStop();
        }}
      >
        <p className="mt-2 text-sm text-ink-muted">
          The session gets SIGTERM, so its own end-of-session hooks still run. Anything it has already written
          to the repository stays written — stopping does not undo work.
        </p>
        <p className="mt-2 text-2xs text-ink-faint">
          The phase is recorded as <strong>interrupted</strong> rather than failed, because a phase cut off
          partway may have half-finished something. Continuing later will ask you about it instead of silently
          running it again.
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}
