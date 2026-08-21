/**
 * The session registry — who is in this repository right now.
 *
 * Until this existed an interactive `claude`, a console agent and an autopilot
 * lane could see each other only through lock files and leases: a person's
 * session that ended with its lock still on disk held the queue for the rest
 * of the lease, and a live one read no differently from a dead one. The
 * user-scope hook (`scripts/session-hook.sh`, installed from Settings or
 * `phase-console install-hooks`) now reports SessionStart / Stop / SessionEnd
 * for every Claude session on the machine whose working directory a console
 * owns — by POST while the console is up, by a file in the instance's inbox
 * while it is not — and this module keeps the answer.
 *
 * Three rules the code is built around. **Presence is a three-valued answer**:
 * `ended` (the hook said so, or the session's process is gone), `live` (seen
 * recently and nothing says otherwise), `unknown` (nobody reports it; lease
 * rules apply) — a reader that cannot tell `unknown` from `ended` would turn
 * an un-hooked machine into a machine where every lock is debris. **Only a
 * STRONG correlation may make a lock debris**: the lock's own `session=` line
 * naming the session. Matching by `<user>@<host>` and time is for display —
 * a person with two sessions ends one, and the other still holds its lock.
 * **The hook is the writer and this is the reader**: nothing here invents a
 * session; a payload is validated, capped and applied, never trusted.
 *
 * State lives under `INSTANCE_STATE_DIR/sessions/` — per instance, like the
 * accounts and MCP registries and for the same reason: two consoles on one
 * machine are two projects. `<id>.json` is the record; `inbox/` is where the
 * hook drops events it could not POST, ingested at boot, on a watcher event
 * and on a slow poll, then deleted.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export type SessionEventName = 'SessionStart' | 'SessionEnd' | 'Stop';
/** autopilot — a lane this console (or another) spawned; agent — a console pty session; foreign — a person's own `claude`. */
export type SessionKind = 'autopilot' | 'agent' | 'foreign';
export type SessionPresence = 'live' | 'ended' | 'unknown';

/** What `scripts/session-hook.sh` sends (and drops into the inbox). Every field but the first three is optional. */
export type HookPayload = {
  session_id: string;
  event: SessionEventName;
  cwd: string;
  transcript_path?: string;
  source?: string;
  reason?: string;
  owner?: string;
  scope?: string;
  user?: string;
  host?: string;
  pid?: number;
  root?: string;
  at?: string;
};

export type SessionRecord = {
  sessionId: string;
  kind: SessionKind;
  cwd: string;
  /** The project root the hook resolved for `cwd`, when it could. */
  root?: string;
  transcript?: string;
  /** `PE_OWNER` in the session's environment — `autopilot/<runId>` for a lane. */
  owner?: string;
  scope?: string;
  user?: string;
  host?: string;
  /** The `claude` process, for the liveness probe. */
  pid?: number;
  /** ISO — the first SessionStart seen (or the first event, when it was not a start). */
  startedAt: string;
  /** ISO — the newest event seen. */
  lastSeen: string;
  endedAt?: string;
  reason?: string;
  source?: string;
  /** Stop events seen — one per finished turn; a heartbeat. */
  turns: number;
};

/** A record as the API serves it: the record plus the answers readers want. */
export type SessionView = SessionRecord & {
  presence: SessionPresence;
  /** The plan and phase the session works, when a lock says so (strong) or the owner+time suggest it (weak). */
  plan?: { slug: string; phase: number; strong: boolean };
};

export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const EVENTS: readonly string[] = ['SessionStart', 'SessionEnd', 'Stop'];
const EVENT_RANK: Record<string, number> = { SessionStart: 0, Stop: 1, SessionEnd: 2 };

