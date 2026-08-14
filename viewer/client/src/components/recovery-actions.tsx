/**
 * Every way forward, rendered ONE way.
 *
 * The pages used to hand-roll four different subsets of the same five verbs —
 * halt banner, next-steps, phase row, diagnosis — under five word-books, and
 * the two AI mechanisms ("Fix with AI" vs "Finish this phase") sat side by
 * side with nothing saying how they differ. This component renders the shared
 * model's answer (`recoveryActionsFor`) for whatever context a surface holds:
 * grouped primary → secondary → overflow, every action carrying the exact
 * "what will happen" blurb (hover tooltip on desktop, a tappable ⓘ on touch),
 * disabled-with-reason rather than absent, and one live-session chip instead
 * of two differently-named buttons silently sharing one session.
 */

import { useMemo, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { Button, InfoTip, Tooltip, TooltipProvider } from '@/components/ui';
import { LaunchDialog } from '@/components/launch-dialog';
import { useConsoleState, useSessions } from '@/lib/queries';
import { useTouch } from '@/lib/media';
import {
  MECHANISMS, MECHANISM_LEGEND, RECOVERY_TITLES,
  liveRecovery, recoveryActionsFor, type RecoveryClass,
} from '@/lib/recovery';
import { runRecoverVerb, type RunRecoverVerb } from '@/lib/run-recover';
import { cn } from '@/lib/cn';

/** What a surface knows; everything optional — the model tolerates absence. */
export type RecoveryCtx = {
  boardState?: string;
  record?: { status: string; resumable?: boolean } | null;
  run?: {
    status: string;
    halt?: { reason?: string; kind?: string; phase?: number } | null;
    resolved?: unknown;
  } | null;
  lock?: { holder?: string | null; expired?: boolean };
  authFailure?: boolean;
  /** The plan itself fails lint/health — plan-repair's own case. */
  planIssues?: boolean;
};

type ActionView = {
  id: string;
  mechanism: keyof typeof MECHANISMS;
  label: string;
  blurb: string;
  group: 'primary' | 'secondary' | 'overflow';
  recoveryClass?: string;
  disabledReason?: string;
};

const RUN_VERBS = new Set<string>(['recheck', 'closeout', 'resume', 'retry', 'skip', 'mcp-continue', 'auto-recover']);

export function RecoveryActions({
  target,
  ctx,
  max = 2,
  legend = false,
  showBlurbs = false,
  perform,
  className,
}: {
  /** What the actions are about — the ticket, the verbs and the dedupe key all use it. */
  target: { slug: string; phase?: number; runId?: string };
  ctx: RecoveryCtx;
  /** How many non-overflow actions render inline; the rest fold into "More ways forward". */
  max?: number;
  /** Show the two-mechanism legend when both AI families are on offer. */
  legend?: boolean;
  /** Render every blurb as visible text (the diagnosis panel) instead of tooltip-only. */
  showBlurbs?: boolean;
  /** Surface-owned verbs (continue-run, dismiss, release, force-release):
   * rendered only when the surface says how to perform them. */
  perform?: Partial<Record<string, () => void>>;
  className?: string;
}) {
  const touch = useTouch();
  const { data: state } = useConsoleState();
  const { data: sessions } = useSessions(state);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RecoveryClass | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [instruction, setInstruction] = useState('');

  const running = liveRecovery(sessions?.sessions, target);
  const actions = useMemo(() => (recoveryActionsFor({
    ...ctx,
    flags: {
      allowRun: Boolean(state?.allowRun),
      allowWrites: Boolean(state?.allowWrites),
      allowAgent: Boolean(state?.allowAgent),
    },
    live: { recoverySessionId: running?.id ?? null },
  }) as ActionView[]).filter((action) =>
    RUN_VERBS.has(action.id) || action.id === 'fix-agent' || perform?.[action.id]),
  [ctx, state, running?.id, perform]);

  if (!actions.length && !running) return null;

  const inline = actions.filter((action) => action.group !== 'overflow').slice(0, max);
  const rest = actions.filter((action) => !inline.includes(action));
  const bothFamilies = actions.some((action) => action.mechanism === 'own-session')
    && actions.some((action) => action.mechanism === 'new-agent');

  const act = (action: ActionView) => {
    if (action.disabledReason) return;
    if (action.id === 'fix-agent' && action.recoveryClass) {
      setDialog(action.recoveryClass as RecoveryClass);
      return;
    }
    if (action.id === 'resume') { setResumeOpen((open) => !open); return; }
    if (perform?.[action.id]) { perform[action.id]!(); return; }
    if (!RUN_VERBS.has(action.id)) return;
    setBusy(action.id);
    void runRecoverVerb(action.id as RunRecoverVerb, target)
      .finally(() => setBusy(null));
  };

  const renderButton = (action: ActionView, variant: 'action' | 'default') => {
    const button = (
      <Button
        size="sm"
        variant={action.disabledReason ? 'default' : variant}
        disabled={Boolean(action.disabledReason) || busy === action.id}
        onClick={() => act(action)}
        aria-label={action.label}
      >
        {action.mechanism === 'new-agent' && <Bot size={13} aria-hidden />}
        {busy === action.id ? 'Working…' : action.label}
        <span className="ml-0.5 text-2xs font-normal text-ink-faint" aria-hidden>
          {MECHANISMS[action.mechanism].badge}
        </span>
      </Button>
    );
    return (
      <span key={action.id} className="inline-flex items-center gap-0.5">
        <Tooltip content={action.disabledReason ?? action.blurb}>
          {/* The span keeps the tooltip reachable on a DISABLED button —
              Radix triggers never fire on disabled elements. */}
          <span className="inline-flex" tabIndex={action.disabledReason ? 0 : undefined}>
            {button}
          </span>
        </Tooltip>
        {touch && <InfoTip content={action.disabledReason ?? action.blurb} label={`About ${action.label}`} />}
      </span>
    );
  };

  return (
    // Its own provider, so the component is whole wherever it is dropped —
    // it is embedded on ten surfaces, and half their test harnesses mount
    // without the app shell. Nesting under the app's provider is fine.
    <TooltipProvider delayDuration={300}>
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {running && (
          <Button size="sm" variant="default" asChild>
            <a href={`#/agent/${running.id}`} title="The recovery session already working on this — open it.">
              <Bot size={13} aria-hidden />
              {(RECOVERY_TITLES as Record<string, string>)[running.meta?.recovery?.kind ?? ''] ?? 'Recovery'} — running
            </a>
          </Button>
        )}
        {inline.map((action, index) => renderButton(action, index === 0 && action.group === 'primary' ? 'action' : 'default'))}
      </div>

      {resumeOpen && (
        <div className="flex flex-wrap items-end gap-2">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={2}
            placeholder="What it should fix before closing out…"
            className="min-h-16 w-full max-w-xl rounded border border-rule bg-ground px-2 py-1 text-sm"
          />
          <Button
            size="sm"
            variant="action"
            disabled={!instruction.trim() || busy === 'resume'}
            onClick={() => {
              setBusy('resume');
              void runRecoverVerb('resume', target, { instruction: instruction.trim() })
                .then((ok) => { if (ok) { setResumeOpen(false); setInstruction(''); } })
                .finally(() => setBusy(null));
            }}
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume with this'}
          </Button>
        </div>
      )}

      {rest.length > 0 && (
        <details className="text-sm">
          <summary className="flex min-h-(--tap-min) w-fit cursor-pointer select-none items-center gap-1 text-2xs text-ink-muted sm:min-h-0">
            <ChevronDown size={12} aria-hidden /> More ways forward ({rest.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-2 border-l border-rule pl-3">
            {rest.map((action) => (
              <li key={action.id} className="flex flex-col gap-0.5">
                <div>{renderButton(action, 'default')}</div>
                <p className="max-w-prose text-2xs text-ink-faint">{action.disabledReason ?? action.blurb}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {showBlurbs && inline.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {inline.map((action) => (
            <li key={action.id} className="max-w-prose text-2xs text-ink-faint">
              <strong className="font-medium text-ink-muted">{action.label}:</strong>{' '}
              {action.disabledReason ?? action.blurb}
            </li>
          ))}
        </ul>
      )}

      {legend && bothFamilies && (
        <p className="max-w-prose text-2xs text-ink-faint">{MECHANISM_LEGEND}</p>
      )}

      {dialog && (
        <LaunchDialog
          request={{
            kind: 'recovery',
            recoveryClass: dialog,
            slug: target.slug,
            ...(target.phase != null ? { phase: target.phase } : {}),
            ...(target.runId ? { runId: target.runId } : {}),
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
    </TooltipProvider>
  );
}
