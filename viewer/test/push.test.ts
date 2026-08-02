/**
 * Web push: the crypto, the delivery, and the register.
 *
 * The encryption is the part worth testing hardest, because every way of
 * getting it wrong looks identical from here — a push service accepts the
 * message, returns 201, and the browser silently discards it. There is no error
 * to observe. So the test decrypts what was produced, using an independent
 * implementation of the browser's half rather than the sender's own helpers: if
 * both sides shared a mistake, a round-trip through shared code would still
 * pass.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, randomBytes,
} from 'node:crypto';

// STATE_DIR is resolved when config.ts is first imported, so the redirect has to
// happen before anything pulls it in — otherwise this writes a VAPID key and a
// subscription register into the real state directory.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'phase-push-'));

let push: typeof import('../server/push/index.ts');
let send: typeof import('../server/push/send.ts');
let vapidMod: typeof import('../server/push/vapid.ts');
let catalogue: typeof import('../server/push/catalogue.ts');

before(async () => {
  push = await import('../server/push/index.ts');
  send = await import('../server/push/send.ts');
  vapidMod = await import('../server/push/vapid.ts');
  catalogue = await import('../server/push/catalogue.ts');
});

/* ------------------------------------------------------------------ *
 * A browser, for the crypto to talk to
 * ------------------------------------------------------------------ */

function makeBrowser() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]);
  const auth = randomBytes(16);
  return {
    privateKey: keys.privateKey,
    p256dh,
    auth,
    subscription: {
      endpoint: 'https://push.example.com/sub/abc123',
      keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') },
    },
    /** RFC 8188 §2 in reverse, written out here rather than shared with the sender. */
    decrypt(record: Buffer): string {
      const salt = record.subarray(0, 16);
      const idLength = record[20];
      const senderPublic = record.subarray(21, 21 + idLength);
      const sealed = record.subarray(21 + idLength);

      const shared = diffieHellman({
        privateKey: keys.privateKey,
        publicKey: createPublicKey({
          key: {
            kty: 'EC', crv: 'P-256',
            x: senderPublic.subarray(1, 33).toString('base64url'),
            y: senderPublic.subarray(33, 65).toString('base64url'),
          },
          format: 'jwk',
        }),
      });
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth,
        Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, senderPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      assert.equal(plain[plain.length - 1], 2, 'last record should be delimited with 0x02');
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Encryption
 * ------------------------------------------------------------------ */

test('a message decrypts to exactly what was sent', () => {
  const browser = makeBrowser();
  const payload = Buffer.from(JSON.stringify({ title: 'a', body: 'b' }));
  assert.equal(browser.decrypt(send.encrypt(browser.subscription, payload)), payload.toString());
});

test('the record is laid out as RFC 8188 says', () => {
  const browser = makeBrowser();
  const payload = Buffer.from('hello');
  const record = send.encrypt(browser.subscription, payload);
  assert.equal(record.subarray(16, 20).readUInt32BE(), 4096, 'record size');
  assert.equal(record[20], 65, 'key id length is a P-256 point');
  assert.equal(record[21], 4, 'the point is uncompressed');
  // salt + rs + idlen + key + (payload + delimiter + GCM tag)
  assert.equal(record.length, 16 + 4 + 1 + 65 + payload.length + 1 + 16);
});

test('the same message twice is never the same bytes twice', () => {
  const browser = makeBrowser();
  const payload = Buffer.from('same');
  const a = send.encrypt(browser.subscription, payload);
  const b = send.encrypt(browser.subscription, payload);
  assert.notEqual(a.toString('base64'), b.toString('base64'), 'the ephemeral key must be per message');
  assert.equal(browser.decrypt(a), 'same');
  assert.equal(browser.decrypt(b), 'same');
});

test('keys of the wrong size are refused rather than producing junk', () => {
  const browser = makeBrowser();
  assert.throws(() => send.encrypt(
    { ...browser.subscription, keys: { ...browser.subscription.keys, p256dh: 'AAAA' } },
    Buffer.from('x'),
  ), /65-byte point/);
  assert.throws(() => send.encrypt(
    { ...browser.subscription, keys: { ...browser.subscription.keys, auth: 'AAAA' } },
    Buffer.from('x'),
  ), /16 bytes/);
});

/* ------------------------------------------------------------------ *
 * VAPID
 * ------------------------------------------------------------------ */

test('the Authorization header is a well-formed ES256 JWT for the endpoint origin', () => {
  vapidMod.resetTokenCache();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const header = vapidMod.authorization(vapid, 'https://push.example.com/sub/abc?q=1');

  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  assert.ok(token && key, `unparseable header: ${header}`);
  assert.equal(key, vapid.publicKey);

  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString());
  // The audience is the origin, not the endpoint — a service rejects the latter.
  assert.equal(parsed.aud, 'https://push.example.com');
  assert.equal(parsed.sub, 'mailto:you@example.com');
  assert.ok(parsed.exp > Math.floor(Date.now() / 1000));
  // Raw r‖s. DER would be ~70 bytes and rejected as malformed.
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
});

test('one token per push service, reused', () => {
  vapidMod.resetTokenCache();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const a = vapidMod.authorization(vapid, 'https://push.example.com/one');
  const b = vapidMod.authorization(vapid, 'https://push.example.com/two');
  const other = vapidMod.authorization(vapid, 'https://other.example.org/one');
  assert.equal(a, b, 'same service, same token');
  assert.notEqual(a, other, 'different service, different audience');
});

test('the keypair survives a reload — regenerating would silently break every subscription', () => {
  const first = vapidMod.loadVapid('mailto:you@example.com');
  const second = vapidMod.loadVapid('mailto:you@example.com');
  assert.equal(first.publicKey, second.publicKey);
});

test('the VAPID subject prefers a real address over a placeholder', () => {
  assert.equal(vapidMod.vapidSubject(['you@example.com']), 'mailto:you@example.com');
  assert.equal(vapidMod.vapidSubject(['not-an-address']), 'mailto:phase-console@localhost');
  assert.equal(vapidMod.vapidSubject([]), 'mailto:phase-console@localhost');
});

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

function stubFetch(status: number, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status >= 400 ? 'nope' : null, { status, headers });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

test('a delivery carries the headers a push service requires', async () => {
  const browser = makeBrowser();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const { calls, impl } = stubFetch(201);

  const result = await send.deliver(vapid, browser.subscription, {
    title: 'Permission needed', body: 'demo phase 3', tag: 'abc123', url: '/#/runs', category: 'approval',
  }, { fetchImpl: impl, urgent: true });

  assert.deepEqual(result, { kind: 'sent', status: 201 });
  const [call] = calls;
  const headers = call.init.headers as Record<string, string>;
  assert.equal(call.url, browser.subscription.endpoint);
  assert.equal(call.init.method, 'POST');
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers.urgency, 'high');
  assert.equal(headers.topic, send.topicFor('abc123'));
  assert.match(headers.authorization, /^vapid t=/);
  assert.ok(Number(headers.ttl) > 0);

  // And the body really is the message, not a hopeful blob.
  const decoded = JSON.parse(browser.decrypt(Buffer.from(call.init.body as Uint8Array)));
  assert.equal(decoded.title, 'Permission needed');
  assert.equal(decoded.category, 'approval');
});

