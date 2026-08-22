/**
 * The unified inbox — what needs a person right now, and what would clear it.
 *
 * Not the NOTIFICATION inbox: `./notifications`'s `InboxPage` / `InboxQuery`
 * are the log of what the console announced. This is the list of what needs a
 * person right now — errands, approvals, gates, sign-ins — each carrying the
 * actions that would clear it. `server/inbox.ts` builds it; `features/now`
 * renders it, on the page and in the bell drawer.
 */

import { request, post, q } from './client';

/** What kind of thing is asking. */
export type InboxKind =
  'errand' | 'approval' | 'gate' | 'sign-in' | 'mcp-auth' | 'qa' | 'lock' | 'health' | 'stall' | 'ruling';

/** How loudly: `urgent` interrupts, `needs-you` waits for a person, `fyi` informs. */
export type InboxSeverity = 'urgent' | 'needs-you' | 'fyi';

/** One thing a person can do about an item, as the server spells it. */
export type InboxAction = {
  verb: string;
  label: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Which console capability gates it (run | agent | writes | …), when one does. */
  flag?: string;
};

export type InboxItem = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  slug?: string;
  phase?: number;
  runId?: string;
  title: string;
  /** What is needed. */
  need: string;
  /** How to give it. */
  how: string;
  /** What was already tried, so nobody tries it again by hand. */
  tried?: string[];
  /** ISO 8601 — since when it has been waiting. */
  since: string;
  actions: InboxAction[];
  /** Where in the console it lives. */
  href: string;
  /** Acknowledged — seen, not cleared. */
  ack?: { at: string; by?: string } | null;
};

export type InboxView = {
  items: InboxItem[];
  generatedAt: string;
};

/** The inbox fetchers — merged into `api` by `./index`. */
export const inboxApi = {
  /** `all` includes acknowledged items; by default only what is still open. */
  inbox: (all?: boolean) => request<InboxView>('/api/inbox' + (all ? '?all=1' : '')),
  inboxAck: (id: string) => post<{ ok: boolean }>('/api/inbox/ack', { id }),
  inboxUnack: (id: string) => request<{ ok: boolean }>(`/api/inbox/ack?id=${q(id)}`, { method: 'DELETE' }),

  /**
   * Perform a remedy exactly as the server spelled it.
   *
   * The endpoint, the method and the body come off the `InboxAction` verbatim.
   * Nothing here maps a verb to a URL: a client that knew which endpoint
   * answers `recover` would be a second copy of a routing table the server
   * already owns, and the first divergence would be a button that 404s. It is
   * also what lets a NEW kind of item ship with working buttons against a
   * console nobody rebuilt.
   *
   * A body is sent only where one can be: a `GET` with a payload is not a
   * request any of these endpoints accepts.
   */
  inboxAct: (action: InboxAction) =>
    request<unknown>(action.endpoint, {
      method: action.method,
      ...(action.body === undefined || action.method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(action.body) }),
    }),
};