/** A never-ended session unseen this long reads `unknown`, not `live` — the hook may simply be gone. */
export const LIVE_WINDOW_MS = 24 * 60 * 60_000;
/** Ended records are kept this long (the Pulse's "just finished"), silent ones this long. */
export const RETAIN_ENDED_MS = 24 * 60 * 60_000;
export const RETAIN_SILENT_MS = 7 * 24 * 60 * 60_000;
/** Weak correlation: a lock claimed this long before the session's first event may still be its own. */
const WEAK_CLAIM_SLACK_MS = 5 * 60_000;
const INBOX_DEBOUNCE_MS = 100;
const INBOX_POLL_MS = 30_000;

/* ------------------------------------------------------------------ *
 * Pure pieces
 * ------------------------------------------------------------------ */

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters become spaces: one line per value, nothing that can
  // break a log line or a key=value file downstream.
  const s = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * Validate and cap a hook body. Null for anything that is not a session event
 * — the route answers 400 and the inbox file is dropped. Only id characters
 * survive in `session_id`; every string is bounded; `pid` must be a positive
 * integer; `at` must parse as a date (else the receiver's clock is used).
 */
export function parseHookPayload(body: unknown): HookPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const sessionId = str(b.session_id, 128);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const event = str(b.event, 32) ?? str(b.hook_event_name, 32);
  if (!event || !EVENTS.includes(event)) return null;
  const cwd = str(b.cwd, 1024);
  if (!cwd || !cwd.startsWith('/')) return null;
  const pidRaw = typeof b.pid === 'number' ? b.pid : typeof b.pid === 'string' ? Number(b.pid) : NaN;
  const pid = Number.isInteger(pidRaw) && pidRaw > 0 && pidRaw < 2 ** 31 ? pidRaw : undefined;
  const at = str(b.at, 40);
  const out: HookPayload = { session_id: sessionId, event: event as SessionEventName, cwd };
  const transcript = str(b.transcript_path, 1024);
  if (transcript) out.transcript_path = transcript;
  const source = str(b.source, 64); if (source) out.source = source;
  const reason = str(b.reason, 64); if (reason) out.reason = reason;
  const owner = str(b.owner, 128); if (owner) out.owner = owner;
  const scope = str(b.scope, 256); if (scope) out.scope = scope;
  const user = str(b.user, 64); if (user) out.user = user;
  const host = str(b.host, 64); if (host) out.host = host;
  if (pid) out.pid = pid;
  const root = str(b.root, 1024); if (root && root.startsWith('/')) out.root = root;
  if (at && Number.isFinite(Date.parse(at))) out.at = at;
  return out;
}

