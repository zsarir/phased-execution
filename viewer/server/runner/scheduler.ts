/**
 * Who is allowed to run right now.
 *
 * Concurrency in this console is not "how many sessions may exist" — it is
 * "which sessions can safely exist *together*". Two phases that touch
 * different repositories cannot collide however hard they try; two that touch
 * the same one will, and the collision is two agents writing one working tree,
 * which is the failure this whole mechanism exists to prevent. So admission is
 * decided by SCOPE (the plan's Repos column, read through `shared/scope.js`),
 * not by counting.
 *
 * One scheduler owns every admission decision in the process. That is
 * deliberate: the check has to see all of it — every lane of every run, plus
 * every lock on disk written by a bash session or a human — or it is not a
 * check, it is a hope. A second decision-maker with a partial view would admit
 * exactly the pair the first one refused.
 *
 * ## What it is not
 *
 * It has **no persistence of its own**. The pending `admit()` promises ARE the
 * queue; a console restart loses them, which is correct, because the runs they
 * belonged to lost their loops at the same moment. The durable shadow is the
 * run's own `status: 'queued'` checkpoint — and a queued run is the one thing
 * `Service.open()` may re-adopt unasked, precisely because by definition it did
 * nothing.
 *
 * ## Fairness
 *
 * A plain FIFO stalls: a wide `all`-scoped phase at the head blocks a hundred
 * disjoint ones behind it for as long as it waits. So the scan is **first-fit**
 * — a blocked head never stalls a disjoint tail. Pure first-fit starves,
 * though, which is the opposite failure and a worse one, because it is silent:
 * the wide phase waits forever while narrow ones stream past it. The bound is
 * **aging**: once an entry has been bypassed by enough intersecting work, or
 * has simply waited long enough, it RESERVES its tokens against everything
 * behind it and the queue drains toward it. Bounded bypass, not free bypass.
 */

import { randomUUID } from 'node:crypto';

import { scopesIntersect, intersectingTokens, formatScope } from '../../shared/scope.js';
import { DEFAULT_MAX_SESSIONS } from '../config.ts';
import { log } from '../log.ts';

/** How many later intersecting entries may be admitted past a blocked one. */
export const MAX_BYPASS = 4;
/** …and how long it may wait regardless, before it reserves. */
export const AGING_MS = 10 * 60_000;
/** A quiet re-check, so nothing waits on an event that never comes. */
const IDLE_POLL_MS = 60_000;

export { DEFAULT_MAX_SESSIONS };

/** A live claim on a scope. Held by a lane for as long as its session runs. */
export type ScopeGrant = {
  id: string;
  slug: string;
  /** Null for an admission that is not about one phase (a recovery session). */
  phase: number | null;
  runId: string;
  scope: string[];
  at: number;
};

export type AdmitRequest = {
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  /**
   * Which Claude account this admission would spend. Absent means the machine
   * login. The throttle is keyed by this: one account hitting its window must
   * not stall a run that pays with a different one.
   */
  accountId?: string;
  /** The run's abort signal — a Stop must not leave admissions pending. */
  signal?: AbortSignal;
};

/** What is standing in an entry's way, in the words the queue page shows. */
export type Holder = {
  kind: 'grant' | 'lock' | 'reserved';
  slug: string;
  phase: number | null;
  owner: string;
  scope: string[];
  /** Which tokens actually collided — the *why*, not just the *that*. */
  overlaps: string[];
  /**
   * When a `lock` holder's lease lapses (ms epoch). The queue page turns it
   * into "lease ends <t>", and the lock timer wakes the scan at the soonest
   * one — a foreign lock's release is the one event this process may never
   * hear otherwise.
   */
  leaseUntil?: number;
};

export type QueueEntry = {
  id: string;
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  /** The account the admission spends — see `AdmitRequest.accountId`. */
  accountId?: string;
  since: number;
  waitingOn: Holder[];
  /** Later intersecting entries admitted past this one. Bounded by `MAX_BYPASS`. */
  bypassed: number;
  /** Aged out — its tokens now block everything behind it. */
  reserving: boolean;
};

