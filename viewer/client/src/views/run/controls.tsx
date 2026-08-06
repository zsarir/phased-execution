/**
 * The controls: what to run it as, and the four ways to stop it.
 *
 * ## Two pauses, deliberately named apart
 *
 * **Pause after this phase** waits for the phase to finish and be verified.
 * **Freeze now** stops the session where it stands, holding its context. Calling
 * both "Pause" is how an operator ends up pressing the wrong one while watching a
 * phase do the wrong thing — so they are named for what they do to the work in
 * flight, not for how they feel.
 *
 * ## The form follows the run
 *
 * Every field re-seeds when the run changes underneath us — a different run id,
 * or the server applying settings we did not send. Without that the form keeps
 * showing whatever it was first mounted with, which is a quiet way to start a run
 * on a model the operator can see on screen and did not choose.
 *
 * ## Stop is a dialog, not a `confirm()`
 *
 * The old one used the browser's native `confirm()`. That is not focus-trapped,
 * cannot be styled, blocks the event loop and — on a phone, where this console is
 * most often used — renders as an OS sheet with two indistinguishable buttons.
 * A `AlertDialog` says what stopping costs *before* the choice, which is the part
 * that was missing.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog, AlertDialogContent, AlertDialogTrigger,
  Button, Card, CardBody, CardHeader, CardTitle, toast,
} from '@/components/ui';
import { api, type AccountView, type PhaseOptions, type PhaseView, type RunSettings, type RunState, type SkillInfo }
  from '@/lib/api';
import { keys, useAccounts } from '@/lib/queries';
import { cn } from '@/lib/cn';
import {
  AUTONOMY_LABEL, DEFAULTS, EFFORTS, EFFORT_NOTE, MODELS, PROFILE_LABEL,
} from './defaults';
import { PhaseMatrix } from './phase-matrix';
import { SkillPicker } from './skill-picker';
import type { Autonomy, PermissionProfile } from '@/lib/api';

/** What each profile costs, read while choosing it. */
function ProfileNote({ profile }: { profile: PermissionProfile }) {
  if (profile === 'guarded') {
    return (
      <>
        Commits, installs, merges and fetches raise a card. The deny list — pushes, destructive git,
        deploys, publishes — is refused outright and no card can approve it.
      </>
    );
  }
  if (profile === 'trusted') {
    return (
      <>
        <strong>Nothing raises a card.</strong> The deny list still holds, and still holds with this
        console dead — it is enforced by the CLI, not by the hook. Everything else runs unattended,
        including every commit.
      </>
    );
  }
  return (
    <>
      <strong>Nothing raises a card, and the CLI stops asking too</strong> (
      <code className="font-mono">--permission-mode bypassPermissions</code>). The deny list is the
      only thing left between this run and your repository — it does still hold, because bypass
      auto-approves everything <em>except</em> explicit deny rules. Journaled for as long as it is in
      force.
      <br />
      Requires the bypass disclaimer to have been accepted once, interactively, in a normal{' '}
      <code className="font-mono">claude</code> session on this machine. Without it the CLI silently
      downgrades to <code className="font-mono">default</code>, which refuses every edit in headless
      mode — the run would do <em>less</em> than Guarded. The console reports that if it happens; if
      you have not accepted it, use Trusted.
    </>
  );
}

