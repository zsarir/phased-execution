/**
 * The one dialog every AI launch goes through.
 *
 * Four launches used to have four shapes: a review had a dialog, a recovery
 * fired on one click with no choices at all, "Run only this" reused whatever
 * the run happened to have, and Continue quietly re-sent old settings. The
 * choices are the same everywhere — which model, how hard it thinks, what it
 * may do unasked, which skills ride along, and (for runs) the git strategy and
 * the QA gate — so this is one component with one field matrix, seeded from
 * the Automation preferences and from the run's own record, never retyped.
 *
 * The QA variant is the old `QaDialog` moved whole: its copy, its two-profile
 * select and its activation checkbox are asserted by `qa-launcher.test.tsx`,
 * which is the refactor guard — that suite passes unmodified against this
 * file's rendering. (One deliberate shape: "Attach default skills" is an
 * aria-pressed button, not a checkbox, so the QA activation checkbox stays the
 * only checkbox in that dialog.)
 *
 * This module mounts in the plan, dashboard and run chunks. It must never
 * import anything xterm-shaped — see `views/agent/wizard.tsx` for the rule and
 * the reason; the imports here are ui, pickers, api and the two start helpers.
 */

import { useState } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banner, Button, Dialog, DialogClose, DialogContent, DialogFooter, toast,
} from '@/components/ui';
import { keys, useConsoleState, useSkills } from '@/lib/queries';
import { api, automationPrefs, type RunState } from '@/lib/api';
import { startQa } from '@/lib/start-qa';
import { startRecovery } from '@/lib/start-recovery';
import { QA_PROFILES, QA_PROFILE_LABEL, isVerdict, type QaProfile } from '@/lib/qa';
import { RECOVERY_BLURBS, RECOVERY_LABELS, type RecoveryClass } from '@/lib/recovery';
import {
  DEFAULTS, EFFORTS, EFFORT_NOTE, MODELS, PROFILE_LABEL,
} from '@/views/run/defaults';
import { SkillPicker } from '@/views/run/skill-picker';
import type { PermissionProfile } from '@/lib/api';

const field = 'h-9 rounded border border-rule bg-ground px-2 text-sm disabled:opacity-50';

/** What the phase itself asks for, when the plan says. Mirrors the runner's resolution. */
export interface QaTarget {
  slug: string;
  phase: number;
  title?: string;
  /** The plan's `**Model:**` for this phase, when it names one. */
  model?: string;
  effort?: string;
  /** `off` turns the activation checkbox on. */
  qaMode?: string;
  /** The verdict already recorded for this phase, when there is one. */
  qa?: { result: string; report?: string };
  /** Skills the plan asks every session to invoke. */
  planSkills?: string[];
}

export type LaunchRequest =
  | { kind: 'recovery'; recoveryClass: RecoveryClass; slug: string; phase?: number; runId?: string }
  | {
    kind: 'phase'; slug: string; phase: number; run: RunState | null;
    qaMode?: string; allowWrites?: boolean; planSkills?: string[];
  }
  | {
    kind: 'continue'; slug: string; run: RunState;
    qaMode?: string; allowWrites?: boolean; planSkills?: string[];
  }
  | { kind: 'qa'; target: QaTarget; allowWrites?: boolean };

/** What each QA profile costs, read while choosing it — the run controls' own words. */
function QaProfileNote({ profile }: { profile: QaProfile }) {
  if (profile === 'guarded') {
    return (
      <>
        The CLI asks you in the terminal before it edits, runs a command or commits. Slower, and
        the right default for a review — most of the work is reading.
      </>
    );
  }
  return (
    <>
      <strong>The CLI stops asking</strong> (<code className="font-mono">--permission-mode
      bypassPermissions</code>). Your deny list still holds — it is enforced by the CLI, not by
      this console. Requires the bypass disclaimer to have been accepted once, interactively, in a
      normal <code className="font-mono">claude</code> session on this machine; without it the CLI
      silently downgrades and asks for everything instead.
    </>
  );
}

