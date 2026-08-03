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

// From `routes.js` rather than `router.js`: this module is imported by the
// shell before anything is rendered, and the rules do not need the hook.
import { navigate } from './routes.js';

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
export function notify(title, body, tag, url) {
  if (!SUPPORTED || Notification.permission !== 'granted') return false;
  if (pushHandlesIt) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    // The window is in front of you. Telling you what you are looking at is
    // noise, and noise is how a notification channel gets muted.
    return false;
  }
  try {
    const shown = new Notification(title, { body, tag, renotify: false });
    shown.onclick = () => {
      try {
        window.focus();
        // Where it goes was decided by the server's `routeFor`, so this leg
        // cannot drift from the push payload and the inbox row the way three
        // hand-written URLs did.
        if (url) navigate(url);
        shown.close();
      } catch { /* nothing to focus */ }
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Raise one notification from a record the server already decided to announce.
 *
 * There used to be three ways a notification came into being — the page's own
 * reading of run state, the push payload, and the out-of-band notifier — each
 * with its own idea of what was worth saying and its own hand-built URL. This
 * is now the only in-tab one, and it says exactly what the store says, so an
 * event you were told about is the same event you find in the inbox.
 *
 * Restraint still lives on the server: a record exists for everything, but only
 * the categories a person opted into ever reach a device, and this leg is
 * suppressed entirely while the tab is in front of you.
 */
export function announce(record) {
  if (!record?.title) return false;
  return notify(record.title, record.body ?? '', record.id, record.url);
}
