/**
 * "Start a new plan" — the dashboard's one creative action.
 *
 * Everything else on this page is about work that already exists: what is
 * running, what is waiting, what the board would do next. Authoring the FIRST
 * plan, or the next one, was reachable only from the Plans list, which is the
 * one page you have no reason to open when the dashboard has just told you
 * nothing is running.
 *
 * The disabled state is deliberate rather than an absence. `NewPlanWizardButton`
 * renders nothing without `--allow-agent`, which is right for a toolbar and
 * wrong for a card: on a dashboard the gap would read as "this console cannot
 * make plans", when the truth is that it can and was started without the flag.
 * A capability the console HAS and cannot offer is shown and explained — the
 * same rule the phase panel's QA card follows.
 *
 * ⚠️ Imports the wizard, never the pane — see the note at the top of
 * `views/agent/wizard.tsx`. Dragging xterm into the dashboard chunk would put
 * the emulator behind the first page every reader opens.
 */

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { NewPlanWizard } from '../agent/wizard';

export function NewPlanCard({ allowAgent }: { allowAgent: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles size={14} className="text-action" aria-hidden />
          New plan
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-2.5">
        <p className="text-2xs text-ink-muted">
          Describe the work and a Claude session drafts the phase graph with you, then scaffolds,
          validates and commits <code className="font-mono">docs/plans/&lt;slug&gt;.md</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="action"
            disabled={!allowAgent}
            title={allowAgent ? undefined : 'Agent sessions are off on this console'}
            onClick={() => setOpen(true)}
          >
            <Sparkles size={14} aria-hidden /> New plan with AI
          </Button>
          {!allowAgent && (
            <span className="text-2xs text-ink-faint">
              Restart the console with{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">--allow-agent</code>.
            </span>
          )}
        </div>
      </CardBody>
      {open && <NewPlanWizard onClose={() => setOpen(false)} />}
    </Card>
  );
}
