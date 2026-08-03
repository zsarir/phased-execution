/**
 * The decisions a service worker makes, lifted out of the service worker.
 *
 * `client/src/sw.ts` runs in a worker: no DOM, no test runner, and no way to
 * import it from `node --test` without faking half a browser. But almost
 * nothing in it is actually about being a worker — it is "which title does this
 * payload get", "does this click mean allow", "where does that URL point". Those
 * are ordinary functions over ordinary values, and this is where they live so
 * they can be tested as such (`test/sw-push.test.ts`).
 *
 * What stays in the worker is the part that genuinely needs one: registering
 * listeners, awaiting `showNotification`, matching clients, and the fetch. Those
 * are four lines each and they read as plumbing, which is what they are.
 *
 * Ported from `web/sw.js`. The behaviour is the same one the two live push
 * subscriptions already rely on, with a single deliberate change, marked below.
 *
 * Plain `.js` + JSDoc on purpose — the same file `node --test` imports directly
 * and Vite bundles into the worker, with no build step between them.
 */

/** Same header the app sends: the server refuses a mutation without it. */
export const CONSOLE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'x-phase-console': '1',
});

/** The icon on the notification itself. */
export const NOTIFICATION_ICON = '/icons/icon-192.png';

/**
 * The small monochrome mark Android puts in the status bar. It is drawn as a
 * mask — only the alpha channel survives — so a full-colour icon there arrives
 * as a grey blob. `icon-badge-96.png` is the mark in flat white for exactly this.
 */
export const NOTIFICATION_BADGE = '/icons/icon-badge-96.png';

/**
 * @typedef {object} PushPayload
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [tag]
 * @property {string} [url]
 * @property {string|null} [category]
 * @property {string|null} [approvalId]
 * @property {string|null} [notificationId]
 */

/**
 * A push service is allowed to deliver an empty payload, and a malformed one is
 * indistinguishable from that at this end. Both become `{}` rather than an
 * exception, because on iOS a push that shows *no* notification counts against
 * the app's standing — there always has to be something to show.
 *
 * @param {string|null|undefined} text the raw body, or nothing
 * @returns {PushPayload}
 */
export function parsePayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {PushPayload} data
 * @returns {string}
 */
export function notificationTitle(data) {
  return data.title || 'Phase Console';
}

/**
 * @param {PushPayload} data
 * @returns {NotificationOptions}
 */
export function notificationOptions(data) {
  return {
    body: data.body || 'Something needs you.',
    // Same tag replaces rather than stacks: a run that re-renders three times
    // is one line on a lock screen, not three.
    tag: data.tag || 'phase-console',
    renotify: false,
    data: {
      url: data.url || '/',
      category: data.category || null,
      approvalId: data.approvalId || null,
      notificationId: data.notificationId || null,
    },
    // Answering from the lock screen, without unlocking and finding the queue.
    // A card is the only thing here with a yes and a no, so it is the only
    // thing that gets buttons. (Android and desktop honour these; iOS ignores
    // the array and shows the notification, which is the correct degradation.)
    actions: data.approvalId
      ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }]
      : undefined,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
  };
}

/**
 * Which button was pressed, as a decision. Anything that is not one of the two
 * action buttons — including the body of the notification — is not an answer.
 *
 * @param {string|undefined} action
 * @returns {'allow'|'deny'|null}
 */
export function decisionOf(action) {
  if (action === 'allow') return 'allow';
  if (action === 'deny') return 'deny';
  return null;
}

/**
 * Where a click should land.
 *
 * ⚠️ The one deliberate deviation from `web/sw.js`: the result is clamped to
 * this origin. Every URL in a real payload is already relative (`/#/plan/…`),
 * written by the console's own `routeFor`, so nothing legitimate changes — but
 * `new URL(absolute, origin)` would happily resolve to somewhere else, and a
 * notification that can open an arbitrary site is a bigger promise than this
 * needs to make.
 *
 * @param {{url?: string}|null|undefined} info the notification's `data`
 * @param {string} origin
 * @returns {string} an absolute URL on `origin`
 */
export function clickTarget(info, origin) {
  const base = new URL(origin);
  let target;
  try {
    target = new URL(info?.url || '/', base);
  } catch {
    return new URL('/', base).href;
  }
  if (target.origin !== base.origin) return new URL('/', base).href;
  return target.href;
}

/**
 * Marking a notification read happens on *click*, not on arrival: one you never
 * saw must still be waiting in the inbox when you do look.
 *
 * @param {string|null|undefined} notificationId
 * @returns {{url: string, init: RequestInit}|null} null when there is nothing to mark
 */
export function readRequest(notificationId) {
  if (!notificationId) return null;
  return {
    url: '/api/notifications/read',
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ ids: [notificationId] }),
    },
  };
}

/**
 * Answering an approval from the lock screen — the round trip that is the
 * whole product.
 *
 * @param {string} approvalId
 * @param {'allow'|'deny'} decision
 * @returns {{url: string, init: RequestInit}}
 */
export function decisionRequest(approvalId, decision) {
  return {
    url: `/api/approvals/${encodeURIComponent(approvalId)}`,
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ decision, by: 'notification' }),
    },
  };
}

/**
 * The receipt shown when a decision landed. Opening a window on top of that
 * would be the console interrupting you a second time for something you have
 * already finished with.
 *
 * @param {'allow'|'deny'} decision
 * @param {{url?: string, approvalId?: string|null}} info
 * @returns {[string, NotificationOptions]} arguments for `showNotification`
 */
export function answeredNotification(decision, info) {
  return ['Phase Console', {
    body: decision === 'allow'
      ? 'Allowed. The session is carrying on.'
      : 'Denied. The session was told.',
    tag: `answered-${info.approvalId}`,
    data: { url: info.url },
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
  }];
}

/**
 * Re-registering after the push service rotates a subscription. A rotated
 * subscription nobody re-registers is a device that has silently stopped being
 * notified, and the browser says so exactly once.
 *
 * @param {object} subscription the result of `subscription.toJSON()`
 * @param {string} [label]
 * @returns {{url: string, init: RequestInit}}
 */
export function resubscribeRequest(subscription, label = 'a browser (re-registered)') {
  return {
    url: '/api/push/subscribe',
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ subscription, label }),
    },
  };
}
