/**
 * One connection, many listeners.
 *
 * Every view that wanted live data used to open its own `EventSource`. A browser
 * allows about six connections per host over HTTP/1.1, and the shell, the
 * dashboard, the runs page and a plan's autopilot tab together held most of them
 * open forever — so the *fetches* those same views depend on queued behind
 * connections that never finish. The symptom is precise and misleading: the page
 * looks alive, and nothing updates until you reload.
 *
 * So there is exactly one stream and it is shared, it is opened once and never
 * closed, and **reconnection is the browser's own**. An `EventSource` retries on
 * its own schedule and resends `Last-Event-ID`; the server replays from there
 * (`server/api/routes.ts`). A hand-rolled retry loop on top of that is not extra
 * safety, it is a second reconnect racing the first.
 */

import { useSyncExternalStore } from 'react';

/**
 * Every event name the server emits, as it appears on the wire.
 *
 * Run events are `run:`-prefixed by the runner itself
 * (`server/runner/runner.ts` → `onEvent('run:' + event, …)`), which is why the
 * client listens for `run:phase` and not `phase`. `run:state` is the one the
 * *service* emits directly, when a stop/skip/retry/pause lands on a run no loop
 * is driving. `hello` is the un-replayed handshake frame and is not in this list
 * — nothing invalidates on it.
 */
export const SSE_EVENTS = [
  'changed',
  'warm',
  'health',
  'approval',
  'approval:resolved',
  'notification',
  'notification:delivery',
  'notification:read',
  'notification:cleared',
  'run:run',
  'run:phase',
  'run:stream',
  'run:journal',
  'run:verify',
  'run:state',
] as const;

export type SseEvent = (typeof SSE_EVENTS)[number];
export type SseStatus = 'connecting' | 'live' | 'offline';
export type SseListener = (data: unknown, name: SseEvent) => void;

const listeners = new Map<string, Set<SseListener>>();
const statusListeners = new Set<() => void>();

let source: EventSource | null = null;
let status: SseStatus = 'connecting';
/** Bumped on every status change so `useSyncExternalStore` sees a new snapshot. */
let statusVersion = 0;

function setStatus(next: SseStatus): void {
  if (status === next) return;
  status = next;
  statusVersion++;
  for (const notify of statusListeners) notify();
}

function fanOut(name: SseEvent, data: unknown): void {
  for (const fn of listeners.get(name) ?? []) {
    // One bad listener must not stop the rest, and must not take the stream
    // down with it — this callback is on the socket's own path.
    try { fn(data, name); } catch { /* ignore */ }
  }
}

/** Open the shared stream. Idempotent; safe to call from any subscriber. */
export function connect(): void {
  if (source || typeof EventSource === 'undefined') return;
  const stream = new EventSource('/events');
  source = stream;

  stream.onopen = () => setStatus('live');
  stream.onerror = () => {
    // `CLOSED` means the browser has given up (the server said something final).
    // Anything else is its own retry in flight — the honest word for that is
    // "connecting", not "error", and there is nothing for us to do about it.
    setStatus(stream.readyState === stream.CLOSED ? 'offline' : 'connecting');
  };

  for (const name of SSE_EVENTS) {
    stream.addEventListener(name, (event) => {
      let data: unknown = null;
      try { data = JSON.parse((event as MessageEvent).data); } catch { /* keep null */ }
      // Any named frame arriving proves the pipe is up, even if `onopen` was
      // missed across a background tab throttle.
      setStatus('live');
      fanOut(name, data);
    });
  }
}

/** Subscribe to one event name. Returns the unsubscribe. */
export function onSse(name: SseEvent, fn: SseListener): () => void {
  connect();
  let set = listeners.get(name);
  if (!set) { set = new Set(); listeners.set(name, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    // The stream stays open with no listeners: closing and reopening it as
    // views mount costs a reconnect each time and buys nothing.
  };
}

/** Subscribe to several at once. */
export function onSseAll(names: readonly SseEvent[], fn: SseListener): () => void {
  const offs = names.map((name) => onSse(name, fn));
  return () => { for (const off of offs) off(); };
}

export function getSseStatus(): SseStatus {
  return status;
}

/** The shell's "reconnecting" slot reads this. */
export function useSseStatus(): SseStatus {
  return useSyncExternalStore(
    (notify) => {
      connect();
      statusListeners.add(notify);
      return () => { statusListeners.delete(notify); };
    },
    () => status,
    () => 'connecting' as const,
  );
}

/** Test seam only — drops the singleton so a case can start from nothing. */
export function __resetStreamForTests(): void {
  source?.close();
  source = null;
  listeners.clear();
  statusListeners.clear();
  status = 'connecting';
  statusVersion = 0;
}
