/**
 * Encrypting and delivering one push message (RFC 8291, `aes128gcm`).
 *
 * A push service relays bytes it cannot read. That is the point: the payload is
 * encrypted to a key only the subscribing browser holds, so Apple, Google and
 * Mozilla forward notifications about your plans without being able to see one.
 *
 * The shape of a message, per RFC 8188:
 *
 *   salt(16) ‖ record-size(4) ‖ key-id-length(1) ‖ our-public-key(65) ‖ AES-GCM(payload ‖ 0x02)
 *
 * The key agreement is ECDH between an ephemeral keypair made per message and
 * the subscription's `p256dh`, mixed with the subscription's `auth` secret
 * through HKDF. The ephemeral key is why the whole 65-byte public point travels
 * in the header: the browser needs it to derive the same secret.
 *
 * Every value here is fixed by the RFC — the `\0`-terminated info strings, the
 * 0x02 padding delimiter, the byte lengths. None of it is a choice, and getting
 * one wrong produces a message the browser silently discards.
 */

import {
  generateKeyPairSync, createPublicKey, createHash, diffieHellman, hkdfSync, createCipheriv, randomBytes,
} from 'node:crypto';

import { log } from '../log.ts';
import { authorization, rawPublicKey, type Vapid } from './vapid.ts';

export type Subscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** What the push service did with it, in terms the caller can act on. */
export type Delivery =
  /** Accepted for delivery. */
  | { kind: 'sent'; status: number }
  /** The subscription is dead. Stop sending to it and forget it. */
  | { kind: 'gone'; status: number }
  /** Too many, too fast. Keep the subscription; try again later. */
  | { kind: 'throttled'; status: number; retryAfter: number | null }
  /** Anything else: a bad payload, a service having a bad day, a dead network. */
  | { kind: 'failed'; status: number; detail: string };

export type PushMessage = {
  title: string;
  body: string;
  /** Collapses repeats: the same tag replaces rather than stacks. */
  tag: string;
  /** Where clicking it should land. Built by `routeFor`, never by hand. */
  url: string;
  category: string;
  /**
   * The card this notification is about, when it is about one.
   *
   * It is what lets the service worker put Allow and Deny on the notification
   * itself, so answering from a lock screen is one tap rather than unlock →
   * open → find the queue. Nothing else in the payload identifies a card.
   */
  approvalId?: string;
  /** The record in the inbox, so a tap can mark exactly that row read. */
  notificationId?: string;
};

/**
 * A message a push service will accept is small. Apple's limit is the tightest
 * in practice, and a body long enough to hit it was never going to be read on a
 * lock screen anyway, so it is trimmed at the source rather than rejected.
 */
const MAX_BODY = 400;

export function encrypt(subscription: Subscription, payload: Buffer): Buffer {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  if (uaPublic.length !== 65) throw new Error(`p256dh must be a 65-byte point, got ${uaPublic.length}`);
  if (authSecret.length !== 16) throw new Error(`auth must be 16 bytes, got ${authSecret.length}`);

  // Ephemeral, per message: the same plaintext to the same device never
  // produces the same ciphertext twice.
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ourPublic = Buffer.from(rawPublicKey(ephemeral.publicKey), 'base64url');

  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: {
        kty: 'EC', crv: 'P-256',
        x: uaPublic.subarray(1, 33).toString('base64url'),
        y: uaPublic.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    }),
  });

  // The auth secret is the salt here, and both public keys are bound into the
  // info — so a secret derived for one subscription cannot be replayed at
  // another even if the ECDH inputs somehow repeated.
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, ourPublic]), 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last record. One record is all this ever sends.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([ourPublic.length]), ourPublic, sealed]);
}

export async function deliver(
  vapid: Vapid, subscription: Subscription, message: PushMessage,
  { ttlSeconds = 6 * 60 * 60, urgent = false, fetchImpl = fetch } = {},
): Promise<Delivery> {
  const payload = Buffer.from(JSON.stringify({
    ...message,
    body: message.body.length > MAX_BODY ? `${message.body.slice(0, MAX_BODY - 1)}…` : message.body,
  }));

  let body: Buffer;
  try {
    body = encrypt(subscription, payload);
  } catch (error) {
    return { kind: 'failed', status: 0, detail: `encrypt: ${(error as Error).message}` };
  }

  let response: Response;
  try {
    response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: authorization(vapid, subscription.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        // How long the service should hold it for a device that is offline.
        // Long enough to survive a night; short enough that a phone waking up
        // is not told about an approval that expired hours ago.
        ttl: String(ttlSeconds),
        urgency: urgent ? 'high' : 'normal',
        // Same topic replaces rather than queues, so a device that was off does
        // not wake to six notifications about one run. See `topicFor` for why
        // this is a hash and not the tag with its punctuation removed.
        topic: topicFor(message.tag),
      },
      body: new Uint8Array(body),
    });
  } catch (error) {
    // No network, DNS failure, the machine asleep. Not the subscription's fault.
    return { kind: 'failed', status: 0, detail: (error as Error).message };
  }

  if (response.ok) return { kind: 'sent', status: response.status };

  // The subscription is unsubscribed, expired, or was never valid. This is the
  // normal end of a subscription's life — an app deleted, a browser profile
  // wiped — and the only correct response is to forget it.
  if (response.status === 404 || response.status === 410) {
    return { kind: 'gone', status: response.status };
  }

  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after'));
    return { kind: 'throttled', status: 429, retryAfter: Number.isFinite(header) ? header : null };
  }

  let detail = '';
  try { detail = (await response.text()).slice(0, 200); } catch { /* a body is a courtesy */ }
  log.warn('push.rejected', { status: response.status, detail, endpoint: origin(subscription.endpoint) });
  return { kind: 'failed', status: response.status, detail };
}

/** Endpoints carry a device-identifying token; the origin is the useful half for a log. */
export function origin(endpoint: string): string {
  try { return new URL(endpoint).origin; } catch { return 'unparseable'; }
}

/**
 * A `Topic` a push service will actually accept.
 *
 * RFC 8030 says this header is a "token", which would allow almost anything
 * short. Apple means something much narrower, and says so only by rejecting the
 * message with `BadWebPushTopic` — measured against the real service:
 *
 *   (no header)                        accepted
 *   phase                        (5)   REJECTED
 *   a1b2c3d4e5f60718            (16)   accepted
 *   push-test                    (9)   REJECTED
 *   32 chars of base64url       (32)   accepted
 *   33 chars                    (33)   REJECTED
 *
 * Every one of those is explained by a single rule: it must be a *decodable*
 * base64url string — a length of `n % 4 === 1` cannot be one — of at most 32
 * characters. The hyphen in `push-test` was innocent; it failed on its length.
 *
 * Hashing rather than sanitising means the caller never has to know any of
 * that, and the same tag still maps to the same topic, which is the only
 * property the header is there for.
 */
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 24);
}
