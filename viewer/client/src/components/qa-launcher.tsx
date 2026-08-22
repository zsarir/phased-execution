/**
 * "QA this phase" — the button's three states, and the recorded verdict.
 *
 * The dialog itself is `LaunchDialog` over `RunSetup` in `qa` mode, where
 * every AI launch shares one field matrix (model, effort, permissions, skills,
 * the attach-defaults toggle) seeded from the Automation preferences. What
 * stays here is what is QA-specific and public: the `QaTarget` shape callers
 * build, the three-state button, and the verdict chip.
 *
 * The `QaDialog` wrapper is gone (Phase 6): it existed to spare callers from
 * knowing the dialog had been unified, and it had exactly one caller left —
 * this file — plus its own test. A wrapper whose only job is to hide a
 * consolidation is a place for the two to drift.
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, StatusBadge } from '@/components/ui';
import { qaResultTitle, qaUiState } from '@/lib/status-vocab';
import { isVerdict } from '@/lib/qa';
import { LaunchDialog, type QaTarget } from '@/components/launch-dialog';

export type { QaTarget } from '@/components/launch-dialog';

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
        title={
          allowAgent
            ? 'Opens a fresh Claude session that reviews this phase and records the verdict itself.'
            : 'Agent sessions are disabled. Restart the console with --allow-agent.'
        }
        onClick={() => setOpen(true)}
      >
        <ShieldCheck size={13} aria-hidden /> {label}
      </Button>
      {open && (
        <LaunchDialog
          request={{ kind: 'qa', target, ...(allowWrites !== undefined ? { allowWrites } : {}) }}
          onClose={() => setOpen(false)}
        />
      )}
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
  const chip = (
    <StatusBadge state={qaUiState(qa.result)} label={`QA ${qa.result}`} title={qaResultTitle(qa.result)} />
  );
  return qa.report && href ? (
    <a href={href} className="hover:underline" title={qa.report}>
      {chip}
    </a>
  ) : (
    chip
  );
}