test('every topic is one a push service will accept', () => {
  // Apple answers `BadWebPushTopic` to anything that is not a decodable
  // base64url string of at most 32 characters — measured, not read. A length of
  // `n % 4 === 1` is the case that catches people, because it looks fine.
  const tags = ['phase', 'push-test', 'run/slug:1 with spaces!', '', 'x'.repeat(500), 'a1b2c3d4e5f60718'];
  for (const tag of tags) {
    const topic = send.topicFor(tag);
    assert.match(topic, /^[A-Za-z0-9_-]+$/, `${tag} produced non-base64url`);
    assert.ok(topic.length <= 32, `${tag} produced ${topic.length} chars`);
    assert.notEqual(topic.length % 4, 1, `${tag} produced an undecodable length`);
  }
});

test('the same tag always collapses to the same topic', () => {
  // The header exists to replace rather than queue. That only works if the tag
  // maps to one topic, every time.
  assert.equal(send.topicFor('run:abc:halted'), send.topicFor('run:abc:halted'));
  assert.notEqual(send.topicFor('run:abc:halted'), send.topicFor('run:abc:parked'));
});

test('the topic on the wire is the hashed one', async () => {
  const browser = makeBrowser();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const { calls, impl } = stubFetch(201);
  await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'push-test', url: '/', category: 'phase',
  }, { fetchImpl: impl });
  assert.equal((calls[0].init.headers as Record<string, string>).topic, send.topicFor('push-test'));
});

test('an over-long body is trimmed rather than rejected by the service', async () => {
  const browser = makeBrowser();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const { calls, impl } = stubFetch(201);
  await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'x'.repeat(5000), url: '/', tag: 'a', category: 'phase',
  }, { fetchImpl: impl });
  const decoded = JSON.parse(browser.decrypt(Buffer.from(calls[0].init.body as Uint8Array)));
  assert.ok(decoded.body.length <= 400, `body was ${decoded.body.length}`);
  assert.ok(decoded.body.endsWith('…'));
});

test('each status becomes the decision it implies', async () => {
  const browser = makeBrowser();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const cases: [number, string][] = [[201, 'sent'], [404, 'gone'], [410, 'gone'], [429, 'throttled'], [500, 'failed']];
  for (const [status, kind] of cases) {
    const { impl } = stubFetch(status, status === 429 ? { 'retry-after': '120' } : {});
    const result = await send.deliver(vapid, browser.subscription, {
      title: 't', body: 'b', tag: 'a', url: '/', category: 'phase',
    }, { fetchImpl: impl });
    assert.equal(result.kind, kind, `${status} should be ${kind}`);
    if (result.kind === 'throttled') assert.equal(result.retryAfter, 120);
  }
});