/** A lock on disk, as the store already reads it. Scope absent = never declared. */
export type LockView = {
  slug: string;
  phase: number;
  owner: string;
  expired: boolean;
  scope?: string[];
  /**
   * `lease_until` from the lock file, ms epoch. The `expired` bit above is
   * frozen at store-scan time; this lets the scheduler decide expiry by the
   * clock instead, so a lease that lapses between docs refreshes stops
   * blocking the moment it lapses.
   */
  leaseUntil?: number;
};

export type SchedulerDeps = {
  /** Lanes allowed live at once, read per call so a settings change lands. */
  max?: number | (() => number);
  /**
   * Every lock on disk, across ALL plans. Synchronous on purpose: the store
   * already holds them and refreshes on the docs watcher, and an async read
   * here would open a window between deciding and granting in which the answer
   * could change — which is the one thing an admission check may not do.
   */
  locks?: () => readonly LockView[];
  /**
   * A phase's declared scope, from the plan's Repos column.
   *
   * Used for a lock that carries no `scope=` line. `phase-lock.sh conflicts`
   * treats such a lock as UNKNOWN and collides with everything, because bash
   * cannot always resolve the plan; the console can, and recovering the
   * declaration the claim would have written is not a weakening — it is the
   * same SSOT, read from the other end. An unknown plan still falls back to
   * `all`, so uncertainty keeps its fail-safe direction.
   */
  scopeFor?: (slug: string, phase: number) => string[] | undefined;
  now?: () => number;
  /** Called whenever the queue or the grant set changed. Drives `run:queue`. */
  onChange?: (snapshot: SchedulerSnapshot) => void;
  /**
   * The repository guard — whether CROSS-RUN scope conflicts block admission.
   * Read per call, like `max`, so a preference flip lands on the next poll.
   * Absent means on: serializing overlapping runs is the safe state and must
   * be the silent one. With the guard off, only a run's own lanes still
   * serialize against each other — two lanes of one run in one checkout are
   * still two agents in one tree — while foreign grants, on-disk locks and
   * other runs' reserved tokens stop blocking. The cap and the usage-window
   * throttle are about the machine and the account, not about scopes, so they
   * hold either way.
   */
  guard?: () => boolean;
};

export type SchedulerSnapshot = {
  max: number;
  live: number;
  queued: number;
  /**
   * The SOONEST-ending throttle across every account, kept for older readers
   * that predate per-account windows: "something is throttled" stays true.
   */
  throttledUntil: number | null;
  /** Every account currently told to come back later, with when. */
  throttledAccounts: { accountId: string; until: number }[];
  grants: ScopeGrant[];
  entries: QueueEntry[];
  /** Whether cross-run scope conflicts currently block admission. */
  guard: boolean;
};

/** Thrown into a pending `admit()` when the run it belonged to was stopped. */
export class AdmissionAborted extends Error {
  constructor(slug: string, phase: number | null) {
    super(`admission for ${slug}${phase == null ? '' : ` phase ${phase}`} was cancelled`);
    this.name = 'AdmissionAborted';
  }
}

/** How a run's own locks are owned, so the scheduler never blocks on itself. */
export function autopilotOwner(runId: string): string {
  return `autopilot/${runId}`;
}

type Waiting = QueueEntry & {
  resolve: (grant: ScopeGrant) => void;
  reject: (error: Error) => void;
  /** Removes the abort listener; called on every exit path. */
  detach: () => void;
  settled: boolean;
};

