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
import { usePhone } from '@/lib/media';
import { keys, useConsoleState } from '@/lib/queries';
import { estimateTerminalSize } from '@/lib/terminal';
import { navigate } from '@/app/router';
import { Button, Dialog, DialogClose, DialogContent, toast, type ButtonProps } from '@/components/ui';
import { RunSetup } from '@/features/run-setup/run-setup';

/**
 * Gated on the AGENT capability, deliberately not on `allowWrites`: the
 * console itself writes nothing here — the claude session does, with the
 * operator watching. The scaffold-only button keeps its own gate beside this.
 */
export function NewPlanWizardButton({
  allowAgent,
  variant = 'action',
}: {
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
  const phone = usePhone();
  const { data: state } = useConsoleState();
  const rootOpen = Boolean(state?.root?.path);
  const [brief, setBrief] = useState('');

  // The fields are `RunSetup` in `plan` mode; what stays here is the brief,
  // and the ticket — which carries an `intent` and a `brief` no run door has.
  async function start(body: Record<string, unknown>) {
    try {
      const ticket = await api.agentTicket({
        ...body,
        intent: 'plan',
        brief: brief.trim(),
        // The size the pane will settle on — the CLI lays its first screen
        // out for the window it is actually in (the pane corrects on open).
        ...estimateTerminalSize(phone),
        // No `permissionMode`, by construction: `plan` mode does not offer one.
        // The server defaults a plan intent to plan mode (`agent.ts` — the
        // phase list is the decision), and the select this form used to have
        // was the one hole left in that rule. A session for ANY other purpose
        // belongs in the launcher, which still offers every mode.
      } as never);
      // Same two rules as every session the console opens: seed the list from
      // the ticket so the next render is right, and `void` the invalidation.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
          prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
        );
      }
      void client.invalidateQueries({ queryKey: keys.terminal() });
      onClose();
      navigate(`sessions/${ticket.sessionId}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="New plan with AI"
        description={
          'A Claude session opens in the Agent terminal and invokes the phased-execution ' +
          'skill’s plan mode. It presents the phase graph for your approval first, then scaffolds ' +
          'docs/plans/<slug>.md, validates it and commits — you answer its questions, and approve, ' +
          'in the terminal.'
        }
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

          {/* Stated where the select used to be, and still not a control.
              `plan` mode offers no Permissions field at all (`modes.ts`), so
              there is genuinely nothing here to change — but a form that simply
              omitted the row would read as one that forgot it. */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
            <span
              className="text-ink-muted"
              title="Plan-authoring sessions always start in plan mode: the session explores and presents the plan for approval before anything is written."
            >
              plan mode — fixed for authoring
            </span>
          </div>

          <p className="text-2xs text-ink-faint">
            The session explores and presents the plan first — it writes docs/plans/&lt;slug&gt;.md only after
            you approve it in the terminal (⇧Tab inside the session cycles modes for the steps AFTER
            approval). Any other mode here could write a plan nobody approved, so this form does not offer
            one.
          </p>

          {!rootOpen && (
            <p className="text-sm text-ink-faint">
              Open a source directory first — the plan is written into its docs/plans/.
            </p>
          )}

          <RunSetup
            mode="plan"
            skillsEnabled={rootOpen}
            blocked={!brief.trim() || !rootOpen}
            blockedReason={rootOpen ? 'Write the brief first — it is what the session is given.' : undefined}
            onLaunch={(body: Record<string, unknown>) => start(body)}
            cancel={
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
