/**
 * The push logic, tested without a browser.
 *
 * This is the path that has never been exercised by any other test in this
 * repo, and it is the one that matters most when it breaks: a notification
 * arrives at 3am with the app closed, and either the Allow button answers the
 * approval or it does not. There is no screen to look at and nothing to retry
 * — a session simply stays parked until morning.
 *
 * It used to be untestable because it lived inside `web/sw.js`, in a global
 * scope no test runner has. `shared/sw-push.js` is the same decisions as plain
 * functions; `client/src/sw.ts` is what is left, which is listeners and awaits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  CONSOLE_HEADERS,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  answeredNotification,
  clickTarget,
  decisionOf,
  decisionRequest,
  notificationOptions,
  notificationTitle,
  parsePayload,
  readRequest,
  resubscribeRequest,
} = await import('../shared/sw-push.js');

const ORIGIN = 'http://127.0.0.1:4123';

/* ---------------- the payload ---------------- */

test('a push with no payload still has something to show', () => {
  // iOS counts a push that shows no notification against the app's standing,
  // so "nothing to show" must not be a reachable state.
  for (const empty of [null, undefined, '', '   ']) {
    const data = parsePayload(empty as string | null);
    assert.deepEqual(data, {});
    assert.equal(notificationTitle(data), 'Phase Console');
    assert.equal(notificationOptions(data).body, 'Something needs you.');
  }
});

test('a malformed payload degrades to the default rather than throwing', () => {
  // A throw here is not an error message — it is a push that shows nothing.
  for (const junk of ['{', 'null', '[1,2]', '"a string"', '42']) {
    assert.deepEqual(parsePayload(junk), {});
  }
});

test('a real payload is carried through to the notification', () => {
  const data = parsePayload(JSON.stringify({
    title: 'Approval needed',
    body: 'Bash(git push:*)',
    tag: 'approval-7',
    url: '/#/plan/cart-api-endpoint/run',
    category: 'approval',
    approvalId: 'a7',
    notificationId: 'n9',
  }));
  assert.equal(notificationTitle(data), 'Approval needed');
  const options = notificationOptions(data);
  assert.equal(options.body, 'Bash(git push:*)');
  assert.equal(options.tag, 'approval-7');
  assert.deepEqual(options.data, {
    url: '/#/plan/cart-api-endpoint/run',
    category: 'approval',
    approvalId: 'a7',
    notificationId: 'n9',
  });
});

test('the same tag replaces rather than stacks, and never re-alerts', () => {
  const options = notificationOptions(parsePayload('{}'));
  assert.equal(options.tag, 'phase-console');
  assert.equal((options as { renotify?: boolean }).renotify, false);
});

test('only an approval gets buttons', () => {
  const withApproval = notificationOptions({ approvalId: 'a1' });
  assert.deepEqual((withApproval as { actions?: unknown }).actions, [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ]);
  // A plain announcement has nothing to answer, so offering a yes and a no
  // would be offering to decide something that does not exist.
  assert.equal((notificationOptions({}) as { actions?: unknown }).actions, undefined);
});

test('the badge is the monochrome mark, not the full-colour icon', () => {
  // Android masks the badge to its alpha channel; a colour icon there is a
  // grey blob, which is how this was wrong before.
  const options = notificationOptions({});
  assert.equal(options.icon, NOTIFICATION_ICON);
  assert.equal(options.badge, NOTIFICATION_BADGE);
  assert.notEqual(NOTIFICATION_BADGE, NOTIFICATION_ICON);
});

/* ---------------- the click ---------------- */

test('only the two action buttons are an answer', () => {
  assert.equal(decisionOf('allow'), 'allow');
  assert.equal(decisionOf('deny'), 'deny');
  // Tapping the body of the notification opens the queue; it does not decide.
  assert.equal(decisionOf(''), null);
  assert.equal(decisionOf(undefined), null);
  assert.equal(decisionOf('Allow'), null);
});

test('a click lands on the URL the payload asked for', () => {
  assert.equal(clickTarget({ url: '/#/ready' }, ORIGIN), `${ORIGIN}/#/ready`);
  assert.equal(clickTarget({}, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget(null, ORIGIN), `${ORIGIN}/`);
});

test('a click can never leave this origin', () => {
  // The one deliberate deviation from web/sw.js. Every real payload is
  // relative, so nothing legitimate changes — but a notification that can open
  // an arbitrary site is a bigger promise than a local console needs to make.
  assert.equal(clickTarget({ url: 'https://example.com/x' }, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget({ url: '//example.com/x' }, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget({ url: 'javascript:alert(1)' }, ORIGIN), `${ORIGIN}/`);
});

/* ---------------- the requests ---------------- */

test('every mutation carries the header the server refuses to work without', () => {
  // Same-origin plus this header is the console's CSRF guard; a request from
  // the worker that omits it is refused, and the refusal looks like the run
  // having ended.
  for (const { init } of [
    decisionRequest('a1', 'allow'),
    readRequest('n1')!,
    resubscribeRequest({ endpoint: 'https://push.example/x' }),
  ]) {
    assert.equal((init.headers as Record<string, string>)['x-phase-console'], '1');
    assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal(init.method, 'POST');
  }
});

test('the decision request names the approval and says where it came from', () => {
  const { url, init } = decisionRequest('a 7/8', 'deny');
  // Encoded: an id is server-generated, but a path built by concatenation is
  // one surprising id away from addressing a different endpoint.
  assert.equal(url, '/api/approvals/a%207%2F8');
  assert.deepEqual(JSON.parse(String(init.body)), { decision: 'deny', by: 'notification' });
});

test('there is nothing to mark read when the payload carried no notification', () => {
  assert.equal(readRequest(null), null);
  assert.equal(readRequest(undefined), null);
  assert.equal(readRequest(''), null);
  assert.deepEqual(JSON.parse(String(readRequest('n1')!.init.body)), { ids: ['n1'] });
});

test('the receipt after an answered approval says which way it went', () => {
  const [allowTitle, allow] = answeredNotification('allow', { approvalId: 'a1', url: '/#/runs' });
  assert.equal(allowTitle, 'Phase Console');
  assert.match(String(allow.body), /Allowed/);
  // Its own tag, so it replaces nothing and is replaced by nothing.
  assert.equal(allow.tag, 'answered-a1');
  assert.deepEqual(allow.data, { url: '/#/runs' });

  const [, deny] = answeredNotification('deny', { approvalId: 'a1' });
  assert.match(String(deny.body), /Denied/);
});

test('a rotated subscription re-registers under a label that says so', () => {
  const { url, init } = resubscribeRequest({ endpoint: 'https://push.example/x' });
  assert.equal(url, '/api/push/subscribe');
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body.subscription, { endpoint: 'https://push.example/x' });
  // The device row is identified by endpoint, but a human reading the device
  // list needs to know this one re-registered itself.
  assert.match(body.label, /re-registered/);
});

test('the console headers are frozen — one object, shared by every request', () => {
  assert.equal(Object.isFrozen(CONSOLE_HEADERS), true);
  // Each request spreads a copy, so a caller cannot mutate the shared one.
  const { init } = decisionRequest('a1', 'allow');
  (init.headers as Record<string, string>)['x-phase-console'] = 'tampered';
  assert.equal(CONSOLE_HEADERS['x-phase-console'], '1');
});
