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
import {
  AlertDialog, AlertDialogContent, AlertDialogTrigger,
  Button, Card, CardBody, CardHeader, CardTitle, toast,
} from '@/components/ui';
import { api, type PhaseOptions, type PhaseView, type RunSettings, type RunState, type SkillInfo }
  from '@/lib/api';
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

export function Controls({
  slug,
  run,
  live,
  busy,
  allowRun,
  planPhases,
  planSkills,
  skills,
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
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [model, setModel] = useState(run?.model ?? DEFAULTS.model);
  const [effort, setEffort] = useState(run?.effort ?? DEFAULTS.effort);
  const [autonomy, setAutonomy] = useState<Autonomy>(run?.autonomy ?? DEFAULTS.autonomy);
  const [phaseBudget, setPhaseBudget] = useState(String(run?.phaseBudgetUsd ?? ''));
  const [runBudget, setRunBudget] = useState(String(run?.runBudgetUsd ?? ''));
  const [overrides, setOverrides] = useState<Record<string, PhaseOptions>>(run?.phaseOptions ?? {});
  const [runSkills, setRunSkills] = useState<string[]>(run?.skills ?? []);
  const [profile, setProfile] = useState<PermissionProfile>(
    run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile),
  );

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
    setRunSkills(run?.skills ?? []);
    setProfile(run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile));
  }, [run?.id, run?.model, run?.effort, run?.autonomy, run?.phaseBudgetUsd, run?.runBudgetUsd,
    run?.permissionProfile, run]);

  const resumable = Boolean(run) && !live && run?.status !== 'finished';
  const disabled = !allowRun || Boolean(busy);
  const pausing = run?.status === 'pausing';
  const stopping = run?.status === 'stopping';
  const frozen = run?.status === 'frozen';
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
  };

  const changed = live && (
    model !== run?.model
    || effort !== (run?.effort ?? '')
    || autonomy !== run?.autonomy
    || profile !== (run?.permissionProfile ?? 'guarded')
    || (Number(phaseBudget) || null) !== (run?.phaseBudgetUsd ?? null)
    || (Number(runBudget) || null) !== (run?.runBudgetUsd ?? null)
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
        </div>

        <p className={cn(
          'max-w-prose text-2xs',
          profile === 'guarded' ? 'text-ink-faint' : 'rounded border border-action/40 bg-action/8 p-2 text-ink-muted',
        )}>
          <ProfileNote profile={profile} />
        </p>

        {skills.length > 0 && (
          <SkillPicker skills={skills} chosen={runSkills} planSkills={planSkills}
            disabled={disabled} onChange={setRunSkills} />
        )}

        <PhaseMatrix planPhases={planPhases} overrides={overrides} runModel={model}
          runEffort={effort} skills={skills} disabled={disabled} onChange={setOverrides} />

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
                <Button disabled={disabled || stopping}
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
                    toast(
                      after?.status === 'frozen'
                        ? 'The session could not be continued — reload and look at the status'
                        : 'Continued — the session picks up mid-token',
                      after?.status === 'frozen' ? 'warn' : 'ok',
                    );
                  })}>
                  {busy === 'thaw' ? 'Continuing…' : 'Continue the frozen session'}
                </Button>
              ) : (
                <Button disabled={disabled || stopping || run?.activePhase == null}
                  title="Stops the session where it stands, losing nothing. The opposite of waiting for the phase to finish."
                  onClick={() => void onAct('freeze', async () => {
                    const { run: after } = await api.runFreeze(slug);
                    toast(
                      after?.status === 'frozen'
                        ? `Frozen — phase ${after.freeze?.phase ?? ''} is stopped where it stood`.trim()
                        : 'Nothing to freeze: no session is running on this run.',
                      after?.status === 'frozen' ? 'ok' : 'warn',
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
      </CardBody>
    </Card>
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
