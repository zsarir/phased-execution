/**
 * Minting a QA session, from wherever it was offered.
 *
 * Three surfaces start one — the phase panel, the run page's phase table and a
 * Ready row whose QA failed before — and all three want the same three things
 * afterwards: the sessions list seeded so the next render is right, the queries
 * invalidated, and the browser on the new session's terminal. Written once, for
 * the same reason `start-recovery.ts` is: a fourth caller that forgets the
 * seeding is a page that says "no sessions" a moment after opening one.
 *
 * The interesting case is again the refusal. A 409 means the console declined —
 * a review is already running for this phase, or a live session is still
 * building it — and the useful response to the first is not an error toast but
 * to go and look at the session that already exists. The server sends its id
 * for exactly that.
 */

import type { QueryClient } from '@tanstack/react-query';
import { ApiError, api, type TerminalState } from './api';
import { isPhone } from './media';
import { keys } from './queries';
import { estimateTerminalSize } from './terminal';
import { navigate } from '../router';
import { toast } from '../components/ui';
import type { QaProfile } from './qa';

export type StartQaRequest = {
  slug: string;
  phase: number;
  /** Turn QA on for this plan first — offered only when its qa-mode is `off`. */
  activate?: boolean;
  model?: string;
  effort?: string;
  permissionProfile?: QaProfile;
  skills?: string[];
  /** Which account the session runs as — a registered id, validated server-side. */
  accountId?: string;
};

/**
 * Open a QA session and land on it.
 *
 * Resolves either way — the caller has nothing to decide, because every outcome
 * is already either a navigation or a toast. Returns the session id the browser
 * ended up on, or `undefined` when nothing opened.
 */
export async function startQa(
  client: QueryClient,
  request: StartQaRequest,
): Promise<string | undefined> {
  const { model, effort, ...rest } = request;
  try {
    const ticket = await api.agentTicket({
      intent: 'qa',
      // A size for the pty to be born at — the pane refits on open.
      ...estimateTerminalSize(isPhone()),
      ...rest,
      // `''` from a select means "this machine's default", which is an omission
      // rather than a value the server should validate.
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    if (ticket.session) {
      client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) => (prev
        ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session!] }
        : prev));
    }
    void client.invalidateQueries({ queryKey: keys.terminal() });
    // Activation writes test-status.md, so the board and this plan's detail are
    // both stale the moment it succeeds.
    if (request.activate) {
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.plan(request.slug) });
    }
    navigate(`agent/${ticket.sessionId}`);
    return ticket.sessionId;
  } catch (error) {
    const running = liveSessionFrom(error);
    if (running) {
      toast('A session for this phase is already running — opening it.', 'warn');
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
