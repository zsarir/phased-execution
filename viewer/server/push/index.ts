/**
 * The push register: which devices asked to be told, and about what.
 *
 * One row per browser that subscribed — a phone on the home screen, a laptop
 * with the tab long closed — each with its own category choices, because the
 * two rarely want the same ones. Rows are persisted, so a console restart does
 * not quietly stop notifying anybody.
 *
 * Everything here is best-effort by construction. A push that fails must never
 * be able to affect a run: failures are logged, dead subscriptions are dropped,
 * and no caller is ever made to wait on a notification being delivered.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { log } from '../log.ts';
import {
  CATEGORIES, categoryOf, defaultCategories, routeFor, sanitiseCategories, type CategoryId,
} from './catalogue.ts';
import { deliver, origin, type PushMessage, type Subscription } from './send.ts';
import { loadVapid, vapidSubject, PUSH_DIR, type Vapid } from './vapid.ts';

export { CATEGORIES, routeFor, type CategoryId } from './catalogue.ts';

/**
 * What one device did with one announcement, told to whoever asked.
 *
 * `label` travels with it because a device can be dropped from the register the
 * moment it answers `gone` — and a history row reading "device
 * 4f3a…: gone" with nothing to name it is a row nobody can act on.
 */
export type DeliveryReport = {
  device: string;
  label: string;
  outcome: 'sent' | 'throttled' | 'failed' | 'gone';
  detail?: string;
};

const FILE = join(PUSH_DIR, 'subscriptions.json');

/**
 * After this many consecutive failures that were not "gone", a subscription is
 * dropped anyway. A push service that has rejected the same endpoint fifteen
 * times running is not going to start accepting it, and a register full of
 * corpses makes every event slower than the one before.
 */
const MAX_FAILURES = 15;

export type Device = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** What the browser called itself. Cosmetic — it is how you tell two rows apart. */
  label: string;
  categories: Record<CategoryId, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
};

export type PublicDevice = Omit<Device, 'endpoint' | 'keys'> & { service: string };

export class Push {
  private devices: Device[] = [];
  private vapid: Vapid;
  /** Same notification, same device, twice in a row: send it once. */
  private recent = new Map<string, number>();

  constructor(remoteUsers: string[] = []) {
    this.vapid = loadVapid(vapidSubject(remoteUsers));
    this.devices = read();
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  list(): PublicDevice[] {
    return this.devices.map(({ endpoint, keys, ...rest }) => ({ ...rest, service: origin(endpoint) }));
  }

  state(): { publicKey: string; devices: PublicDevice[]; categories: readonly unknown[] } {
    return { publicKey: this.publicKey, devices: this.list(), categories: CATEGORIES };
  }

  /**
   * Subscribing twice from the same browser is the normal case, not an error —
   * a permission re-grant, a reinstall, a page that could not tell. The
   * endpoint identifies the device, so a repeat updates rather than duplicates,
   * and an existing row keeps its category choices unless new ones are given.
   */
  subscribe(input: unknown, categories: unknown, label: unknown): PublicDevice | { error: string } {
    const parsed = parseSubscription(input);
    if ('error' in parsed) return parsed;

    const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'a browser';
    const existing = this.devices.find((d) => d.endpoint === parsed.endpoint);

    if (existing) {
      existing.keys = parsed.keys;
      existing.label = name;
      existing.failures = 0;
      if (categories !== undefined) existing.categories = sanitiseCategories(categories);
      this.persist();
      return this.publicOf(existing);
    }

    const device: Device = {
      id: randomUUID(),
      endpoint: parsed.endpoint,
      keys: parsed.keys,
      label: name,
      categories: categories === undefined ? defaultCategories() : sanitiseCategories(categories),
      createdAt: new Date().toISOString(),
      lastOkAt: null,
      failures: 0,
    };
    this.devices.push(device);
    this.persist();
    log.info('push.subscribed', { id: device.id, label: device.label, service: origin(device.endpoint) });
    return this.publicOf(device);
  }

  unsubscribe(idOrEndpoint: unknown): boolean {
    const key = String(idOrEndpoint ?? '');
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== key && d.endpoint !== key);
    if (this.devices.length === before) return false;
    this.persist();
    log.info('push.unsubscribed', { key: key.slice(0, 40) });
    return true;
  }

