/**
 * Everything the console has told you, kept.
 *
 * Until now every announcement was fire-and-forget. A notification went out
 * over SSE to whatever tab happened to be open and to whatever device happened
 * to be subscribed, and then it was gone: no tab open and no device registered
 * meant the event had simply never existed. For a console whose entire purpose
 * is supervising work you are not watching, "we told you, you were asleep, it
 * is not recoverable" is the wrong answer — and it was the answer for every
 * halt, every approval and every finished plan.
 *
 * So there is a store, and it is written at the same choke point as the
 * announcement itself (`Service.announce`). That is deliberate and it is the
 * whole design: the inbox is complete *by construction* rather than by every
 * future call site remembering to also write a record. A notification that is
 * not in here was not announced.
 *
 * Two guarantees, and they are different strengths, so they are stated
 * separately rather than blurred:
 *
 *  - **The record is durable.** It is appended synchronously, before anything
 *    is delivered anywhere, so it survives a crash between announcing and
 *    delivering — and it exists when nothing is listening at all.
 *  - **The annotations are best-effort.** Read flags, delivery outcomes and
 *    clears are folded into memory immediately and written back by a debounced
 *    atomic rewrite. Losing one to a hard kill costs a read marker, never the
 *    record.
 *
 * `delivery` is the part worth having: a push that was throttled, refused or
 * sent to a subscription that has died is otherwise invisible — `announce()`
 * returns void by design so a slow push service cannot stall a phase, which
 * also means nothing ever reported that it failed. Now it is on the record.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { categoryOf, isCategory, routeFor, type CategoryId, type RouteContext } from './push/catalogue.ts';

export const NOTIFICATIONS_DIR = join(STATE_DIR, 'notifications');

/**
 * Retention. Generous enough that "what happened overnight" is always there,
 * bounded enough that a console left running for a year does not accumulate a
 * file nobody will ever read the top of.
 */
const MAX_RECORDS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A hard stop independent of the count, in case a record is somehow enormous. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Long fields are trimmed at the source: this is a lock-screen line, not a log. */
const MAX_TEXT = 500;
/** Annotations are collapsed rather than written one rewrite at a time. */
const FLUSH_MS = 750;

/** What happened when this notification was handed to one device. */
export type DeliveryOutcome = 'sent' | 'throttled' | 'failed' | 'gone';

export type DeliveryRecord = {
  /** The push register's device id. */
  device: string;
  /** What that browser called itself, so a row still reads after the device is gone. */
  label: string;
  outcome: DeliveryOutcome;
  at: string;
  detail?: string;
};

export type NotificationRecord = {
  id: string;
  at: string;
  category: CategoryId;
  title: string;
  body: string;
  /** Built by `routeFor` and never by hand. See `push/catalogue.ts`. */
  url: string;
  /**
   * What this notification is *about*, structured rather than only rendered
   * into `title`/`body`/`url`.
   *
   * The inbox could always say what happened and link to it; nothing could ask
   * "which of these are about the plan I am looking at". That is the whole
   * difference between a mark-all-read button and an inbox that quietly clears
   * the records for the page you just opened — and it is the other half of the
   * 182-unread problem, because the half P1 fixed only stops new ones arriving.
   *
   * Additive JSONL fields: a record written before they existed simply has
   * none, and scoped reads skip it rather than treating absent as a match.
   */
  slug?: string;
  runId?: string;
  phase?: number;
  /** The terminal/agent session an ending belongs to (`session` notifications). */
  sessionId?: string;
  /** Interrupts a focus mode. Copied from the catalogue at write time. */
  urgent: boolean;
  read: boolean;
  delivery: DeliveryRecord[];
};

export type NotificationInput = {
  category: CategoryId;
  title: string;
  body: string;
  /** Where it goes when tapped. Omitted means "derive it from the category". */
  url?: string;
  runId?: string;
} & RouteContext;

export type NotificationQuery = {
  category?: string | null;
  unreadOnly?: boolean;
  limit?: number;
  /** Paging: only records older than this id. */
  before?: string | null;
};