export class Scheduler {
  private deps: SchedulerDeps;
  private grants = new Map<string, ScopeGrant>();
  private queue: Waiting[] = [];
  /**
   * Per-ACCOUNT "come back at" marks, keyed by accountId (`default` for the
   * machine login). A scalar until multi-account existed — and the scalar was
   * right then: one account, one window. With several, a limited account must
   * hold back only the entries that would spend it.
   */
  private throttled = new Map<string, number>();
  private throttleTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Armed at the soonest lease expiry among blocking locks. See `armLockTimer`. */
  private lockTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(deps: SchedulerDeps = {}) {
    this.deps = deps;
    this.armIdleTimer();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private maxLive(): number {
    const max = typeof this.deps.max === 'function' ? this.deps.max() : this.deps.max;
    return Math.max(1, max ?? DEFAULT_MAX_SESSIONS);
  }

  /* ---------------------------------------------------------------- *
   * Admission
   * ---------------------------------------------------------------- */

  /**
   * Ask to run. Resolves with a grant the caller must `release`, or rejects if
   * the run was stopped while it waited.
   *
   * Never resolves synchronously even when the scope is clear: a caller that
   * sometimes continues in the same tick and sometimes does not is a caller
   * with two control flows, and the second one is the one nobody tests.
   */
  admit(request: AdmitRequest): Promise<ScopeGrant> {
    if (this.closed) return Promise.reject(new AdmissionAborted(request.slug, request.phase));
    const scope = request.scope.length ? [...request.scope] : ['all'];

    return new Promise<ScopeGrant>((resolve, reject) => {
      const entry: Waiting = {
        id: randomUUID().slice(0, 8),
        slug: request.slug,
        phase: request.phase,
        runId: request.runId,
        scope,
        ...(request.accountId ? { accountId: request.accountId } : {}),
        since: this.now(),
        waitingOn: [],
        bypassed: 0,
        reserving: false,
        resolve,
        reject,
        detach: () => {},
        settled: false,
      };

      const signal = request.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new AdmissionAborted(entry.slug, entry.phase));
          return;
        }
        const onAbort = (): void => this.cancel(entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(entry);
      // A tick later, so the caller's promise exists before it can settle.
      queueMicrotask(() => this.poll());
    });
  }

  /**
   * Would this request have to wait — asked without joining the queue.
   *
   * The same scan `poll` runs, so the two cannot disagree. It exists because
   * "queued" has to be *observable*: `admit()` resolves asynchronously either
   * way, so without asking first, a run blocked behind another plan spends its
   * whole wait reading `running` and the operator is left watching a phase
   * that never starts with nothing anywhere saying why.
   */
  wouldBlock(request: AdmitRequest): Holder[] {
    const throttle = this.throttleFor(request.accountId);
    if (throttle) return [throttle];
    if (this.grants.size >= this.maxLive()) {
      return [{
        kind: 'reserved', slug: 'session cap', phase: null,
        owner: `${this.maxLive()} of ${this.maxLive()} lanes`, scope: ['all'], overlaps: ['all'],
      }];
    }
    const probe: Waiting = {
      id: '', slug: request.slug, phase: request.phase, runId: request.runId,
      scope: request.scope.length ? request.scope : ['all'],
      ...(request.accountId ? { accountId: request.accountId } : {}),
      since: this.now(), waitingOn: [], bypassed: 0, reserving: false,
      resolve: () => {}, reject: () => {}, detach: () => {}, settled: false,
    };
    return this.blocking(probe, this.queue.filter((entry) => entry.reserving));
  }

  /**
   * The holder that says "this ACCOUNT was told to come back later", or null.
   * Phrased as a reserved pseudo-holder so the queue page renders it with the
   * same vocabulary as every other reason to wait.
   */
  private throttleFor(accountId: string | undefined): Holder | null {
    const key = accountId ?? 'default';
    const until = this.throttled.get(key);
    if (!until || until <= this.now()) return null;
    return {
      kind: 'reserved', slug: 'usage window', phase: null,
      owner: key === 'default' ? 'the account' : `account ${key}`,
      scope: ['all'], overlaps: ['all'],
    };
  }

  /**
   * Cross-run holders sharing tokens with this request RIGHT NOW — grants of
   * other runs, and locks this console never issued. Never queues, and never
   * consults the guard: this is the honesty probe that lets a prompt say "you
   * are sharing a checkout with someone" even when the guard was turned off,
   * or when a foreign lock appeared after admission.
   */
  overlapsFor(request: AdmitRequest): Holder[] {
    const probe: Waiting = {
      id: '', slug: request.slug, phase: request.phase, runId: request.runId,
      scope: request.scope.length ? request.scope : ['all'],
      since: this.now(), waitingOn: [], bypassed: 0, reserving: false,
      resolve: () => {}, reject: () => {}, detach: () => {}, settled: false,
    };
    const own = autopilotOwner(request.runId);
    return this.conflictsFor(probe, []).filter((holder) => holder.owner !== own);
  }

