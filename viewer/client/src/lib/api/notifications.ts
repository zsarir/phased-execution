/**
 * Notifications — the inbox of records the console has announced, and the push
 * register. (The unified WORK inbox — errands, approvals, gates — is `./inbox`;
 * `InboxPage` / `InboxQuery` here are the notification inbox's own shapes.)
 */

import { request, post, q } from './client';

/* ---------------- the notification inbox ---------------- */

export type DeliveryOutcome = 'sent' | 'throttled' | 'failed' | 'gone';

export interface DeliveryRecord {
  device: string;
  label: string;
  outcome: DeliveryOutcome;
  at: string;
  detail?: string;
}

export interface NotificationRecord {
  id: string;
  at: string;
  category: string;
  title: string;
  body: string;
  /** Built by the server's `routeFor` and never by hand. */
  url: string;
  /** What it is about — the fields a scoped read matches on. */
  slug?: string;
  runId?: string;
  phase?: number;
  sessionId?: string;
  urgent: boolean;
  read: boolean;
  delivery: DeliveryRecord[];
  /** Its subject dissolved on its own (the board moved past the halt). */
  resolved?: { at: string; reason: string };
}

/**
 * Which records a scoped read marks. Every field given must match, and an
 * empty scope matches **nothing** — a page whose slug has not resolved yet must
 * not clear the whole inbox.
 */
export interface NotificationScope {
  slug?: string;
  category?: string;
  runId?: string;
  sessionId?: string;
  phase?: number;
}

export interface ReadResult {
  changed: number;
  unread: number;
}

export interface NotificationCategory {
  id: string;
  label: string;
  detail: string;
  byDefault: boolean;
  urgent: boolean;
}

export interface InboxPage {
  items: NotificationRecord[];
  total: number;
  unread: number;
  /** `items` was cut short — so "Show older" can be offered honestly. */
  more: boolean;
  categories: NotificationCategory[];
  /** How many devices are subscribed. A count, not the register. */
  devices: number;
  outOfBand: { configured: boolean };
}

export interface InboxQuery {
  category?: string;
  unread?: boolean;
  limit?: number;
  before?: string;
}

/* ---------------- push ----------------
 * The endpoint and keys never leave the server; `service` is the endpoint's
 * origin, which is the only thing a browser can match its own subscription
 * against. */

export interface PushDevice {
  id: string;
  label: string;
  service: string;
  categories: Record<string, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
}

export interface PushState {
  publicKey: string;
  devices: PushDevice[];
  categories: NotificationCategory[];
}

/** The notification and push fetchers — merged into `api` by `./index`. */
export const notificationsApi = {
  /* ---- the notification inbox ---- */
  notifications: (query: InboxQuery = {}) =>
    request<InboxPage>(
      `/api/notifications?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v != null && v !== '' && v !== false)
          .map(([k, v]) => [k, v === true ? '1' : String(v)]),
      )}`,
    ),
  markNotificationsRead: (ids?: string[]) =>
    post<ReadResult>('/api/notifications/read', ids?.length ? { ids } : {}),
  // Scoped: only the records that are *about* this thing. An empty scope
  // matches nothing on the server, so a slug that has not resolved yet cannot
  // clear the inbox by accident.
  markNotificationsReadFor: (scope: NotificationScope) => post<ReadResult>('/api/notifications/read', scope),
  clearNotifications: (what: string | { id: string }) =>
    request<unknown>(
      `/api/notifications?${typeof what === 'string' ? `scope=${what}` : `id=${q(what.id)}`}`,
      { method: 'DELETE' },
    ),

  /* ---- push: the register, not the browser half ----
     Subscribing is `lib/push.ts` — it needs a service worker and a permission
     prompt, neither of which belongs in a fetch helper. */
  push: () => request<PushState>('/api/push'),
  pushSubscribe: (body: { subscription: unknown; label: string; categories?: Record<string, boolean> }) =>
    post<{ device?: PushDevice; state?: PushState; error?: string }>('/api/push/subscribe', body),
  pushUnsubscribe: (endpoint: string) =>
    post<{ removed?: unknown; state?: PushState }>('/api/push/unsubscribe', { endpoint }),
  pushCategories: (id: string, categories: Record<string, boolean>) =>
    post<{ device?: PushDevice }>('/api/push/categories', { id, categories }),
  pushTest: (id: string) => post<{ ok: boolean; detail: string }>('/api/push/test', { id }),
};
