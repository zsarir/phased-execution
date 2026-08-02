/**
 * Subscribing this browser to push.
 *
 * There are two notification paths in this console and they are not the same
 * thing. `notify.js` raises one from the page — instant, free, and gone the
 * moment the tab is. This one registers a service worker with a push service,
 * so the notification arrives with nothing open at all. That is the difference
 * between "I saw it because I was there" and "I was told".
 *
 * Everything here degrades rather than throws. A browser without push, a
 * refused permission, an iPhone in a Safari tab where the API exists but cannot
 * be used — each is a state to report, not an error to handle.
 */

import { fresh, post } from './api.js';
import { standDownForPush } from './notify.js';

const SUPPORTED = typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator
  && typeof PushManager !== 'undefined'
  && typeof Notification !== 'undefined';

/**
 * On iOS, push exists only for a site added to the Home Screen — in a Safari
 * tab `Notification.requestPermission` cannot even be called usefully. There is
 * no capability check for "installed", so this asks the two questions that
 * together mean it: is this iOS, and is it running standalone.
 */
export function iosNeedsInstall() {
  if (typeof navigator === 'undefined') return false;
  const ios = /iP(hone|ad|od)/.test(navigator.platform ?? '')
    || (/Mac/.test(navigator.platform ?? '') && (navigator.maxTouchPoints ?? 0) > 1);
  if (!ios) return false;
  const standalone = window.navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
  return !standalone;
}

/** Why this browser cannot subscribe, or null if it can. */
export function blocker() {
  if (!SUPPORTED) return 'This browser does not support push notifications.';
  if (iosNeedsInstall()) {
    return 'On iOS, notifications only work once this is added to the Home Screen: Share → Add to Home Screen, '
      + 'then open it from there.';
  }
  if (!window.isSecureContext) {
    return 'Push needs a secure context — https, or localhost. Reach the console over HTTPS and try again.';
  }
  if (Notification.permission === 'denied') {
    return 'Notification permission was refused for this site. It has to be changed in browser settings; '
      + 'the page cannot ask twice.';
  }
  return null;
}

/** What this browser is, in as few words as will still tell two of them apart. */
export function describeBrowser() {
  const ua = navigator.userAgent ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : '';
  return platform ? `${platform} · ${browser}` : browser;
}

async function registration() {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** The endpoint identifies this browser to the server; nothing else does. */
export async function currentEndpoint() {
  if (!SUPPORTED) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the service worker is covering this browser, told to `notify.js` so
 * the page does not raise a second copy of everything the worker will deliver.
 *
 * Called on boot and after either switch is thrown, because "is this device
 * subscribed" is a question with two answers over the life of a tab.
 */
export async function syncSuppression() {
  const active = Boolean(await currentEndpoint());
  standDownForPush(active);
  return active;
}

/**
 * Permission is asked for here and nowhere else, and only from a button.
 * A page that demands it on load gets refused by reflex, and that refusal is
 * permanent — one impatient click and the feature is gone for good.
 */
export async function enable(categories) {
  const why = blocker();
  if (why) return { ok: false, detail: why };

  if (Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') return { ok: false, detail: 'Permission was not granted.' };
  }

  const { publicKey } = await fresh('/api/push');
  if (!publicKey) return { ok: false, detail: 'The console has no signing key for push.' };

  const reg = await registration();
  // `ready` rather than the register() promise: a worker that has registered
  // has not necessarily activated, and subscribing against an inactive one
  // fails in a way that reads like a permissions problem.
  await navigator.serviceWorker.ready;

  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    // Not optional, and not only a policy: a push that shows nothing is what
    // gets an app's push privileges withdrawn.
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  const body = { subscription: subscription.toJSON(), label: describeBrowser() };
  if (categories) body.categories = categories;
  const result = await post('/api/push/subscribe', body);
  if (result?.error) return { ok: false, detail: result.error };
  await syncSuppression();
  return { ok: true, device: result.device, state: result.state };
}

export async function disable() {
  const endpoint = await currentEndpoint();
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch { /* the server row is what matters; a stale local one is harmless */ }
  const result = endpoint ? await post('/api/push/unsubscribe', { endpoint }) : null;
  await syncSuppression();
  return result;
}

export function setCategories(id, categories) {
  return post('/api/push/categories', { id, categories });
}

export function sendTest(id) {
  return post('/api/push/test', { id });
}
