/**
 * "QA this phase" — the launcher, and the three states of the control that opens it.
 *
 * ## Why a dialog and not a button
 *
 * A recovery is one decision: the console already knows what went wrong, so
 * there is nothing to choose. A review is not. Which model reads the diff, how
 * hard it thinks, whether it may act without asking, and which of the plan's
 * skills it invokes are all choices that change what the review is worth — and
 * they are exactly the choices the autopilot's own controls already offer. So
 * the dialog reuses that vocabulary (`views/run/defaults.ts`) rather than
 * inventing a second one, and it resolves per field the way the runner does:
 * whatever the operator picks, else the plan's own `**Model:**` / `**Effort:**`
 * for this phase, else the console default.
 *
 * ## Why the profile is two options and not three
 *
 * `trusted` is an autopilot idea — it means no approval *card* is raised, and
 * there is no card here: a review runs in a terminal a person is looking at.
 * The only real question is whether the CLI asks that person before it acts,
 * which is Guarded, or does not, which is Bypass. The bypass copy is the run
 * controls' own, because it is the same disclaimer and the same trap.
 *
 * ## Why "turn QA on" is a checkbox and not a separate page
 *
 * A plan with QA off can still be reviewed — the session just has nothing to
 * gate. Offering activation at the moment somebody asks for a review is the
 * only moment it is obviously the right question, and the copy says what it
 * costs: every already-finished phase is recorded as waived, so turning it on
 * does not retroactively hold the whole board.
 */

import { useState } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banner, Button, Chip, Dialog, DialogClose, DialogContent, DialogFooter,
} from '@/components/ui';
import { useSkills } from '@/lib/queries';
import { startQa } from '@/lib/start-qa';
import { QA_PROFILES, QA_PROFILE_LABEL, QA_TONE, isVerdict, type QaProfile } from '@/lib/qa';
import { EFFORTS, EFFORT_NOTE, MODELS } from '@/views/run/defaults';
import { SkillPicker } from '@/views/run/skill-picker';

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

/** What each profile costs, read while choosing it — the run controls' own words. */
function ProfileNote({ profile }: { profile: QaProfile }) {
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

export function QaDialog({ target, allowWrites, onClose }: {
  target: QaTarget;
  /** Activation writes `test-status.md`, so it is gated separately from minting. */
  allowWrites?: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { data: skills } = useSkills(true);

  // Seeded from the plan's own per-phase options, so the dialog opens on what
  // this phase would have been RUN as — the operator overrides, never retypes.
  const [model, setModel] = useState(target.model ?? '');
  const [effort, setEffort] = useState(target.effort ?? '');
  const [profile, setProfile] = useState<QaProfile>('guarded');
  const [chosen, setChosen] = useState<string[]>(target.planSkills ?? []);
  // Offered only where it can actually be done. A checkbox that fails on submit
  // is worse than one that says why it is unavailable before you tick it.
  const canActivate = target.qaMode === 'off' && allowWrites !== false;
  const [activate, setActivate] = useState(canActivate);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const id = await startQa(client, {
        slug: target.slug,
        phase: target.phase,
        model,
        effort,
        permissionProfile: profile,
        ...(chosen.length ? { skills: chosen } : {}),
        ...(activate && canActivate ? { activate: true } : {}),
      });
      if (id) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        title={`QA phase ${target.phase}`}
        description={
          `A fresh Claude session reviews this phase against its own exit criteria and records the `
          + `verdict with qa-record.sh. It is never the session that built it.`
        }
      >
        <div className="flex flex-col gap-3">
          {target.title && (
            <p className="text-sm text-ink-muted">
              <span className="font-mono text-2xs text-ink-faint">{target.slug}</span> · {target.title}
            </p>
          )}

          {target.qa && isVerdict(target.qa.result) && (
            <Banner severity={target.qa.result === 'fail' ? 'warn' : 'info'}>
              This phase already records <strong>{target.qa.result}</strong>
              {target.qa.report ? <> ({target.qa.report})</> : null}. The session is told to read that
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

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
            <select
              className={field}
              value={profile}
              onChange={(event) => setProfile(event.target.value as QaProfile)}
            >
              {QA_PROFILES.map((id) => (
                <option key={id} value={id}>{QA_PROFILE_LABEL[id]}</option>
              ))}
            </select>
            <span className="text-2xs text-ink-faint"><ProfileNote profile={profile} /></span>
          </label>

          <SkillPicker
            skills={skills ?? []}
            chosen={chosen}
            planSkills={target.planSkills ?? []}
            onChange={setChosen}
            label="Skills for this review"
          />

          {target.qaMode === 'off' && (
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
          <span className="text-2xs text-ink-faint">The session records the verdict, not the console.</span>
          <div className="flex gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="action" disabled={busy} onClick={() => void submit()}>
              <Bot size={15} aria-hidden /> {busy ? 'Starting…' : 'Start review'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Start a review, or go to the one already running.
 *
 * Three states and no fourth — the same contract `RecoveryButton` keeps: a live
 * session is a link, a permitted console is a button, and a console without
 * `--allow-agent` is a disabled button naming the flag that turns it on. Never
 * simply absent: a capability that exists and is unavailable has to say so.
 */
export function QaButton({
  target,
  allowAgent,
  allowWrites,
  runningSessionId,
  size = 'sm',
  label = 'QA this phase',
}: {
  target: QaTarget;
  allowAgent: boolean;
  /** Passed through to the activation checkbox — a different flag, a different gate. */
  allowWrites?: boolean;
  runningSessionId?: string;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  if (runningSessionId) {
    return (
      <Button size={size} asChild>
        <a href={`#/agent/${runningSessionId}`}>
          <ShieldCheck size={13} aria-hidden /> QA running
        </a>
      </Button>
    );
  }

  return (
    <>
      <Button
        size={size}
        disabled={!allowAgent}
        title={allowAgent
          ? 'Opens a fresh Claude session that reviews this phase and records the verdict itself.'
          : 'Agent sessions are disabled. Restart the console with --allow-agent.'}
        onClick={() => setOpen(true)}
      >
        <ShieldCheck size={13} aria-hidden /> {label}
      </Button>
      {open && <QaDialog target={target} allowWrites={allowWrites} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The recorded verdict, beside the control that produced it.
 *
 * `pending` is deliberately not rendered as a result: a row that says pending
 * is a review that was asked for and never answered, and showing it as a chip
 * next to `pass` and `fail` would read as a third verdict.
 */
export function QaVerdict({ qa, href }: { qa?: { result: string; report?: string }; href?: string }) {
  if (!qa || !isVerdict(qa.result)) return null;
  const chip = <Chip tone={QA_TONE[qa.result] as never}>QA {qa.result}</Chip>;
  return qa.report && href
    ? <a href={href} className="hover:underline" title={qa.report}>{chip}</a>
    : chip;
}
