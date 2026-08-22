/**
 * Minting a session, from the one place that mints them.
 *
 * There were two of these — `start-qa.ts` and `start-recovery.ts` — written
 * apart and then, comment by comment, into the same four steps: build the
 * ticket, seed the sessions list so the next render is right, invalidate, and
 * land the browser on the new session. They already carried each other's
 * lessons as prose ("written once, for the same reason `start-recovery.ts`
 * is"). Phase 6 made them one function, because RunSetup is now the only
 * caller of either and two copies of a rule is one copy too many.
 *
 * The interesting case is the refusal, and it is identical for both. A 409
 * means the console declined — a review is already running for this phase, a
 * recovery already holds it — and the useful response is not an error toast
 * but to go and look at the session that already exists. The server sends its
 * id for exactly that.
 */

import type { QueryClient } from '@tanstack/react-query';
import { ApiError, api, type TerminalState } from './api';
import { isPhone } from './media';
import { keys } from './queries';
import { estimateTerminalSize } from './terminal';
import { navigate } from '@/app/router';
import { toast } from '../components/ui';

/** What a duplicate refusal reads as, per intent — the same fact, the right words. */
const ALREADY_RUNNING: Record<string, string> = {
  qa: 'A session for this phase is already running — opening it.',
  recovery: 'A recovery for this is already running — opening it.',
};

/**
 * Open a session and land on it.
 *
 * Resolves either way — the caller has nothing to decide, because every
 * outcome is already either a navigation or a toast. Returns the session id
 * the browser ended up on, or `undefined` when nothing opened.
 *
 * `body` is the agent ticket as `features/run-setup/modes.ts` built it; the
 * only thing added here is a size for the pty to be born at, which is a
 * property of the viewport rather than of the launch.
 */
export async function startSession(
  client: QueryClient,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  const intent = String(body.intent ?? '');
  try {
    const ticket = await api.agentTicket({
      ...estimateTerminalSize(isPhone()),
      ...body,
    } as never);
    // Seed from the ticket so the sessions card and the nav badge are right on
    // the very next render, then invalidate — the two rules every session this
    // console opens follows.
    if (ticket.session) {
      client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
        prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session!] } : prev,
      );
    }
    void client.invalidateQueries({ queryKey: keys.terminal() });
    // Activation writes `test-status.md`, so the board and this plan's detail
    // are both stale the moment it succeeds.
    if (body.activate && typeof body.slug === 'string') {
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.plan(body.slug) });
    }
    navigate(`agent/${ticket.sessionId}`);
    return ticket.sessionId;
  } catch (error) {
    const running = liveSessionFrom(error);
    if (running) {
      // Not a failure from where the operator is standing: what they asked for
      // is already happening, and this is where it is happening.
      toast(ALREADY_RUNNING[intent] ?? 'A session for this is already running — opening it.', 'warn');
      navigate(`agent/${running}`);
      return running;
    }
    toast((error as Error).message, 'error');
    return undefined;
  }
}

/** The session id a duplicate refusal carries, if this was one. */
function liveSessionFrom(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const id = (error.body as { sessionId?: unknown } | null)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
