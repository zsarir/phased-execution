/**
 * Minting a recovery session, from wherever it was offered.
 *
 * Four surfaces start one — the dashboard's attention cards, the run page's
 * halt banner, its phase table, and a plan-error row — and all four want
 * exactly the same three things afterwards: the sessions list seeded so the
 * next render is right, the queries invalidated, and the browser on the new
 * session's terminal. Written once, because a fifth caller that forgets the
 * seeding is a card that says "no sessions" a moment after opening one.
 *
 * The interesting case is the refusal. A 409 means the console declined —
 * usually because a recovery for this exact phase is already running — and the
 * useful response to that is not an error toast, it is to go and look at the
 * session that already exists. The server sends its id for precisely this.
 */

import type { QueryClient } from '@tanstack/react-query';
import { ApiError, api, type TerminalState } from './api';
import { keys } from './queries';
import { navigate } from '../router';
import { toast } from '../components/ui';
import type { RecoveryClass } from './recovery';

export type StartRecoveryRequest = {
  recoveryClass: RecoveryClass;
  slug: string;
  phase?: number;
  runId?: string;
  /**
   * The launch dialog's choices. Generic agent-ticket fields the server
   * already validates; default skills the operator ticked ride inside
   * `skills` — the ticket has no attach flag, so the merge is the caller's.
   */
  model?: string;
  effort?: string;
  skills?: string[];
};

/**
 * Open a recovery session and land on it.
 *
 * Resolves either way — the caller has nothing to decide, because every
 * outcome is already either a navigation or a toast. Returns the session id
 * the browser ended up on, or `undefined` when nothing opened.
 */
export async function startRecovery(
  client: QueryClient,
  request: StartRecoveryRequest,
): Promise<string | undefined> {
  try {
    const ticket = await api.agentTicket({ intent: 'recovery', ...request });
    // Seed from the ticket so the sessions card and the nav badge are right on
    // the very next render, then invalidate — the same two rules every other
    // session the console opens follows.
    if (ticket.session) {
      client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) => (prev
        ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session!] }
        : prev));
    }
    void client.invalidateQueries({ queryKey: keys.terminal() });
    navigate(`agent/${ticket.sessionId}`);
    return ticket.sessionId;
  } catch (error) {
    const running = liveSessionFrom(error);
    if (running) {
      // Not a failure from where the operator is standing: what they asked for
      // is already happening, and this is where it is happening.
      toast('A recovery for this is already running — opening it.', 'warn');
      navigate(`agent/${running}`);
      return running;
    }
    toast((error as Error).message, 'error');
    return undefined;
  }
}

/** The session id a duplicate-recovery refusal carries, if this was one. */
function liveSessionFrom(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const id = (error.body as { sessionId?: unknown } | null)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
