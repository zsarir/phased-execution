/**
 * VAPID — proving to a push service who is sending.
 *
 * A push service will not forward a message from an anonymous sender. RFC 8292
 * settles that with a keypair the application server keeps: the browser is
 * given the public half when it subscribes, and every message carries a JWT
 * signed by the private half. The push service checks the two agree.
 *
 * The keypair is generated once and kept. Regenerating it silently invalidates
 * every existing subscription — the browser would keep sending to an endpoint
 * bound to a key we no longer hold, and nothing would arrive — so the file is
 * written once and only ever read afterwards.
 *
 * `node:crypto` covers all of this. `dsaEncoding: 'ieee-p1363'` is the part
 * that matters: ES256 wants the raw r‖s pair, and Node's default for EC keys is
 * DER, which a push service rejects as malformed.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';

export type Vapid = {
  /** The uncompressed P-256 point, base64url — what a browser wants as `applicationServerKey`. */
  publicKey: string;
  privateKey: KeyObject;
  /** The `sub` claim: who to contact about this sender. */
  subject: string;
};

/**
 * Per instance, deliberately: each console mints its own VAPID pair on the
 * first subscribe, and a browser's subscription is bound to the key that
 * created it. Sharing one pair across instances would let any console deliver
 * to any other's devices — and the default instance keeping the legacy path is
 * what stops an upgrade from invalidating the subscriptions an operator's
 * phone already holds.
 */
const PUSH_DIR = join(INSTANCE_STATE_DIR, 'push');
const KEY_FILE = join(PUSH_DIR, 'vapid.json');

/**
 * A push service will reject a JWT whose `sub` is not a `mailto:` or `https:`
 * URL, and some are stricter than others about it being plausible. The console
 * already knows one real address in the common case — the login allowed to
 * reach it remotely — so that is used before falling back.
 */
export function vapidSubject(remoteUsers: string[]): string {
  const email = remoteUsers.find((u) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u));
  return email ? `mailto:${email}` : 'mailto:phase-console@localhost';
}

export function loadVapid(subject: string): Vapid {
  const stored = read();
  if (stored) {
    return {
      publicKey: stored.publicKey,
      privateKey: createPrivateKey({ key: stored.privateKeyJwk, format: 'jwk' }),
      subject,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const created = {
    publicKey: rawPublicKey(publicKey),
    privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, string>,
  };
  write(created);
  log.info('push.vapid.created', { file: KEY_FILE });
  return { publicKey: created.publicKey, privateKey, subject };
}

/** A public EC key as the uncompressed point browsers expect: `0x04 ‖ x ‖ y`. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * The Authorization header
 * ------------------------------------------------------------------ */

/**
 * One JWT per push service, reused until it is close to expiring.
 *
 * `aud` is the *origin* of the endpoint, not the endpoint, so every
 * subscription on the same service shares a token. Signing per message would be
 * a P-256 signature per notification for no benefit.
 */
const tokens = new Map<string, { header: string; expiresAt: number }>();

const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Renew early: a token that expires in transit is a silent delivery failure. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;

export function authorization(vapid: Vapid, endpoint: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const cached = tokens.get(audience);
  if (cached && cached.expiresAt - now > RENEW_BEFORE_MS) return cached.header;

  const expiresAt = now + TOKEN_LIFETIME_MS;
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(expiresAt / 1000),
    sub: vapid.subject,
  }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), {
    key: vapid.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const header = `vapid t=${head}.${claims}.${signature}, k=${vapid.publicKey}`;
  tokens.set(audience, { header, expiresAt });
  return header;
}

/** Tests reach for this; nothing in the server does. */
export function resetTokenCache(): void {
  tokens.clear();
}

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

type Stored = { publicKey: string; privateKeyJwk: Record<string, string> };

function read(): Stored | null {
  try {
    const parsed = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as Stored;
    if (parsed?.publicKey && parsed?.privateKeyJwk) return parsed;
    log.warn('push.vapid.unreadable', { file: KEY_FILE, note: 'malformed; a new keypair will be generated' });
  } catch { /* first run */ }
  return null;
}

function write(value: Stored): void {
  mkdirSync(PUSH_DIR, { recursive: true, mode: 0o700 });
  // A private key, so nobody else's mode bits.
  writeFileSync(KEY_FILE, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export { KEY_FILE as VAPID_FILE, PUSH_DIR };