/**
 * Which skills the picker opens on.
 *
 * A run that EXISTS answers for itself, empty list included: `state.skills` is
 * deleted when it is empty (`applySettings`, `newRun`), so an absent list on a
 * real run means the operator turned them all off — and re-seeding the machine
 * defaults over that would make the box impossible to untick. Only a run that
 * does not exist yet gets the defaults, which is exactly when the server would
 * apply them.
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
  skills,
  defaultSkills = [],
  automation,
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
  skills: SkillInfo[];
  /** What a NEW run would start with. An existing run's own list wins. */
  defaultSkills?: string[];
  /** The Automation preferences — the opening values for the new knobs. */
  automation?: {
    attachDefaultSkills: boolean; qaByDefault: boolean;
    gitMode: 'default-branch' | 'new-branch'; openPrOnComplete: boolean;
  };
  /** The plan's qa-mode; `off` offers the launch-time QA toggle. */
  qaMode?: string;
  /** Whether the console may turn QA on — a different flag from allowRun. */
  allowWrites?: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  // A stable dependency for the effect below: `defaultSkills` is a fresh array
  // on every render of the parent, so depending on the array itself would reset
  // the picker — and every other field with it — on each poll.
  const defaultKey = defaultSkills.join(',');
  const [model, setModel] = useState(run?.model ?? DEFAULTS.model);
  const [effort, setEffort] = useState(run?.effort ?? DEFAULTS.effort);
  const [autonomy, setAutonomy] = useState<Autonomy>(run?.autonomy ?? DEFAULTS.autonomy);
  const [phaseBudget, setPhaseBudget] = useState(String(run?.phaseBudgetUsd ?? ''));
  const [runBudget, setRunBudget] = useState(String(run?.runBudgetUsd ?? ''));
  const [overrides, setOverrides] = useState<Record<string, PhaseOptions>>(run?.phaseOptions ?? {});
  const [runSkills, setRunSkills] = useState<string[]>(() => seedSkills(run, defaultSkills));
  const [profile, setProfile] = useState<PermissionProfile>(
    run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile),
  );

  // The preference-seeded knobs derive LIVE until the operator touches them —
  // the preferences arrive with `/api/state`, after the first render, and a
  // one-shot useState seed would show the fallback instead. An existing run's
  // own record still wins over the preference, exactly as for skills above.
  const [attachChoice, setAttachChoice] = useState<boolean | null>(null);
  const attach = attachChoice
    ?? (run ? false : (automation?.attachDefaultSkills ?? false) && defaultSkills.length > 0);
  const [qaChoice, setQaChoice] = useState<boolean | null>(null);
  const canQaToggle = qaMode === 'off' && allowWrites !== false;
  const qaOn = qaChoice ?? (canQaToggle && (automation?.qaByDefault ?? false));
  const [gitChoice, setGitChoice] = useState<'default-branch' | 'new-branch' | null>(null);
  // An existing run answers for itself (absent = default-branch, its meaning on
  // disk); only a run that does not exist yet opens on the preference.
  const gitMode = gitChoice ?? run?.gitMode
    ?? (run ? 'default-branch' : automation?.gitMode ?? 'default-branch');
  const [prChoice, setPrChoice] = useState<boolean | null>(null);
  const openPr = prChoice ?? run?.openPr ?? (run ? true : automation?.openPrOnComplete ?? true);

  // Follow the run when it changes underneath us. Note the fallbacks differ from
  // the ones above on purpose: an EXISTING run with no `permissionProfile` on it
  // is `guarded` (absent has always meant that on disk), while a run that does
  // not exist yet opens on the client default.
  useEffect(() => {
    setModel(run?.model ?? DEFAULTS.model);
    setEffort(run?.effort ?? (run ? '' : DEFAULTS.effort));
    setAutonomy(run?.autonomy ?? DEFAULTS.autonomy);
    setPhaseBudget(String(run?.phaseBudgetUsd ?? ''));
    setRunBudget(String(run?.runBudgetUsd ?? ''));
    setOverrides(run?.phaseOptions ?? {});
    setRunSkills(seedSkills(run, defaultSkills));
    setProfile(run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile));
  }, [run?.id, run?.model, run?.effort, run?.autonomy, run?.phaseBudgetUsd, run?.runBudgetUsd,
    run?.permissionProfile, run, defaultKey]);

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

  const settings: RunSettings = {
    model,
    effort,
    autonomy,
    phaseBudgetUsd: Number(phaseBudget) || null,
    runBudgetUsd: Number(runBudget) || null,
    phaseOptions: overrides,
    skills: runSkills,
    // Sent explicitly rather than omitted: `routes.ts` reads an unrecognised or
    // missing profile as `guarded`, which is the right safety rule and the reason
    // the client must say what it means.
    permissionProfile: profile,
    gitMode,
    ...(gitMode === 'new-branch' ? { openPr } : {}),
    ...(attach ? { attachDefaultSkills: true } : {}),
  };

  const changed = live && (
    model !== run?.model
    || effort !== (run?.effort ?? '')
    || autonomy !== run?.autonomy
    || profile !== (run?.permissionProfile ?? 'guarded')
    || (Number(phaseBudget) || null) !== (run?.phaseBudgetUsd ?? null)
    || (Number(runBudget) || null) !== (run?.runBudgetUsd ?? null)
    || gitMode !== (run?.gitMode ?? 'default-branch')
    || (gitMode === 'new-branch' && openPr !== (run?.openPr ?? true))
    || JSON.stringify(overrides) !== JSON.stringify(run?.phaseOptions ?? {})
    || JSON.stringify(runSkills) !== JSON.stringify(run?.skills ?? [])
  );

  const field = 'h-9 rounded border border-rule bg-ground px-2 text-sm disabled:opacity-50';

  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline">
        <CardTitle>
          {frozen ? 'Frozen' : live ? 'Running' : resumable ? 'Continue this run' : 'Start a run'}
        </CardTitle>
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
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Model</span>
            <select value={model} disabled={disabled} className={field}
              onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Effort</span>
            <select value={effort} disabled={disabled} title={EFFORT_NOTE[effort]} className={field}
              onChange={(e) => setEffort(e.target.value)}>
              {EFFORTS.map((e) => <option key={e} value={e}>{EFFORT_NOTE[e]}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">
              If something is unclear
            </span>
            <select value={autonomy} disabled={disabled} className={field}
              onChange={(e) => setAutonomy(e.target.value as Autonomy)}>
              {(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((a) => (
                <option key={a} value={a}>{AUTONOMY_LABEL[a]}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Budget per phase ($)</span>
            <input type="number" min="0" step="0.5" value={phaseBudget} disabled={disabled}
              placeholder="none" className={field}
              onChange={(e) => setPhaseBudget(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Budget for the run ($)</span>
            <input type="number" min="0" step="1" value={runBudget} disabled={disabled}
              placeholder="none" className={field}
              onChange={(e) => setRunBudget(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Permissions</span>
            <select value={profile} disabled={disabled} className={field}
              onChange={(e) => setProfile(e.target.value as PermissionProfile)}>
              {(Object.keys(PROFILE_LABEL) as PermissionProfile[]).map((p) => (
                <option key={p} value={p}>{PROFILE_LABEL[p]}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-muted uppercase">Branch</span>
            <select value={gitMode} disabled={disabled} className={field}
              onChange={(e) => setGitChoice(e.target.value as 'default-branch' | 'new-branch')}>
              <option value="default-branch">Work on the current branch</option>
              <option value="new-branch">Work branch per run (pe/{slug})</option>
            </select>
          </label>
        </div>

        {gitMode === 'new-branch' && (
          <label className="flex flex-wrap items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-[var(--action)]" checked={openPr}
              disabled={disabled} onChange={(e) => setPrChoice(e.target.checked)} />
            <span className="min-w-0 flex-1">
              Open a PR when the plan completes
              <span className="block text-2xs text-ink-faint">
                The final phase pushes <code className="font-mono">pe/{slug}</code> and opens the PR
                — after one approval tap on the push. Force-pushes stay denied outright.
              </span>
            </span>
          </label>
        )}

        {qaMode === 'off' && !live && (
          <label className="flex flex-wrap items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-[var(--action)]"
              checked={qaOn && canQaToggle} disabled={disabled || !canQaToggle}
              title={canQaToggle ? undefined : 'Writes are disabled. Restart the console with --allow-writes.'}
              onChange={(e) => setQaChoice(e.target.checked)} />
            <span className="min-w-0 flex-1">
              Turn the QA gate on for this plan
              <span className="block text-2xs text-ink-faint">
                Each finished phase then waits for an independent review. Phases that finished
                before now are recorded as <em>waived</em>, so turning it on does not retroactively
                hold the board.
              </span>
            </span>
          </label>
        )}

        {defaultSkills.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <span className="text-ink">Attach default skills</span>
              <span className="mt-0.5 block text-2xs text-ink-faint">
                This machine's list: {defaultSkills.map((s) => <code key={s} className="mr-1">{s}</code>)}
              </span>
            </span>
            <Button size="sm" aria-pressed={attach} disabled={disabled}
              onClick={() => setAttachChoice(!attach)}>
              {attach ? 'Attached' : 'Off'}
            </Button>
          </div>
        )}

        <p className={cn(
          'max-w-prose text-2xs',
          profile === 'guarded' ? 'text-ink-faint' : 'rounded border border-action/40 bg-action/8 p-2 text-ink-muted',
        )}>
          <ProfileNote profile={profile} />
        </p>

        {skills.length > 0 && (
          <SkillPicker skills={skills} chosen={runSkills} planSkills={planSkills}
            defaultSkills={defaultSkills} disabled={disabled} onChange={setRunSkills} />
        )}

        <PhaseMatrix planPhases={planPhases} overrides={overrides} runModel={model}
          runEffort={effort} skills={skills} runSkills={runSkills} disabled={disabled}
          onChange={setOverrides} />

        {changed && (
          <p className="max-w-prose text-2xs text-ink-faint">
            These apply from the <strong>next</strong> phase. The session already running was started
            with its model and budget fixed in its own command line, and there is no honest way to
            change those underneath it.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!live ? (
            <Button variant="action" disabled={disabled}
              onClick={() => void onAct('start', () => api.runStart(slug, {
                ...settings,
                // START only — activating QA is a start-time act, never part of
                // a mid-run settings patch.
                ...(qaOn && canQaToggle ? { qa: true } : {}),
                resumeRunId: resumable && run ? run.id : undefined,
              }))}>
              {busy === 'start' ? 'Starting…' : resumable ? 'Continue' : 'Start'}
            </Button>
          ) : (
            <>
              {pausing ? (
                <Button variant="action" disabled={disabled}
                  onClick={() => void onAct('resume', async () => {
                    const { run: after } = await api.runResume(slug);
                    toast(
                      after?.status === 'pausing'
                        ? 'The pause could not be cancelled — reload and look at the status'
                        : 'Pause cancelled — the run carries on',
                      after?.status === 'pausing' ? 'warn' : 'ok',
                    );
                  })}>
                  {busy === 'resume' ? 'Cancelling…' : 'Cancel pause — keep going'}
                </Button>
              ) : (
                <Button disabled={disabled || stopping || halting}
                  onClick={() => void onAct('pause', async () => {
                    // Report what the SERVER did, not what the click intended. A
                    // pause that lands on nothing used to answer 200 and say
                    // nothing at all, which read as "it worked".
                    const { run: after } = await api.runPause(slug);
                    if (after?.status === 'pausing') {
                      toast(after.pause?.afterPhase != null
                        ? `Pause armed — phase ${after.pause.afterPhase} finishes first`
                        : 'Pause armed — stopping at the next phase boundary', 'ok');
                    } else {
                      toast('Nothing to pause: no phase is running on this run.', 'warn');
                    }
                  })}>
                  {busy === 'pause' ? 'Arming…' : 'Pause after this phase'}
                </Button>
              )}

              {frozen ? (
                <Button variant="action" disabled={disabled}
                  onClick={() => void onAct('thaw', async () => {
                    const { run: after } = await api.runThaw(slug);
                    const still = after?.status === 'frozen' || Boolean(after?.freeze);
                    toast(
                      still
                        ? 'The session could not be continued — reload and look at the status'
                        : 'Continued — the session picks up mid-token',
                      still ? 'warn' : 'ok',
                    );
                  })}>
                  {busy === 'thaw' ? 'Continuing…' : 'Continue the frozen session'}
                </Button>
              ) : (
                <Button disabled={disabled || stopping || halting || run?.activePhase == null}
                  title="Stops EVERY running session where it stands, losing nothing. One session's tab has the freeze scoped to it alone."
                  onClick={() => void onAct('freeze', async () => {
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
                  })}>
                  {busy === 'freeze' ? 'Freezing…' : 'Freeze now'}
                </Button>
              )}

              {changed && (
                <Button disabled={disabled}
                  onClick={() => void onAct('settings', () => api.runSettings(slug, settings))}>
                  {busy === 'settings' ? 'Applying…' : 'Apply from next phase'}
                </Button>
              )}

              <StopButton
                disabled={disabled}
                busy={busy === 'stop'}
                onStop={() => void onAct('stop', () => api.runStop(slug))}
              />
            </>
          )}

          {!allowRun && (
            <span className="text-2xs text-ink-faint">
              Controls need <code className="font-mono">--allow-run</code>.
            </span>
          )}
        </div>

        <SwitchAccountRow slug={slug} run={run} disabled={disabled} />
      </CardBody>
    </Card>
  );
}

/** How an account reads in a picker: name, email, plan, and its 5-hour meter. */
function accountOptionLabel(account: AccountView, current: string): string {
  const name = account.builtIn
    ? account.name ?? 'machine login'
    : account.name ?? account.email ?? account.id;
  const email = !account.builtIn || account.name ? account.email : undefined;
  const five = account.usage?.buckets.five_hour?.utilization;
  return [
    name,
    email && email !== name ? `(${email})` : null,
    account.plan ? `· ${account.plan}` : null,
    typeof five === 'number' ? `· 5h ${Math.round(five)}%` : null,
    account.id === current ? '· current' : null,
  ].filter(Boolean).join(' ');
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
export function SwitchAccountRow({ slug, run, disabled }: {
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
    : current === 'default' ? 'machine login' : current;

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
        className="h-8 max-w-72 rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
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
        title={value === current
          ? 'The run is already on this account — pick another, or auto.'
          : 'A live session is checkpointed (its session id kept) and re-attempted under the chosen account right away.'}
        onClick={() => {
          setBusy(true);
          api.runSwitchAccount(slug, value)
            .then((outcome) => {
              toast(outcome.ok
                ? 'Switched — the next session runs under the other account.'
                : outcome.reason ?? 'Could not switch.', outcome.ok ? 'ok' : 'warn');
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

function StopButton({
  disabled,
  busy,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  onStop: () => void;
}) {
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
          The session gets SIGTERM, so its own end-of-session hooks still run. Anything it has
          already written to the repository stays written — stopping does not undo work.
        </p>
        <p className="mt-2 text-2xs text-ink-faint">
          The phase is recorded as <strong>interrupted</strong> rather than failed, because a phase
          cut off partway may have half-finished something. Continuing later will ask you about it
          instead of silently running it again.
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}
