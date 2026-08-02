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
 * `http://127.0.0.1` counts as a secure context, so this works over plain HTTP
 * on localhost, which is the only place this console ever runs.
 */

const SUPPORTED = typeof Notification !== 'undefined';

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
