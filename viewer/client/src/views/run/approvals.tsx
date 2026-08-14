/**
 * The queue: what is waiting on a person, and how to answer it.
 *
 * This is the top of the page because it is the answer to the only question
 * somebody opens this tab on a phone at 11pm to ask — "does this need me?" — so
 * the cards carry their own evidence and are answerable without scrolling past
 * anything.
 *
 * ## Two kinds of question, two vocabularies
 *
 * A permission question ("may I run this command?") and a verification question
 * ("did you check this yourself?") deserve different words. Labelling both
 * Allow/Deny is how a card that means "the plan asked for something only you can
 * confirm" reads as one more thing to rubber-stamp — and an approval nobody
 * reads is not an approval.
 *
 * ## The rule is editable before it is written
 *
 * "Always allow this" that writes something you never saw is how a policy file
 * fills up with rules nobody can account for. The suggested rule is a
 * suggestion; it is shown, editable, and only then written — with your name on
 * it and a line in the run's journal.
 */

import { useState } from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, Chip } from '@/components/ui';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import type { Approval } from '@/lib/api';

export type Decide = (
  id: string,
  decision: 'allow' | 'deny',
  reason?: string,
  remember?: 'plan' | 'global',
  rule?: string,
) => void;

export function ApprovalQueue({
  approvals,
  allowRun,
  onDecide,
}: {
  approvals: Approval[];
  allowRun: boolean;
  onDecide: Decide;
}) {
  if (!approvals.length) return null;
  return (
    <Card className="border-action/50">
      <CardHeader className="flex-wrap items-center">
        <CardTitle className="flex items-center gap-2">
          Waiting on you
          <span className="rounded-sm bg-action/15 px-1.5 py-0.5 font-mono text-sm text-action">
            {approvals.length}
          </span>
        </CardTitle>
        <NotifyToggle />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} allowRun={allowRun} onDecide={onDecide} />
        ))}
      </CardBody>
    </Card>
  );
}

/**
 * Offered here, where the value of it is on screen: you are looking at a queue
 * that waited for you to notice it. Asking on page load instead gets refused by
 * reflex, and that refusal sticks.
 */
function NotifyToggle() {
  const [state, setState] = useState<NotifyState>(() => notifyState());

  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return <span className="text-2xs text-ink-faint">You will be notified when this happens again.</span>;
  }
  if (state === 'denied') {
    return (
      <span className="text-2xs text-ink-faint">
        Notifications are blocked for this site — your browser's settings can undo that.
      </span>
    );
  }
  return (
    <Button size="sm" onClick={async () => setState(await askToNotify())}>
      Notify me next time
    </Button>
  );
}

function ApprovalCard({
  approval,
  allowRun,
  onDecide,
}: {
  approval: Approval;
  allowRun: boolean;
  onDecide: Decide;
}) {
  const [reason, setReason] = useState('');
  const [rule, setRule] = useState(approval.suggestedRule ?? '');
  const [showRule, setShowRule] = useState(false);
  const left = Math.max(0, Date.parse(approval.expiresAt) - Date.now());

  const asking = approval.kind === 'verify';
  const yes = asking ? 'I checked it — mark verified' : 'Allow';
  const no = asking ? 'It failed' : 'Deny';
  const placeholder = asking
    ? 'What you saw (optional — recorded against the phase)'
    : 'Why (optional — the session is told)';

  return (
    <article className="rounded-lg border border-rule bg-surface-raised p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-sm">{approval.title}</strong>
        <span className="text-2xs text-ink-faint">
          {approval.phase != null ? `phase ${approval.phase} · ` : ''}
          {left > 0 ? `${Math.ceil(left / 60000)} min to answer` : 'expiring'}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{approval.detail}</p>

      {approval.tool?.input?.command && (
        <pre className="mt-2 overflow-x-auto rounded border border-rule bg-ground px-2 py-1.5 font-mono text-2xs">
          {approval.tool.input.command}
        </pre>
      )}

      {approval.evidence?.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {approval.evidence.map((e, i) => (
            <details key={i} open={i === 0} className="rounded border border-rule">
              <summary className="cursor-pointer px-2 py-1 text-2xs">{e.label}</summary>
              <pre className="max-h-56 overflow-auto border-t border-rule bg-ground px-2 py-1.5 font-mono text-2xs">
                {e.body}
              </pre>
            </details>
          ))}
        </div>
      )}

      {asking && (
        <p className="mt-2 max-w-prose text-2xs text-ink-faint">
          The runner will not execute prose out of a plan file, so these were left for you. Marking
          them verified records that you checked them, against this phase, with your name on it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`reason-${approval.id}`}>
          {placeholder}
        </label>
        <input
          id={`reason-${approval.id}`}
          className="h-9 min-w-40 flex-1 rounded border border-rule bg-ground px-2 text-sm"
          placeholder={placeholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button variant="action" disabled={!allowRun} onClick={() => onDecide(approval.id, 'allow', reason)}>
          {yes}
        </Button>
        <Button variant="danger" disabled={!allowRun} onClick={() => onDecide(approval.id, 'deny', reason)}>
          {no}
        </Button>
      </div>

      {!asking && approval.suggestedRule && (
        <div className="mt-2">
          <button
            type="button"
            className="text-2xs text-ink-muted underline"
            aria-expanded={showRule}
            onClick={() => setShowRule(!showRule)}
          >
            {showRule ? '▾' : '▸'} Stop asking about this
          </button>
          {showRule && (
            <div className="mt-2 flex flex-col gap-2 rounded border border-rule bg-ground p-2">
              <label className="text-2xs text-ink-faint" htmlFor={`rule-${approval.id}`}>
                The rule that gets written — check it before it goes in:
              </label>
              <input
                id={`rule-${approval.id}`}
                className="h-8 [@media(hover:none)]:min-h-(--tap-min) w-full rounded border border-rule bg-surface px-2 font-mono text-2xs"
                value={rule}
                spellCheck={false}
                onChange={(e) => setRule(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!allowRun || !rule.trim()}
                  onClick={() => onDecide(approval.id, 'allow', reason, 'plan', rule.trim())}
                >
                  Always for {approval.slug}
                </Button>
                <Button
                  size="sm"
                  disabled={!allowRun || !rule.trim()}
                  onClick={() => onDecide(approval.id, 'allow', reason, 'global', rule.trim())}
                >
                  Always everywhere
                </Button>
              </div>
              <p className="max-w-prose text-2xs text-ink-faint">
                Allows and answers this call in one step. Written with your name on it and recorded
                in the run's journal; removable from Settings → Permissions.
              </p>
            </div>
          )}
        </div>
      )}

      {!allowRun && (
        <p className="mt-2 text-2xs text-ink-faint">
          This console cannot answer — it was started without <code className="font-mono">--allow-run</code>.
        </p>
      )}
    </article>
  );
}

/** The chip the runs page puts in its header. Exported so P5 need not re-derive it. */
export function ApprovalCount({ n }: { n: number }) {
  if (!n) return null;
  return <Chip tone="warn">{n} waiting on you</Chip>;
}