  /** Hand a grant back. The only thing that lets the queue move on its own. */
  release(grant: ScopeGrant | null | undefined): void {
    if (!grant) return;
    if (!this.grants.delete(grant.id)) return;
    this.poll();
  }

  /**
   * Everything a run holds or is waiting for, dropped at once.
   *
   * A run that ends with a lane still granted — a crash inside `drive`, a
   * shutdown mid-phase — would otherwise hold its scope against every other
   * plan until the process died. The grant is bookkeeping, not a resource: the
   * only thing that made it real was the loop, and the loop is gone.
   */
  releaseRun(runId: string): void {
    let touched = false;
    for (const [id, grant] of [...this.grants]) {
      if (grant.runId !== runId) continue;
      this.grants.delete(id);
      touched = true;
    }
    for (const entry of [...this.queue]) {
      if (entry.runId !== runId) continue;
      this.cancel(entry, false);
      touched = true;
    }
    if (touched) this.poll();
  }

  /**
   * Admit nothing FOR THIS ACCOUNT until this moment passes.
   *
   * The usage window is an account-wide fact, not a per-run one: when one
   * session is told to come back at 4pm, every other session on the same
   * account would be told the same thing one turn later, each spending a turn
   * to find out. `wait-until` calls this so the rest of that account's fleet
   * waits quietly rather than discovering it the expensive way — while a run
   * paying with a DIFFERENT account is exactly the run that should keep going.
   */
  throttle(untilMs: number, accountId = 'default'): void {
    if (!Number.isFinite(untilMs) || untilMs <= this.now()) return;
    const current = this.throttled.get(accountId);
    if (current && current >= untilMs) return;
    this.throttled.set(accountId, untilMs);
    log.info('scheduler.throttled', { account: accountId, until: new Date(untilMs).toISOString() });
    this.armThrottleTimer();
    this.announce();
  }

  /** Re-run the scan. Safe to call from anything that might have freed a scope. */
  poll(): void {
    if (this.closed) return;
    const now = this.now();

    // Expired marks come off first, so a window that reopened admits on this
    // very scan rather than on the one after.
    for (const [accountId, until] of [...this.throttled]) {
      if (until <= now) this.throttled.delete(accountId);
    }
    if (this.throttled.size) this.armThrottleTimer();

    let changed = false;
    /** Token sets held back by aged entries ahead in the queue. */
    const reserved: Waiting[] = [];
    /** Blocked entries already passed, so an admission can count its bypass. */
    const blocked: Waiting[] = [];

    for (const entry of [...this.queue]) {
      if (entry.settled) continue;
      // The cap is a hard stop, not a skip: nothing further down can start
      // either, and scanning on would only mislabel the rest as scope-blocked.
      if (this.grants.size >= this.maxLive()) break;

      // A throttled ACCOUNT is a skip, not a stop — the old scalar returned
      // here, which was right when there was one account and would now let a
      // single limited login stall every other account's queue. The entry is
      // labeled with why it waits, and deliberately never ages into
      // `reserving`: its blockage is a clock, not scope contention, and a
      // reserving throttled entry would hold its tokens against runs that
      // could pay.
      const throttle = this.throttleFor(entry.accountId);
      if (throttle) {
        entry.waitingOn = [throttle];
        continue;
      }

      const holders = this.blocking(entry, reserved);
      if (holders.length) {
        entry.waitingOn = holders;
        blocked.push(entry);
        if (this.aging(entry, now)) {
          if (!entry.reserving) changed = true;
          entry.reserving = true;
          reserved.push(entry);
        }
        continue;
      }

      // Admitting this one means every blocked entry ahead of it that shares a
      // token has just been overtaken. Counted here — at the moment it happens
      // — because that is the only place the pair is known.
      for (const earlier of blocked) {
        if (scopesIntersect(earlier.scope, entry.scope)) earlier.bypassed++;
      }
      this.grant(entry);
      changed = true;
    }

    this.armLockTimer();
    if (changed) this.announce();
  }