export class Notifications {
  readonly path: string;
  /** Newest last, exactly as the file reads. */
  private items: NotificationRecord[] = [];
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir = NOTIFICATIONS_DIR) {
    this.path = join(dir, 'notifications.jsonl');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log.warn('notifications.mkdir', { dir, error });
    }
    this.items = read(this.path);
    // Retention on load as well as on write: a console that was off for two
    // months should not come back holding two months of stale rows.
    if (this.prune()) this.rewrite();
  }

  /* ---------------------------------------------------------------- *
   * Writing
   * ---------------------------------------------------------------- */

  /**
   * Record one announcement. Synchronous and durable — this is the guarantee
   * the inbox rests on, so it happens before any delivery is attempted.
   */
  record(input: NotificationInput): NotificationRecord {
    const entry: NotificationRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      category: input.category,
      title: trim(input.title),
      body: trim(input.body),
      url: input.url ?? routeFor(input.category, input),
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(typeof input.phase === 'number' ? { phase: input.phase } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      urgent: safeUrgent(input.category),
      read: false,
      delivery: [],
    };

    this.items.push(entry);
    const pruned = this.prune();
    // A prune has to rewrite anyway, and a rewrite already contains this record
    // — appending as well would duplicate it on the next load.
    if (pruned || this.tooBig()) this.rewrite();
    else this.append(entry);
    return entry;
  }

  /** What one device did with it. Called from the push layer, after the fact. */
  delivery(id: string, entry: DeliveryRecord): void {
    const found = this.items.find((item) => item.id === id);
    if (!found) return;
    // The same device reporting twice about one notification replaces rather
    // than stacks: a retry is not two deliveries.
    const at = found.delivery.findIndex((d) => d.device === entry.device);
    if (at >= 0) found.delivery[at] = entry;
    else found.delivery.push(entry);
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  list(query: NotificationQuery = {}): {
    items: NotificationRecord[];
    total: number;
    unread: number;
    /** Whether `items` was cut short — so the client can offer "older" honestly. */
    more: boolean;
  } {
    const limit = clampLimit(query.limit);
    // Newest first is the only order an inbox is ever read in.
    let rows = [...this.items].reverse();
    if (query.category && isCategory(query.category)) rows = rows.filter((r) => r.category === query.category);
    if (query.unreadOnly) rows = rows.filter((r) => !r.read);
    if (query.before) {
      const at = rows.findIndex((r) => r.id === query.before);
      // An unknown cursor returns the first page rather than nothing: a client
      // paging through a list that was cleared underneath it should recover,
      // not go blank.
      if (at >= 0) rows = rows.slice(at + 1);
    }
    return {
      items: rows.slice(0, limit),
      total: rows.length,
      unread: this.unread(),
      more: rows.length > limit,
    };
  }

  unread(): number {
    return this.items.reduce((n, item) => n + (item.read ? 0 : 1), 0);
  }

  /* ---------------------------------------------------------------- *
   * Mutating
   * ---------------------------------------------------------------- */

  /** `ids` omitted means every unread record. Returns how many changed. */
  markRead(ids?: string[] | null): number {
    const wanted = ids?.length ? new Set(ids) : null;
    let changed = 0;
    for (const item of this.items) {
      if (item.read) continue;
      if (wanted && !wanted.has(item.id)) continue;
      item.read = true;
      changed++;
    }
    if (changed) this.touch();
    return changed;
  }

  /**
   * Mark read everything a scope actually matches. Returns how many changed.
   *
   * This is what makes "opening the page counts as reading it" safe. Every
   * field given must match, and **an empty scope matches nothing** — the
   * opposite of `markRead()`, deliberately: this one is called automatically by
   * a page that has just loaded, and a slug that arrived as `undefined` because
   * a route had not parsed yet must clear zero records, not the whole inbox.
   *
   * A record missing the field being scoped on is not a match. Records written
   * before the context fields existed therefore stay unread until someone
   * clears them by hand, which is the honest outcome — nothing knows what they
   * were about.
   */
  markReadWhere(scope: {
    slug?: string; category?: string; runId?: string; sessionId?: string; phase?: number;
  }): number {
    const tests: ((item: NotificationRecord) => boolean)[] = [];
    if (scope.slug) tests.push((item) => item.slug === scope.slug);
    if (scope.category) tests.push((item) => item.category === scope.category);
    if (scope.runId) tests.push((item) => item.runId === scope.runId);
    if (scope.sessionId) tests.push((item) => item.sessionId === scope.sessionId);
    if (typeof scope.phase === 'number') tests.push((item) => item.phase === scope.phase);
    if (!tests.length) return 0;

    let changed = 0;
    for (const item of this.items) {
      if (item.read) continue;
      if (!tests.every((matches) => matches(item))) continue;
      item.read = true;
      changed++;
    }
    if (changed) this.touch();
    return changed;
  }

  /**
   * `all` empties it, `read` keeps what you have not seen, an id drops one.
   * Never implicit: nothing in here is deleted as a side effect of reading it.
   */
  clear(what: 'all' | 'read' | { id: string }): number {
    const before = this.items.length;
    if (what === 'all') this.items = [];
    else if (what === 'read') this.items = this.items.filter((item) => !item.read);
    else this.items = this.items.filter((item) => item.id !== what.id);
    const removed = before - this.items.length;
    if (removed) this.rewrite();
    return removed;
  }

  /** Write anything outstanding now. Called on shutdown. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.rewrite();
  }

  /* ---------------------------------------------------------------- *
   * The file
   * ---------------------------------------------------------------- */

  private append(entry: NotificationRecord): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log.warn('notifications.append', { path: this.path, error });
    }
  }

  /** Annotations are collapsed: a burst of deliveries is one write. */
  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.rewrite();
      // Unreferenced: a pending flush must never be the reason this process
      // cannot exit. `flush()` on shutdown is what makes that safe.
    }, FLUSH_MS).unref();
  }

  /**
   * Rewrite the whole file, atomically.
   *
   * Temp-then-rename rather than truncate-then-write: a crash mid-write would
   * otherwise leave the inbox truncated at a line boundary, and the failure
   * mode of a durability mechanism should not be losing the data.
   */
  private rewrite(): void {
    this.dirty = false;
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, this.items.map((item) => `${JSON.stringify(item)}\n`).join(''), {
        encoding: 'utf8', mode: 0o600,
      });
      renameSync(temp, this.path);
    } catch (error) {
      log.warn('notifications.rewrite', { path: this.path, error });
      try { unlinkSync(temp); } catch { /* the temp file is already gone */ }
    }
  }

  private tooBig(): boolean {
    try { return statSync(this.path).size > MAX_BYTES; } catch { return false; }
  }

  /** Retention by age and count. Returns whether anything was dropped. */
  private prune(): boolean {
    const before = this.items.length;
    const cutoff = Date.now() - MAX_AGE_MS;
    // Age first, then count, so a quiet month is trimmed by date and a loud
    // hour is trimmed by volume.
    this.items = this.items.filter((item) => {
      const at = Date.parse(item.at);
      return !Number.isFinite(at) || at >= cutoff;
    });
    if (this.items.length > MAX_RECORDS) this.items = this.items.slice(-MAX_RECORDS);
    return this.items.length !== before;
  }
}

function read(path: string): NotificationRecord[] {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out: NotificationRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as NotificationRecord;
      // A record whose category no longer exists still reads as history; it
      // just cannot claim a category the catalogue does not have.
      if (!parsed?.id || !isCategory(parsed.category)) continue;
      out.push({ ...parsed, read: parsed.read === true, delivery: Array.isArray(parsed.delivery) ? parsed.delivery : [] });
    } catch {
      /* a half-written tail line, which an atomic rewrite makes unlikely and a
         kill mid-append still makes possible */
    }
  }
  return out;
}

function trim(value: string): string {
  const text = String(value ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** A category from an older record, or a caller that got it wrong, is not urgent. */
function safeUrgent(category: CategoryId): boolean {
  try { return categoryOf(category).urgent; } catch { return false; }
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
