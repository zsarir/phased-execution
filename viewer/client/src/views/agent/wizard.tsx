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
import { Button, Dialog, DialogClose, DialogContent, DialogFooter, toast } from '@/components/ui';
import { SkillPicker } from '../run/skill-picker';
import { DEFAULTS, EFFORTS, EFFORT_NOTE, MODELS } from '../run/defaults';

const field = 'h-9 rounded border border-rule bg-ground px-2 text-sm disabled:opacity-50';

/**
 * Gated on the AGENT capability, deliberately not on `allowWrites`: the
 * console itself writes nothing here — the claude session does, with the
 * operator watching. The scaffold-only button keeps its own gate beside this.
 */
export function NewPlanWizardButton({ allowAgent }: { allowAgent: boolean }) {
  const [open, setOpen] = useState(false);
  if (!allowAgent) return null;
  return (
    <>
      <Button size="sm" variant="action" onClick={() => setOpen(true)}>
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
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const ticket = await api.agentTicket({
        intent: 'plan',
        brief: brief.trim(),
        model,
        effort,
        ...(chosen.length ? { skills: chosen } : {}),
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
        description={'A Claude session opens in the Agent terminal, invokes the phased-execution '
          + 'skill’s plan mode, scaffolds docs/plans/<slug>.md, validates it and commits — '
          + 'you answer its questions in the terminal.'}
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

          {rootOpen ? (
            <SkillPicker
              skills={skills ?? []}
              chosen={chosen}
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
