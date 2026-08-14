/**
 * "New plan with AI" — the wizard that turns a brief into a plan-authoring
 * claude session.
 *
 * The server owns the boot prompt (`server/agent.ts` — the phased-execution
 * skill's own Mode 1, spelled as steps); this dialog collects the brief and
 * the session options, mints `{intent: 'plan'}`, and lands on the session's
 * terminal, where the operator answers the model's questions. The plan file
 * appearing on disk is noticed by the agent page's PlanWatcher through the
 * ordinary `changed` → plans-list invalidation — no new plumbing.
 *
 * ⚠️ This module must never import the pane (or anything xterm-shaped): it
 * mounts in the PLANS chunk too, and dragging the emulator in would put
 * 89 KB behind every reader of the plans list. check-dist's precache checks
 * are the machine guard; this comment is the human one.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api, type TerminalState } from '@/lib/api';
import { keys, useConsoleState, useSkills } from '@/lib/queries';
import { navigate } from '@/router';
import {
  Button, Dialog, DialogClose, DialogContent, DialogFooter, toast, type ButtonProps,
} from '@/components/ui';
import { SkillPicker } from '../run/skill-picker';
import { DEFAULTS, EFFORTS, EFFORT_NOTE, MODELS } from '../run/defaults';
import { field } from '@/components/ui/field';

/**
 * Gated on the AGENT capability, deliberately not on `allowWrites`: the
 * console itself writes nothing here — the claude session does, with the
 * operator watching. The scaffold-only button keeps its own gate beside this.
 */
export function NewPlanWizardButton({ allowAgent, variant = 'action' }: {
  allowAgent: boolean;
  /**
   * Primary where authoring IS the page's action (the Plans toolbar, a quiet
   * dashboard with nothing ready) and secondary where something else already
   * is — two action-weight buttons side by side name no first move.
   */
  variant?: ButtonProps['variant'];
}) {
  const [open, setOpen] = useState(false);
  if (!allowAgent) return null;
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Sparkles size={14} aria-hidden /> New plan with AI
      </Button>
      {open && <NewPlanWizard onClose={() => setOpen(false)} />}
    </>
  );
}

export function NewPlanWizard({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const rootOpen = Boolean(state?.root?.path);
  const { data: skills } = useSkills(rootOpen);
  const [brief, setBrief] = useState('');
  const [model, setModel] = useState<string>(DEFAULTS.model);
  const [effort, setEffort] = useState<string>(DEFAULTS.effort);
  const [chosen, setChosen] = useState<string[]>([]);
  // Derives from the Automation preference until the operator says otherwise —
  // `/api/state` arrives after the first render, so a one-shot seed would miss
  // it. The ticket has no attach flag; ticked means the names ride in `skills`.
  const defaultSkills = state?.defaultSkills ?? [];
  const [attachChoice, setAttachChoice] = useState<boolean | null>(null);
  const attach = attachChoice
    ?? ((state?.prefs?.attachDefaultSkills ?? false) === true && defaultSkills.length > 0);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const ticket = await api.agentTicket({
        intent: 'plan',
        brief: brief.trim(),
        model,
        effort,
        // No `permissionMode`: the omission IS the choice. The server defaults
        // a plan intent to plan mode (`agent.ts` — the phase list is the
        // decision), and the select this form used to offer was the one hole
        // left in that rule: `auto`/`acceptEdits` here launched an authoring
        // session that could write a plan nobody had approved. A session for
        // ANY other purpose belongs in the launcher, which still offers every
        // mode.
        ...((() => {
          const merged = [...new Set([...(attach ? defaultSkills : []), ...chosen])];
          return merged.length ? { skills: merged } : {};
        })()),
      });
      // Same two rules as every session the console opens: seed the list from
      // the ticket so the next render is right, and `void` the invalidation.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) => (prev
          ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] }
          : prev));
      }
      void client.invalidateQueries({ queryKey: keys.terminal() });
      onClose();
      navigate(`agent/${ticket.sessionId}`);
    } catch (error) {
      toast((error as Error).message, 'error');
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        title="New plan with AI"
        description={'A Claude session opens in the Agent terminal and invokes the phased-execution '
          + 'skill’s plan mode. It presents the phase graph for your approval first, then scaffolds '
          + 'docs/plans/<slug>.md, validates it and commits — you answer its questions, and approve, '
          + 'in the terminal.'}
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">The brief</span>
            {/* text-base = 16px — below that iOS zooms on focus. */}
            <textarea
              className="min-h-36 rounded border border-rule bg-ground p-2 text-base"
              placeholder="What should this plan achieve? Constraints, repos, anything the author must know."
              maxLength={8000}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
              {/* Not a select. A plan-authoring session starts in plan mode,
                  always — any other mode here could write a plan nobody
                  approved. Generic sessions with mode choices live in the
                  launcher. */}
              <div
                className={`${field} flex items-center text-ink-muted`}
                title="Plan-authoring sessions always start in plan mode: the session explores and presents the plan for approval before anything is written."
              >
                plan mode — fixed for authoring
              </div>
            </div>
          </div>

          <p className="text-2xs text-ink-faint">
            The session explores and presents the plan first — it writes docs/plans/&lt;slug&gt;.md
            only after you approve it in the terminal (⇧Tab inside the session cycles modes for
            the steps AFTER approval).
          </p>

          {rootOpen && defaultSkills.length > 0 && (
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

          {rootOpen ? (
            <SkillPicker
              skills={skills ?? []}
              chosen={chosen}
              defaultSkills={defaultSkills}
              onChange={setChosen}
              label="Extra skills for the authoring session"
            />
          ) : (
            <p className="text-sm text-ink-faint">
              Open a source directory first — the plan is written into its docs/plans/.
            </p>
          )}
        </div>

        <DialogFooter className="items-center justify-between">
          <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
          <Button
            variant="action"
            disabled={busy || !brief.trim() || !rootOpen}
            onClick={() => void start()}
          >
            <Sparkles size={14} aria-hidden /> Start authoring
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
