/**
 * The browser's notification permission, and nothing else.
 *
 * *Raising* a notification is the shell's job, off the server's `notification`
 * event — one leg, one wording, one destination — and the push half of it is
 * Phase 7's. What the run view needs is narrower: the approval queue offers to
 * turn notifications on at the one moment the value of them is on screen, which
 * needs the current permission and a way to ask for it.
 *
 * Permission is asked for from a button and never on load. A page that demands
 * it the moment it opens gets refused by reflex, and that refusal is sticky.
 *
 * Notifications need a secure context. `http://127.0.0.1` is one by definition,
 * so this works where the console usually runs; reached over plain HTTP to a
 * hostname, `Notification` is simply not defined and everything here degrades to
 * `unsupported` rather than throwing. On iOS there is one more condition and it
 * is not a browser setting: web notifications exist only for a site added to the
 * Home Screen, and in a Safari tab the permission cannot even be asked for.
 */

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

const supported = (): boolean => typeof Notification !== 'undefined';

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported';
  return Notification.permission as NotifyState;
}

export async function askToNotify(): Promise<NotifyState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as NotifyState;
  try {
    return (await Notification.requestPermission()) as NotifyState;
  } catch {
    return 'denied';
  }
}
