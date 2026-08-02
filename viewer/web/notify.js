/**
 * Telling the operator that a run needs them.
 *
 * The point of a supervised run is that you stop watching it. That only works
 * if it can reach you, and until now it could not: the approval queue was
 * perfect and entirely silent, so "answer it from your phone at 11pm" meant
 * "keep the tab in front of you at 11pm".
 *
 * Permission is asked for from a button and never on load. A page that demands
 * notification permission the moment it opens gets refused by reflex, and that
 * refusal is sticky — one impatient click and the feature is off for good.
 *
 * Notifications need a secure context. `http://127.0.0.1` is one by definition,
 * so this works over plain HTTP where the console usually runs. Reached through
 * a proxy (`--remote`), the context is only secure if that proxy terminates
 * TLS — over plain HTTP to a hostname, `Notification` is simply not defined and
 * everything here degrades to `unsupported` rather than failing.
 *
 * On iOS there is one more condition, and it is not a browser setting: web
 * notifications exist only for a site added to the Home Screen. In a Safari tab
 * the permission cannot even be asked for. That is what the manifest and the
 * apple-mobile-web-app tags in index.html are for.
 */

const SUPPORTED = typeof Notification !== 'undefined';

/**
 * A browser subscribed to push already gets these from its service worker. If
 * the page raised one as well, every event would arrive twice on exactly the
 * device that took the trouble to set push up — so the page stands down and
 * lets the worker have it.
 */
let pushHandlesIt = false;

export function standDownForPush(active) {
  pushHandlesIt = Boolean(active);
}

/** Not asked, asked-and-granted, asked-and-refused, or unavailable here. */
export function notifyState() {
  if (!SUPPORTED) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

export async function askToNotify() {
  if (!SUPPORTED) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

/**
 * Raise one notification.
 *
 * `tag` collapses repeats: a run that halts and then re-renders three times
 * should be one line on the lock screen, not three. Anything that throws is
 * swallowed — a notification failing must never break the page that raised it.
 */
export function notify(title, body, tag) {
  if (!SUPPORTED || Notification.permission !== 'granted') return false;
  if (pushHandlesIt) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    // The window is in front of you. Telling you what you are looking at is
    // noise, and noise is how a notification channel gets muted.
    return false;
  }
  try {
    const shown = new Notification(title, { body, tag, renotify: false });
    shown.onclick = () => { try { window.focus(); shown.close(); } catch { /* nothing to focus */ } };
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce the states where nothing further happens until a person acts.
 *
 * Deliberately only these. A notification per phase would train the habit of
 * ignoring them, which costs exactly the halt that mattered.
 */
export function announceRun(run) {
  if (!run) return;
  if (run.status === 'halted' || run.status === 'parked') {
    notify(`${run.slug} ${run.status}`, run.halt?.reason ?? 'the run stopped and needs you', `run-${run.id}-${run.status}`);
  } else if (run.status === 'finished') {
    notify(`${run.slug} finished`, `$${(run.spentUsd ?? 0).toFixed(2)} spent`, `run-${run.id}-finished`);
  }
}

export function announceApproval(approval) {
  if (!approval || approval.status !== 'pending') return;
  notify(
    approval.kind === 'verify' ? 'A check only you can make' : 'Waiting on you',
    `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''} — ${approval.title}`,
    `approval-${approval.id}`,
  );
}