test('a network that is simply down is a failure, not a dead subscription', async () => {
  const browser = makeBrowser();
  const vapid = vapidMod.loadVapid('mailto:you@example.com');
  const impl = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
  const result = await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'a', url: '/', category: 'phase',
  }, { fetchImpl: impl });
  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.status, 0);
});

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

test('the noisy categories are off and the blocking ones are on', () => {
  const defaults = catalogue.defaultCategories();
  assert.equal(defaults.approval, true);
  assert.equal(defaults.halted, true);
  assert.equal(defaults.phase, true);
  assert.equal(defaults.finished, true);
  assert.equal(defaults.changed, false, 'a file-level firehose must be opt-in');
  assert.equal(defaults.ready, false);
});

test('only what blocks a run is marked urgent', () => {
  const urgent = catalogue.CATEGORIES.filter((c) => c.urgent).map((c) => c.id);
  assert.deepEqual(urgent.sort(), ['approval', 'halted']);
});

test('unknown categories are dropped and missing ones take their default', () => {
  const cleaned = catalogue.sanitiseCategories({ approval: false, nonsense: true, phase: 'yes' });
  assert.equal(cleaned.approval, false);
  assert.equal('nonsense' in cleaned, false);
  // A non-boolean is not an opinion, so the default stands.
  assert.equal(cleaned.phase, true);
  assert.equal(cleaned.finished, true);
});

/* ------------------------------------------------------------------ *
 * The register
 * ------------------------------------------------------------------ */

function subscriptionJson() {
  const browser = makeBrowser();
  return { browser, json: browser.subscription };
}

test('subscribing twice from one browser updates rather than duplicates', () => {
  const register = new push.Push(['you@example.com']);
  const { json } = subscriptionJson();
  const first = register.subscribe(json, undefined, 'Mac · Chrome');
  const second = register.subscribe(json, undefined, 'Mac · Chrome (again)');
  assert.ok(!('error' in first) && !('error' in second));
  assert.equal(register.list().length, 1);
  assert.equal(register.list()[0].label, 'Mac · Chrome (again)');
});

test('a re-subscribe keeps the categories already chosen', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  const device = register.subscribe(json, { phase: false }, 'phone');
  assert.ok(!('error' in device));
  register.subscribe(json, undefined, 'phone');
  assert.equal(register.list()[0].categories.phase, false);
});

test('a subscription that is not one is refused with a reason', () => {
  const register = new push.Push([]);
  assert.match((register.subscribe(null, undefined, '') as { error: string }).error, /no subscription/);
  assert.match((register.subscribe({ endpoint: 'nope' }, undefined, '') as { error: string }).error, /not a URL/);
  // The server POSTs to this. It does not get to be anything but a push service.
  assert.match((register.subscribe({
    endpoint: 'http://push.example.com/x', keys: { p256dh: 'a', auth: 'b' },
  }, undefined, '') as { error: string }).error, /https/);
  assert.match((register.subscribe({
    endpoint: 'https://push.example.com/x', keys: { p256dh: 'AAAA', auth: 'BBBB' },
  }, undefined, '') as { error: string }).error, /65-byte/);
});

test('the register never hands out the keys it holds', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  register.subscribe(json, undefined, 'phone');
  const [device] = register.list();
  assert.equal('endpoint' in device, false, 'an endpoint is a credential');
  assert.equal('keys' in device, false);
  assert.equal(device.service, 'https://push.example.com');
});

test('unsubscribing works by id or by endpoint', () => {
  const register = new push.Push([]);
  const a = subscriptionJson();
  const b = subscriptionJson();
  b.json.endpoint = 'https://push.example.com/sub/second';
  const first = register.subscribe(a.json, undefined, 'one') as { id: string };
  register.subscribe(b.json, undefined, 'two');
  assert.equal(register.unsubscribe(first.id), true);
  assert.equal(register.unsubscribe(b.json.endpoint), true);
  assert.equal(register.unsubscribe('neither'), false);
  assert.equal(register.list().length, 0);
});

test('categories can be changed per device', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  const device = register.subscribe(json, undefined, 'phone') as { id: string };
  const updated = register.setCategories(device.id, { changed: true, approval: false });
  assert.equal(updated?.categories.changed, true);
  assert.equal(updated?.categories.approval, false);
  assert.equal(register.setCategories('nope', {}), null);
});

test('the state a client is given carries the key and the catalogue', () => {
  const register = new push.Push([]);
  const state = register.state();
  assert.equal(Buffer.from(state.publicKey, 'base64url').length, 65);
  assert.equal(state.categories.length, catalogue.CATEGORIES.length);
});