  setCategories(id: unknown, categories: unknown): PublicDevice | null {
    const device = this.devices.find((d) => d.id === String(id ?? ''));
    if (!device) return null;
    device.categories = sanitiseCategories(categories);
    this.persist();
    return this.publicOf(device);
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  /**
   * Tell every device that asked about this category.
   *
   * Deliberately not awaited by callers: this is called from the middle of a
   * run's event handling, and a slow push service must not be able to stall a
   * phase. Everything that can go wrong is handled here and logged.
   *
   * `onDelivery` is how that stops being invisible. Because nothing awaits
   * this, a throttled, refused or undeliverable push reached no further than a
   * log line — so the outcome is now reported back per device, and the
   * notification store keeps it against the record. Called after the fact and
   * never awaited either: it annotates history, it does not gate it.
   */
  announce(
    category: CategoryId,
    message: Omit<PushMessage, 'category'>,
    now = Date.now(),
    onDelivery?: (report: DeliveryReport) => void,
  ): void {
    const targets = this.devices.filter((d) => d.categories[category]);
    if (!targets.length) return;

    const urgent = categoryOf(category).urgent;
    for (const device of targets) {
      // The same tag to the same device inside a few seconds is a re-render, not
      // a second event. The push service would collapse it by topic anyway; not
      // sending it at all is cheaper and does not race.
      const key = `${device.id}:${message.tag}`;
      const last = this.recent.get(key);
      if (last && now - last < 5_000) continue;
      this.recent.set(key, now);

      void this.sendOne(device, { ...message, category }, urgent).then((result) => {
        if (!onDelivery) return;
        try {
          onDelivery({
            device: device.id,
            label: device.label,
            outcome: result.kind,
            detail: result.kind === 'failed' ? result.detail
              : result.kind === 'throttled' ? `retry after ${result.retryAfter ?? 'unknown'}s`
                : undefined,
          });
        } catch { /* annotating a record must never affect a run */ }
      });
    }
    this.prune(now);
  }

  /** The Settings button: prove the whole chain, on one device, on demand. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const device = this.devices.find((d) => d.id === id);
    if (!device) return { ok: false, detail: 'no such device' };
    const result = await this.sendOne(device, {
      title: 'Phase Console',
      body: `Notifications are working on ${device.label}.`,
      tag: 'push-test',
      url: routeFor('health'),
      category: 'approval',
    }, false);
    return result.kind === 'sent'
      ? { ok: true, detail: `accepted by ${origin(device.endpoint)} (${result.status})` }
      : { ok: false, detail: `${result.kind}${'status' in result && result.status ? ` ${result.status}` : ''}` };
  }

  private async sendOne(device: Device, message: PushMessage, urgent: boolean) {
    const result = await deliver(this.vapid, device, message, { urgent });
    switch (result.kind) {
      case 'sent':
        device.lastOkAt = new Date().toISOString();
        device.failures = 0;
        break;
      case 'gone':
        // Its normal end of life: the app was deleted, or permission revoked.
        log.info('push.gone', { id: device.id, label: device.label });
        this.unsubscribe(device.id);
        return result;
      case 'throttled':
        log.warn('push.throttled', { id: device.id, retryAfter: result.retryAfter });
        break;
      default:
        device.failures++;
        if (device.failures >= MAX_FAILURES) {
          log.warn('push.dropped', { id: device.id, label: device.label, failures: device.failures });
          this.unsubscribe(device.id);
          return result;
        }
    }
    this.persist();
    return result;
  }

  /** The dedupe map is unbounded otherwise, and a long-lived console is the point. */
  private prune(now: number): void {
    if (this.recent.size < 512) return;
    for (const [key, at] of this.recent) if (now - at > 60_000) this.recent.delete(key);
  }

  private publicOf(device: Device): PublicDevice {
    const { endpoint, keys, ...rest } = device;
    return { ...rest, service: origin(endpoint) };
  }

  private persist(): void {
    try {
      mkdirSync(PUSH_DIR, { recursive: true, mode: 0o700 });
      // These keys let anyone holding them send this device a notification.
      writeFileSync(FILE, `${JSON.stringify(this.devices, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log.warn('push.persist-failed', { error });
    }
  }
}

function read(): Device[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Device[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d?.endpoint && d?.keys?.p256dh && d?.keys?.auth)
      .map((d) => ({ ...d, categories: sanitiseCategories(d.categories), failures: Number(d.failures) || 0 }));
  } catch {
    return [];
  }
}

function parseSubscription(input: unknown): (Subscription & { endpoint: string }) | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'no subscription' };
  const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(sub.endpoint ?? '');
  // Only somewhere a push service lives. An endpoint is a URL this server will
  // POST to, so it does not get to be `file:` or a host on the loopback.
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { return { error: 'endpoint is not a URL' }; }
  if (parsed.protocol !== 'https:') return { error: 'endpoint must be https' };

  const p256dh = String(sub.keys?.p256dh ?? '');
  const auth = String(sub.keys?.auth ?? '');
  if (Buffer.from(p256dh, 'base64url').length !== 65) return { error: 'p256dh must be a 65-byte P-256 point' };
  if (Buffer.from(auth, 'base64url').length !== 16) return { error: 'auth must be 16 bytes' };

  return { endpoint, keys: { p256dh, auth } };
}

/** A stable tag for a thing, so repeats about it collapse rather than stack. */
export function tagFor(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256').update(parts.filter((p) => p != null).join(':')).digest('hex').slice(0, 16);
}