  /** Everything the queue page and `state().concurrency` read. */
  snapshot(): SchedulerSnapshot {
    const now = this.now();
    const throttledAccounts = [...this.throttled]
      .filter(([, until]) => until > now)
      .map(([accountId, until]) => ({ accountId, until }))
      .sort((a, b) => a.until - b.until);
    return {
      max: this.maxLive(),
      guard: this.deps.guard?.() ?? true,
      live: this.grants.size,
      queued: this.queue.filter((entry) => !entry.settled).length,
      throttledUntil: throttledAccounts[0]?.until ?? null,
      throttledAccounts,
      grants: [...this.grants.values()],
      entries: this.queue.filter((entry) => !entry.settled).map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        phase: entry.phase,
        runId: entry.runId,
        scope: entry.scope,
        since: entry.since,
        waitingOn: entry.waitingOn,
        bypassed: entry.bypassed,
        reserving: entry.reserving,
      })),
    };
  }

  /** Is anything of this run's already granted? Used by the same-slug guard. */
  granted(runId: string): ScopeGrant[] {
    return [...this.grants.values()].filter((grant) => grant.runId === runId);
  }

  close(): void {
    this.closed = true;
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.throttleTimer = null;
    this.idleTimer = null;
    this.lockTimer = null;
    for (const entry of [...this.queue]) this.cancel(entry, false);
    this.grants.clear();
  }

  /* ---------------------------------------------------------------- *
   * The conflict scan
   * ---------------------------------------------------------------- */

  /**
   * What actually blocks this entry, guard consulted. `poll` and `wouldBlock`
   * both come through here so they cannot disagree about what "queued" means.
   * With the guard off, the only holders that still block are the entry's own
   * run's — its other lanes and their reservations — because turning the guard
   * off is a statement about OTHER runs, not permission for one run to stack
   * two lanes into one checkout.
   */
  private blocking(entry: Waiting, reserved: readonly Waiting[]): Holder[] {
    const holders = this.conflictsFor(entry, reserved);
    if (this.deps.guard?.() ?? true) return holders;
    const own = autopilotOwner(entry.runId);
    return holders.filter((holder) => holder.owner === own);
  }

  /**
   * Everything this entry collides with, or an empty list if it may start.
   *
   * Three sources, and all three matter: the grants this process handed out,
   * the locks on disk (which include sessions this console never started — a
   * human in a terminal, a bash worker), and the tokens reserved by aged
   * entries ahead of it.
   */
  private conflictsFor(entry: Waiting, reserved: readonly Waiting[]): Holder[] {
    const holders: Holder[] = [];

    for (const grant of this.grants.values()) {
      if (grant.runId === entry.runId && grant.phase === entry.phase) continue;
      if (!scopesIntersect(grant.scope, entry.scope)) continue;
      holders.push({
        kind: 'grant',
        slug: grant.slug,
        phase: grant.phase,
        owner: autopilotOwner(grant.runId),
        scope: grant.scope,
        overlaps: intersectingTokens(grant.scope, entry.scope),
      });
    }

    const own = autopilotOwner(entry.runId);
    for (const lock of this.deps.locks?.() ?? []) {
      if (this.lockLapsed(lock)) continue;
      // Our own run's locks. Its other lanes claimed them, and the grants above
      // already speak for those.
      if (lock.owner === own) continue;
      // A foreign lock on the very slug+phase being requested blocks like any
      // other. This used to be carved out ("the boarding belt-check parks on
      // it with the holder's name") — and the park was TERMINAL: parked is a
      // settled status, so a phase somebody was working by hand never boarded
      // again for the life of the run. Queueing is not a silent wait any
      // more: the holder is named on the queue page with its lease end, the
      // lock timer wakes the scan when the lease lapses, the docs watcher
      // wakes it when the lock file changes, and the runner's own lock-wait
      // cap turns a wait that outlives all of that into an honest park.

      const scope = this.scopeOfLock(lock);
      if (!scopesIntersect(scope, entry.scope)) continue;
      holders.push({
        kind: 'lock',
        slug: lock.slug,
        phase: lock.phase,
        owner: lock.owner,
        scope,
        overlaps: intersectingTokens(scope, entry.scope),
        ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
      });
    }

    for (const ahead of reserved) {
      if (ahead.id === entry.id) continue;
      if (!scopesIntersect(ahead.scope, entry.scope)) continue;
      holders.push({
        kind: 'reserved',
        slug: ahead.slug,
        phase: ahead.phase,
        owner: autopilotOwner(ahead.runId),
        scope: ahead.scope,
        overlaps: intersectingTokens(ahead.scope, entry.scope),
      });
    }

    return holders;
  }

  /**
   * Expiry decided by the clock, not by the bit the store froze at scan time.
   * A lease that lapsed since the last docs refresh must stop blocking NOW —
   * otherwise a dead claim holds the queue until an unrelated file changes.
   */
  private lockLapsed(lock: LockView): boolean {
    if (lock.expired) return true;
    return lock.leaseUntil != null && lock.leaseUntil <= this.now();
  }

  /**
   * What a lock covers. See `SchedulerDeps.scopeFor` for why a scopeless lock
   * is recovered from the plan rather than read as `all` outright.
   */
  private scopeOfLock(lock: LockView): string[] {
    if (lock.scope?.length) return lock.scope;
    const declared = this.deps.scopeFor?.(lock.slug, lock.phase);
    return declared?.length ? declared : ['all'];
  }

  private aging(entry: Waiting, now: number): boolean {
    return entry.bypassed >= MAX_BYPASS || now - entry.since >= AGING_MS;
  }

  /* ---------------------------------------------------------------- *
   * Bookkeeping
   * ---------------------------------------------------------------- */

  private grant(entry: Waiting): void {
    const grant: ScopeGrant = {
      id: entry.id,
      slug: entry.slug,
      phase: entry.phase,
      runId: entry.runId,
      scope: entry.scope,
      at: this.now(),
    };
    this.grants.set(grant.id, grant);
    this.settle(entry);
    log.info('scheduler.admitted', {
      slug: entry.slug, phase: entry.phase, runId: entry.runId,
      scope: formatScope(entry.scope), waitedMs: this.now() - entry.since,
    });
    entry.resolve(grant);
  }

  private cancel(entry: Waiting, announce = true): void {
    if (entry.settled) return;
    this.settle(entry);
    entry.reject(new AdmissionAborted(entry.slug, entry.phase));
    if (announce) this.announce();
  }

  private settle(entry: Waiting): void {
    entry.settled = true;
    entry.detach();
    const at = this.queue.indexOf(entry);
    if (at >= 0) this.queue.splice(at, 1);
  }

  private announce(): void {
    try { this.deps.onChange?.(this.snapshot()); } catch { /* the UI must never break admission */ }
  }

  /**
   * Wake at the SOONEST throttle expiry. `poll()` prunes whatever has lapsed
   * and re-arms for the next one, so several accounts with different resets
   * each get their scan the moment their own window reopens.
   */
  private armThrottleTimer(): void {
    if (this.throttleTimer || !this.throttled.size) return;
    const soonest = Math.min(...this.throttled.values());
    const delay = Math.max(0, soonest - this.now());
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.poll();
    }, delay);
    this.throttleTimer.unref?.();
  }

  /**
   * Wake at the SOONEST lease expiry among the locks currently blocking the
   * queue. A foreign on-disk lock is the one holder whose release this
   * process may never hear about — the holder is a manual session, another
   * console, another machine — but the lease is its promise to lapse, and
   * this timer turns that promise into an admission the moment it does,
   * instead of a wait for the idle poll or an unrelated docs event. Re-armed
   * on every poll because the blocking set changes under it.
   */
  private armLockTimer(): void {
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
    if (this.closed) return;
    let soonest = Infinity;
    for (const entry of this.queue) {
      if (entry.settled) continue;
      for (const holder of entry.waitingOn) {
        if (holder.kind !== 'lock' || holder.leaseUntil == null) continue;
        if (holder.leaseUntil < soonest) soonest = holder.leaseUntil;
      }
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(0, soonest - this.now());
    this.lockTimer = setTimeout(() => {
      this.lockTimer = null;
      this.poll();
    }, delay);
    this.lockTimer.unref?.();
  }

  /**
   * The backstop. Every other wakeup is an event — a release, a lock change, a
   * run ending — and an admission that waits on an event which never arrives
   * waits forever. Ten minutes of aging only helps if something looks again.
   */
  private armIdleTimer(): void {
    this.idleTimer = setInterval(() => this.poll(), IDLE_POLL_MS);
    this.idleTimer.unref?.();
  }
}