function heading(request: LaunchRequest): { title: string; description: string } {
  switch (request.kind) {
    case 'recovery':
      return {
        title: RECOVERY_LABELS[request.recoveryClass],
        description: RECOVERY_BLURBS[request.recoveryClass],
      };
    case 'phase':
      return {
        title: `Run only phase ${request.phase}`,
        description: 'Run this phase on its own, then stop — the loop does not carry on into the '
          + 'rest of the plan.',
      };
    case 'continue':
      return {
        title: 'Continue the run',
        description: 'Picks the run up where it stopped, with the settings below. The scope is '
          + 'cleared — a continue never silently inherits a single-phase run.',
      };
    case 'qa':
      return {
        title: `QA phase ${request.target.phase}`,
        description: 'A fresh Claude session reviews this phase against its own exit criteria and '
          + 'records the verdict with qa-record.sh. It is never the session that built it.',
      };
  }
}

export function LaunchDialog({ request, onClose, onDone }: {
  request: LaunchRequest;
  onClose: () => void;
  /** Called after a successful submit, once the dialog's own bookkeeping ran. */
  onDone?: (sessionId?: string) => void;
}) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const { data: skills } = useSkills(true);
  const prefs = automationPrefs(state);
  const defaultSkills = state?.defaultSkills ?? [];

  const run = request.kind === 'phase' || request.kind === 'continue' ? request.run : null;
  const qaTarget = request.kind === 'qa' ? request.target : null;
  const planSkills = request.kind === 'qa'
    ? request.target.planSkills ?? []
    : (request.kind === 'phase' || request.kind === 'continue') ? request.planSkills ?? [] : [];

  // Seeded from the record that already exists — the run's own settings, the
  // phase's own plan bullets — so the dialog opens on what would happen and
  // the operator overrides rather than retypes.
  const [model, setModel] = useState(qaTarget ? qaTarget.model ?? '' : run?.model ?? (request.kind === 'recovery' ? '' : DEFAULTS.model));
  const [effort, setEffort] = useState(qaTarget ? qaTarget.effort ?? '' : run?.effort ?? (request.kind === 'recovery' ? '' : DEFAULTS.effort));
  const [profile, setProfile] = useState<PermissionProfile>(run?.permissionProfile ?? DEFAULTS.permissionProfile);
  const [qaProfile, setQaProfile] = useState<QaProfile>('guarded');
  const [chosen, setChosen] = useState<string[]>(
    qaTarget ? qaTarget.planSkills ?? [] : run?.skills ?? [],
  );

  // The preference-seeded fields derive LIVE until the operator touches them:
  // `/api/state` arrives after the first render, and a useState seed taken
  // before it would silently show the fallback instead of the preference.
  // `null` means "the operator has not said" — the preference (or the run's
  // own record) keeps answering until they do.
  const [attachChoice, setAttachChoice] = useState<boolean | null>(null);
  const attach = attachChoice ?? (prefs.attachDefaultSkills && defaultSkills.length > 0);

  // Run-flavoured extras. The QA toggle is offered only where turning the gate
  // on can actually be done; the git section only where a run is being minted.
  const qaOffered = (request.kind === 'phase' || request.kind === 'continue')
    && request.qaMode === 'off';
  const canQaToggle = qaOffered && request.allowWrites !== false;
  const [qaChoice, setQaChoice] = useState<boolean | null>(null);
  const qaOn = qaChoice ?? (canQaToggle && prefs.qaByDefault);
  const [gitChoice, setGitChoice] = useState<'default-branch' | 'new-branch' | null>(null);
  const gitMode = gitChoice ?? run?.gitMode ?? prefs.gitMode;
  const [prChoice, setPrChoice] = useState<boolean | null>(null);
  const openPr = prChoice ?? run?.openPr ?? prefs.openPrOnComplete;

  // The QA variant's activation checkbox — the old QaDialog's, verbatim.
  const canActivate = qaTarget?.qaMode === 'off' && (request.kind !== 'qa' || request.allowWrites !== false);
  const [activate, setActivate] = useState(canActivate);
  const [busy, setBusy] = useState(false);

  const merged = () => [...new Set([...(attach ? defaultSkills : []), ...chosen])];

  async function submit() {
    setBusy(true);
    try {
      if (request.kind === 'qa') {
        const id = await startQa(client, {
          slug: request.target.slug,
          phase: request.target.phase,
          model,
          effort,
          permissionProfile: qaProfile,
          ...(merged().length ? { skills: merged() } : {}),
          ...(activate && canActivate ? { activate: true } : {}),
        });
        if (id) { onDone?.(id); onClose(); }
        return;
      }

      if (request.kind === 'recovery') {
        const id = await startRecovery(client, {
          recoveryClass: request.recoveryClass,
          slug: request.slug,
          ...(request.phase != null ? { phase: request.phase } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(merged().length ? { skills: merged() } : {}),
        });
        if (id) { onDone?.(id); onClose(); }
        return;
      }

      // phase | continue — both are `runStart`, and the payload states exactly
      // what the dialog shows. The attach choice goes as the flag (the server
      // unions the machine list in), never pre-merged here, so the run's
      // record says which skills were picked and which rode along.
      const resumable = request.kind === 'continue'
        ? request.run
        : request.run && request.run.status !== 'finished' ? request.run : null;
      await api.runStart(request.slug, {
        model,
        effort,
        autonomy: run?.autonomy ?? DEFAULTS.autonomy,
        phaseBudgetUsd: run?.phaseBudgetUsd ?? null,
        runBudgetUsd: run?.runBudgetUsd ?? null,
        permissionProfile: profile,
        skills: chosen,
        ...(attach ? { attachDefaultSkills: true } : {}),
        gitMode,
        ...(gitMode === 'new-branch' ? { openPr } : {}),
        ...(qaOn && canQaToggle ? { qa: true } : {}),
        ...(resumable ? { resumeRunId: resumable.id } : {}),
        ...(request.kind === 'phase' ? { onlyPhases: [request.phase] } : {}),
      });
      toast(request.kind === 'phase'
        ? `Running phase ${request.phase} of ${request.slug}`
        : `Continuing ${request.slug}`, 'ok');
      void client.invalidateQueries({ queryKey: keys.runs() });
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.stats() });
      void client.invalidateQueries({ queryKey: keys.state() });
      onDone?.();
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const { title, description } = heading(request);
  const submitLabel = request.kind === 'qa' ? 'Start review'
    : request.kind === 'recovery' ? RECOVERY_LABELS[request.recoveryClass]
      : request.kind === 'phase' ? `Run phase ${request.phase}` : 'Continue';

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title={title} description={description}>
        <div className="flex flex-col gap-3">
          {qaTarget?.title && (
            <p className="text-sm text-ink-muted">
              <span className="font-mono text-2xs text-ink-faint">{qaTarget.slug}</span> · {qaTarget.title}
            </p>
          )}

          {qaTarget?.qa && isVerdict(qaTarget.qa.result) && (
            <Banner severity={qaTarget.qa.result === 'fail' ? 'warn' : 'info'}>
              This phase already records <strong>{qaTarget.qa.result}</strong>
              {qaTarget.qa.report ? <> ({qaTarget.qa.report})</> : null}. The session is told to read that
              report first and judge the phase as it stands now.
            </Banner>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Model</span>
              <select className={field} value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">default — this machine’s</option>
                {MODELS.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Effort</span>
              <select className={field} value={effort} onChange={(event) => setEffort(event.target.value)}>
                {EFFORTS.map((level) => (
                  <option key={level} value={level}>{EFFORT_NOTE[level] ?? level}</option>
                ))}
              </select>
            </label>
          </div>

          {request.kind === 'qa' && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
              <select
                className={field}
                value={qaProfile}
                onChange={(event) => setQaProfile(event.target.value as QaProfile)}
              >
                {QA_PROFILES.map((id) => (
                  <option key={id} value={id}>{QA_PROFILE_LABEL[id]}</option>
                ))}
              </select>
              <span className="text-2xs text-ink-faint"><QaProfileNote profile={qaProfile} /></span>
            </label>
          )}

          {(request.kind === 'phase' || request.kind === 'continue') && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
              <select
                className={field}
                value={profile}
                onChange={(event) => setProfile(event.target.value as PermissionProfile)}
              >
                {(Object.keys(PROFILE_LABEL) as PermissionProfile[]).map((id) => (
                  <option key={id} value={id}>{PROFILE_LABEL[id]}</option>
                ))}
              </select>
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
              <Button size="sm" aria-pressed={attach} onClick={() => setAttachChoice(!attach)}>
                {attach ? 'Attached' : 'Off'}
              </Button>
            </div>
          )}

          <SkillPicker
            skills={skills ?? []}
            chosen={chosen}
            planSkills={planSkills}
            defaultSkills={defaultSkills}
            onChange={setChosen}
            label={request.kind === 'qa' ? 'Skills for this review' : 'Skills for this run'}
          />

          {(request.kind === 'phase' || request.kind === 'continue') && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-2xs uppercase tracking-wide text-ink-faint">Branch</span>
                <select
                  className={field}
                  value={gitMode}
                  onChange={(event) => setGitChoice(event.target.value as 'default-branch' | 'new-branch')}
                >
                  <option value="default-branch">Work on the current branch</option>
                  <option value="new-branch">Create a work branch per run (pe/{request.slug})</option>
                </select>
              </label>
              {gitMode === 'new-branch' && (
                <label className="flex flex-wrap items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--action)]"
                    checked={openPr}
                    onChange={(event) => setPrChoice(event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    Open a PR when the plan completes
                    <span className="block text-2xs text-ink-faint">
                      The final phase pushes the branch and opens the PR — after one approval tap on
                      the push. Force-pushes stay denied outright.
                    </span>
                  </span>
                </label>
              )}
              {qaOffered && (
                <label className="flex flex-wrap items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--action)]"
                    checked={qaOn && canQaToggle}
                    disabled={!canQaToggle}
                    title={canQaToggle ? undefined : 'Writes are disabled. Restart the console with --allow-writes.'}
                    onChange={(event) => setQaChoice(event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    Turn the QA gate on for this plan
                    <span className="block text-2xs text-ink-faint">
                      Each finished phase then waits for an independent review. Phases that finished
                      before now are recorded as <em>waived</em>, so turning it on does not
                      retroactively hold the board.
                    </span>
                  </span>
                </label>
              )}
            </>
          )}

          {qaTarget?.qaMode === 'off' && (
            <label className="flex flex-wrap items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-[var(--action)]"
                checked={activate && canActivate}
                disabled={!canActivate}
                title={canActivate ? undefined : 'Writes are disabled. Restart the console with --allow-writes.'}
                onChange={(event) => setActivate(event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                Turn QA on for this plan (<code className="font-mono">--qa</code>)
                <span className="block text-2xs text-ink-faint">
                  {canActivate
                    ? <>
                        Creates <code className="font-mono">test-status.md</code> so verdicts gate
                        dependents. Phases that finished before now are recorded as <em>waived</em>,
                        so turning it on does not retroactively hold the board. Without this the
                        review still runs — its verdict just gates nothing.
                      </>
                    : <>
                        Writes are off — restart the console with{' '}
                        <code className="font-mono">--allow-writes</code> to turn QA on from here.
                        The review still runs; its verdict just gates nothing until then.
                      </>}
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="items-center justify-between">
          <span className="text-2xs text-ink-faint">
            {request.kind === 'qa'
              ? 'The session records the verdict, not the console.'
              : 'Opens with the Automation defaults from Settings; this launch overrides them.'}
          </span>
          <div className="flex gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="action" disabled={busy} onClick={() => void submit()}>
              {request.kind === 'qa'
                ? <ShieldCheck size={15} aria-hidden />
                : <Bot size={15} aria-hidden />} {busy ? 'Starting…' : submitLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