/** The kind, from the owner the session's environment carried — the same vocabulary the locks use. */
export function kindOf(owner: string | undefined): SessionKind {
  if (!owner) return 'foreign';
  if (/^autopilot\//.test(owner)) return 'autopilot';
  if (/^console\//.test(owner)) return 'agent';
  return 'foreign';
}

/**
 * Fold one event into a record. Pure: the caller decides the clock.
 *
 * A SessionStart for an id that had ENDED revives it — `claude --resume <id>`
 * keeps the id, and its SessionEnd(reason: resume) preceded the new start. An
 * event older than the end it would undo (inbox replay out of order) updates
 * nothing about liveness.
 */
export function applyEvent(prev: SessionRecord | undefined, p: HookPayload, nowIso: string): SessionRecord {
  const at = p.at && Number.isFinite(Date.parse(p.at)) ? new Date(Date.parse(p.at)).toISOString() : nowIso;
  const base: SessionRecord = prev
    ? { ...prev }
    : { sessionId: p.session_id, kind: kindOf(p.owner), cwd: p.cwd, startedAt: at, lastSeen: at, turns: 0 };
  // Facts the payload carries replace what was known; absent ones are kept.
  base.cwd = p.cwd;
  if (p.transcript_path) base.transcript = p.transcript_path;
  if (p.owner) { base.owner = p.owner; base.kind = kindOf(p.owner); }
  if (p.scope) base.scope = p.scope;
  if (p.user) base.user = p.user;
  if (p.host) base.host = p.host;
  if (p.pid) base.pid = p.pid;
  if (p.root) base.root = p.root;
  const stale = base.endedAt != null && Date.parse(at) < Date.parse(base.endedAt);
  if (Date.parse(at) > Date.parse(base.lastSeen)) base.lastSeen = at;
  switch (p.event) {
    case 'SessionStart':
      if (!prev) base.startedAt = at;
      if (p.source) base.source = p.source;
      if (!stale) { delete base.endedAt; delete base.reason; }
      break;
    case 'Stop':
      base.turns += 1;
      if (!stale) { delete base.endedAt; delete base.reason; }
      break;
    case 'SessionEnd':
      if (!base.endedAt || Date.parse(at) >= Date.parse(base.endedAt)) {
        base.endedAt = at;
        if (p.reason) base.reason = p.reason; else delete base.reason;
      }
      break;
  }
  return base;
}

/** Three-valued, by the rules in the header. `pidAlive` absent ⇒ the process is not consulted. */
export function presenceOf(
  record: SessionRecord, nowMs: number, pidAlive?: (pid: number) => boolean,
): SessionPresence {
  if (record.endedAt) return 'ended';
  if (record.pid && pidAlive) {
    let alive = true;
    try { alive = pidAlive(record.pid); } catch { alive = true; }
    if (!alive) return 'ended';
  }
  const seen = Date.parse(record.lastSeen);
  if (!Number.isFinite(seen) || nowMs - seen > LIVE_WINDOW_MS) return 'unknown';
  return 'live';
}

export type LockLike = { slug: string; phase: number; owner: string; session?: string; claimedAt?: number };

/**
 * Which plan+phase a session is working. STRONG: a lock whose `session=` is
 * this session (the newest claim wins). WEAK: a lock owned by `<user>@<host>`
 * (phase-lock.sh's default owner for a person) claimed while the session was
 * alive. Weak answers are for display; nothing releases a lock on them.
 */
export function correlate(record: SessionRecord, locks: readonly LockLike[], nowMs: number): SessionView['plan'] | undefined {
  const strong = locks
    .filter((lock) => lock.session === record.sessionId)
    .sort((a, b) => (b.claimedAt ?? 0) - (a.claimedAt ?? 0))[0];
  if (strong) return { slug: strong.slug, phase: strong.phase, strong: true };
  if (!record.user || !record.host) return undefined;
  const owner = `${record.user}@${record.host}`;
  const from = Date.parse(record.startedAt) - WEAK_CLAIM_SLACK_MS;
  const until = record.endedAt ? Date.parse(record.endedAt) : nowMs;
  const weak = locks
    .filter((lock) => lock.owner === owner && !lock.session)
    .filter((lock) => lock.claimedAt == null || (lock.claimedAt >= from && lock.claimedAt <= until))
    .sort((a, b) => (b.claimedAt ?? 0) - (a.claimedAt ?? 0))[0];
  return weak ? { slug: weak.slug, phase: weak.phase, strong: false } : undefined;
}

/* ------------------------------------------------------------------ *
 * Liveness probe
 * ------------------------------------------------------------------ */

const psCache = new Map<number, { at: number; alive: boolean }>();
const PS_CACHE_MS = 5_000;

/**
 * Is this pid a live `claude` (or node, for an npm-installed CLI)? `kill(0)`
 * first — the cheap, honest answer for "gone"; then `ps` for "still that
 * program" against pid reuse, cached a few seconds because the scheduler asks
 * per lock per scan. Any failure to ask reads as alive: the question is only
 * ever used to demote a lock to debris, and the safe direction is "not yet".
 */
export function claudePidAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  const hit = psCache.get(pid);
  const now = Date.now();
  if (hit && now - hit.at < PS_CACHE_MS) return hit.alive;
  let alive = true;
  try {
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    alive = comm === '' ? true : /claude|node|bun/i.test(comm);
  } catch { alive = true; }
  psCache.set(pid, { at: now, alive });
  return alive;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export type RegistryOptions = {
  /** `INSTANCE_STATE_DIR/sessions` — records as `<id>.json`, the hook's drops under `inbox/`. */
  dir: string;
  now?: () => Date;
  /** The liveness probe; `null` switches the process check off (tests). */
  pidAlive?: ((pid: number) => boolean) | null;
  /** Every change to a record: an ingested event, a prune. */
  onChange?: (record: SessionRecord, event: SessionEventName | 'prune') => void;
  /** A problem worth a log line (a corrupt file, a watcher error). */
  onWarn?: (what: string, detail: Record<string, unknown>) => void;
};

export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>();
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) { this.opts = opts; }

  get dir(): string { return this.opts.dir; }
  get inboxDir(): string { return join(this.opts.dir, 'inbox'); }

  private now(): Date { return this.opts.now?.() ?? new Date(); }

  /** Read what is on disk: the records, then whatever the hook dropped while the console was away. */
  load(): this {
    try { mkdirSync(this.inboxDir, { recursive: true }); } catch { /* a read-only state dir keeps an in-memory registry */ }
    let names: string[] = [];
    try { names = readdirSync(this.opts.dir); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.opts.dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionRecord>;
        if (typeof parsed.sessionId !== 'string' || !SESSION_ID_RE.test(parsed.sessionId)) throw new Error('not a session record');
        if (typeof parsed.startedAt !== 'string' || typeof parsed.lastSeen !== 'string' || typeof parsed.cwd !== 'string') {
          throw new Error('incomplete record');
        }
        this.records.set(parsed.sessionId, {
          ...parsed,
          sessionId: parsed.sessionId, cwd: parsed.cwd, startedAt: parsed.startedAt, lastSeen: parsed.lastSeen,
          kind: parsed.kind ?? kindOf(parsed.owner), turns: typeof parsed.turns === 'number' ? parsed.turns : 0,
        } as SessionRecord);
      } catch (error) {
        this.opts.onWarn?.('sessions.record-unreadable', { file, error: (error as Error).message });
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    }
    this.ingestInbox();
    this.prune();
    return this;
  }

  /** Watch the inbox (the hook's fallback) and poll it slowly in case the watcher is deaf. */
  start(): this {
    if (this.closed) return this;
    this.arm();
    this.poll = setInterval(() => { this.ingestInbox(); this.prune(); }, INBOX_POLL_MS);
    this.poll.unref?.();
    return this;
  }

  private arm(): void {
    if (this.watcher || this.closed) return;
    try {
      if (!existsSync(this.inboxDir)) mkdirSync(this.inboxDir, { recursive: true });
      this.watcher = watch(this.inboxDir, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { this.debounce = null; this.ingestInbox(); }, INBOX_DEBOUNCE_MS);
        this.debounce.unref?.();
      });
      // The watcher must never be what keeps the process alive: a console
      // shutting down, or a test that built a Service and never closed it.
      this.watcher.unref?.();
      this.watcher.on('error', (error) => {
        this.opts.onWarn?.('sessions.watcher-error', { dir: this.inboxDir, error: (error as Error).message });
        try { this.watcher?.close(); } catch { /* already gone */ }
        this.watcher = null;
        // Re-armed by the poll (which also ingests), so a lost watcher degrades to 30 s latency, never to silence.
      });
    } catch (error) {
      this.opts.onWarn?.('sessions.watch-failed', { dir: this.inboxDir, error: (error as Error).message });
      this.watcher = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    try { this.watcher?.close(); } catch { /* already gone */ }
    this.watcher = null;
  }

  /** Apply one event (from the route or the inbox), persist, announce. */
  ingest(payload: HookPayload): SessionRecord {
    const next = applyEvent(this.records.get(payload.session_id), payload, this.now().toISOString());
    this.records.set(next.sessionId, next);
    this.persist(next);
    this.opts.onChange?.(next, payload.event);
    return next;
  }

  /**
   * Drain the inbox: every drop, oldest first (by its own `at`, then the event
   * order start < stop < end, then the name), applied and deleted. A drop that
   * is not a payload is deleted too — junk in the inbox is nobody's.
   */
  ingestInbox(): number {
    if (!this.watcher && !this.closed) this.arm();
    let names: string[] = [];
    try { names = readdirSync(this.inboxDir).filter((n) => n.endsWith('.json')); } catch { return 0; }
    const drops: { file: string; payload: HookPayload; at: number; rank: number }[] = [];
    for (const name of names) {
      const file = join(this.inboxDir, name);
      let payload: HookPayload | null = null;
      try { payload = parseHookPayload(JSON.parse(readFileSync(file, 'utf8'))); } catch { payload = null; }
      if (!payload) {
        this.opts.onWarn?.('sessions.inbox-junk', { file });
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
        continue;
      }
      drops.push({
        file, payload,
        at: payload.at ? Date.parse(payload.at) : Number.MAX_SAFE_INTEGER,
        rank: EVENT_RANK[payload.event] ?? 9,
      });
    }
    drops.sort((a, b) => a.at - b.at || a.rank - b.rank || a.file.localeCompare(b.file));
    let n = 0;
    for (const drop of drops) {
      try { this.ingest(drop.payload); n++; } catch (error) {
        this.opts.onWarn?.('sessions.inbox-apply-failed', { file: drop.file, error: (error as Error).message });
      }
      try { rmSync(drop.file, { force: true }); } catch { /* best effort */ }
    }
    return n;
  }

  /** Forget ended records past their keep, and silent ones nobody has reported for a week. */
  prune(): number {
    const nowMs = this.now().getTime();
    let n = 0;
    for (const record of [...this.records.values()]) {
      const endedAgo = record.endedAt ? nowMs - Date.parse(record.endedAt) : null;
      const silentFor = nowMs - Date.parse(record.lastSeen);
      if ((endedAgo != null && endedAgo > RETAIN_ENDED_MS) || silentFor > RETAIN_SILENT_MS) {
        this.records.delete(record.sessionId);
        try { rmSync(join(this.opts.dir, `${record.sessionId}.json`), { force: true }); } catch { /* best effort */ }
        this.opts.onChange?.(record, 'prune');
        n++;
      }
    }
    return n;
  }

  get(sessionId: string): SessionRecord | undefined { return this.records.get(sessionId); }

  /** Live first, then by most recently seen. */
  list(): SessionRecord[] {
    const nowMs = this.now().getTime();
    return [...this.records.values()].sort((a, b) => {
      const la = this.presenceOfRecord(a, nowMs) === 'live' ? 0 : 1;
      const lb = this.presenceOfRecord(b, nowMs) === 'live' ? 0 : 1;
      return la - lb || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
    });
  }

  presence(sessionId: string): SessionPresence {
    const record = this.records.get(sessionId);
    return record ? this.presenceOfRecord(record, this.now().getTime()) : 'unknown';
  }

  /** The scheduler's question: the presence of the session a lock names; `unknown` for a lock that names none. */
  presenceOfLock(lock: { session?: string }): SessionPresence {
    return lock.session ? this.presence(lock.session) : 'unknown';
  }

  /** The API's answer: every record with its presence and the plan+phase it works. */
  views(locks: readonly LockLike[] = []): SessionView[] {
    const nowMs = this.now().getTime();
    return this.list().map((record) => {
      const plan = correlate(record, locks, nowMs);
      return { ...record, presence: this.presenceOfRecord(record, nowMs), ...(plan ? { plan } : {}) };
    });
  }

  private presenceOfRecord(record: SessionRecord, nowMs: number): SessionPresence {
    const probe = this.opts.pidAlive === null ? undefined : (this.opts.pidAlive ?? claudePidAlive);
    return presenceOf(record, nowMs, probe);
  }

  private persist(record: SessionRecord): void {
    const file = join(this.opts.dir, `${record.sessionId}.json`);
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      this.opts.onWarn?.('sessions.persist-failed', { file, error: (error as Error).message });
    }
  }
}
