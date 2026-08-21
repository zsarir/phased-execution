/**
 * The run-verb half of a recovery action, performed — with the one refusal
 * that matters handled the way `start-recovery.ts` taught: a 409 carrying a
 * sessionId means an agent recovery already holds this phase, and the useful
 * response is to go look at it, not to error.
 *
 * No query invalidation on success: every one of these verbs makes the server
 * emit `run:state`, and the SSE plane is what keeps the pages honest — the
 * same contract the old one-off buttons relied on.
 */

import { ApiError, api } from './api';
import { navigate } from '@/app/router';
import { toast } from '../components/ui';

export type RunRecoverVerb =
  'recheck' | 'closeout' | 'resume' | 'retry' | 'skip' | 'mcp-continue' | 'auto-recover';

const CONFIRMATIONS: Record<RunRecoverVerb, string> = {
  'auto-recover': '', // recoverPlan answers with its own steps — toasted below.
  recheck: 'Re-checking — board, verification and validate.sh.',
  closeout: "Resuming the phase's session to finish the closeout.",
  resume: "Resuming the phase's session with your instruction.",
  retry: 'Cleared the failure — the run continues from here.',
  skip: 'Skipped. The board still reads it as not done.',
  'mcp-continue': 'Carrying on without the servers that would not connect.',
};

export async function runRecoverVerb(
  verb: RunRecoverVerb,
  target: { slug: string; phase?: number },
  opts: { instruction?: string } = {},
): Promise<boolean> {
  try {
    const { slug, phase } = target;
    if (verb === 'auto-recover') {
      // The one verb that reports its own story: every step the server took,
      // then the outcome in its own tone.
      const report = await api.runRecover(slug);
      for (const step of report.steps) toast(step, 'ok');
      toast(report.detail, report.outcome === 'errand' ? 'warn' : 'ok');
      return report.outcome !== 'errand';
    }
    if (verb === 'mcp-continue') await api.runMcpContinue(slug);
    else if (phase == null) throw new Error('this action needs a phase');
    else if (verb === 'recheck') await api.runRecheck(slug, phase);
    else if (verb === 'closeout') await api.runCloseout(slug, phase);
    else if (verb === 'resume') await api.runResumePhase(slug, phase, opts.instruction ?? '');
    else if (verb === 'retry') await api.runRetry(slug, phase);
    else await api.runSkip(slug, phase);
    toast(CONFIRMATIONS[verb], 'ok');
    return true;
  } catch (error) {
    const running = liveSessionFrom(error);
    if (running) {
      toast('A recovery session already holds this phase — opening it.', 'warn');
      navigate(`agent/${running}`);
      return false;
    }
    toast((error as Error).message, 'error');
    return false;
  }
}

/** The session id a busy-refusal carries, if this was one. */
function liveSessionFrom(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const id = (error.body as { sessionId?: unknown } | null)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
