/**
 * "You turned it off" — a fact only this tab knows.
 *
 * Every other way the stream dies looks identical from the browser: the server
 * restarting, the laptop sleeping, wifi dropping, a crash. The shell's answer to
 * all of them is "Reconnecting…", which is right, because in all of them
 * something *is* coming back.
 *
 * A shutdown is the one case where nothing is. The page cannot infer that — the
 * evidence is a socket that stopped, exactly like the others — so the one moment
 * it can be known is recorded here: the moment the button's own request came
 * back 200. Without this the off switch's success is indistinguishable from a
 * network blip, and the operator waits for a console that is never returning.
 *
 * Module state rather than a query, because it is not about the server: it is
 * about what this tab did, and it must survive the server becoming unreachable
 * one tick later.
 */

import { useSyncExternalStore } from 'react';

export type Stopped = {
  /** How to start it again — from `/api/shutdown`'s `restartHint`. */
  hint: string;
  /** `launchctl` unloaded the job; `exit` just ended the process. */
  via: 'launchctl' | 'exit';
};

let stopped: Stopped | null = null;
const listeners = new Set<() => void>();

export function markConsoleStopped(state: Stopped): void {
  stopped = state;
  for (const notify of listeners) notify();
}

export function getConsoleStopped(): Stopped | null {
  return stopped;
}

export function useConsoleStopped(): Stopped | null {
  return useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => stopped,
    () => null,
  );
}

/** Test seam — a module-level flag would otherwise leak between cases. */
export function __resetShutdownForTests(): void {
  stopped = null;
  listeners.clear();
}
