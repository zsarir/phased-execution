/**
 * The unified inbox — `GET /api/inbox` lands in Phase 4 (server A); these are
 * the agreed shapes so the client can be built against them. Nothing calls
 * them yet.
 *
 * Not the NOTIFICATION inbox: `./notifications`'s `InboxPage` / `InboxQuery`
 * are the log of what the console announced. This is the list of what needs a
 * person right now — errands, approvals, gates, sign-ins — each carrying the
 * actions that would clear it.
 */

import { request, post, q } from './client';

/** What kind of thing is asking. */
export type InboxKind =
  | 'errand' | 'approval' | 'gate' | 'sign-in' | 'mcp-auth'
  | 'qa' | 'lock' | 'health' | 'stall' | 'ruling';

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

/** The inbox fetchers — merged into `api` by `./index`. Nothing calls them yet. */
export const inboxApi = {
  /** `all` includes acknowledged items; by default only what is still open. */
  inbox: (all?: boolean) => request<InboxView>('/api/inbox' + (all ? '?all=1' : '')),
  inboxAck: (id: string) => post<{ ok: boolean }>('/api/inbox/ack', { id }),
  inboxUnack: (id: string) => request<{ ok: boolean }>(`/api/inbox/ack?id=${q(id)}`, { method: 'DELETE' }),
};
