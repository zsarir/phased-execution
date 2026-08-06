/**
 * The usage poller — the same numbers `/usage` shows, per account, on a clock.
 *
 * The endpoint is the one the Claude CLI itself asks (`/api/oauth/usage`), and
 * it is not a documented public API — so everything about this file is built
 * to degrade: answers are cached and served stale with their age attached, a
 * refusal today does not erase what was known this morning, and an endpoint
 * that stops existing turns the meters into "no usage data" rather than an
 * error page. The runner's own limit classifier keeps working regardless; this
 * poller is telemetry, never the detector.
 *
 * Three hard-won facts shape the requests:
 *  - The `User-Agent` must look like the CLI (`claude-code/<version>`) or the
 *    request lands in an aggressively rate-limited bucket and everything is a
 *    429 forever.
 *  - Bucket names are data, not schema: `five_hour`, `seven_day`,
 *    `seven_day_opus` today, whatever tier ships next tomorrow. Anything with
 *    a `utilization` number and a `resets_at` time is a meter.
 *  - Polling cadence is a courtesy budget. Accounts with a live session get
 *    ~90s freshness; idle and exhausted ones are looked at every ten minutes;
 *    failures back off exponentially and 429s back off harder.
 */

import { realExec, type Exec } from './credentials.ts';

export type UsageBucket = {
  /** Percent, 0–100 — NOT the 0–1 fraction the CLI's rate_limit_event uses. */
  utilization: number;
  /** ISO 8601, straight from the endpoint. */
  resetsAt: string;
};

export type AccountUsage = {
  buckets: Record<string, UsageBucket>;
  fetchedAt: string;
  /**
   * The endpoint refused this credential in a way retrying will not fix
   * (a setup-token the usage API does not serve). Distinct from `error`,
   * which is weather.
   */
  unsupported?: boolean;
  error?: string;
};

/** What the facade hands the poller when asked for a way in. */
export type TokenAnswer =
  | { token: string; /** 401/403 mean "this credential kind is not served", not "signed out". */ tokenKind?: 'setup-token' }
  | { error: string }
  | null;

export type UsagePollerOptions = {
  resolveToken: (accountId: string) => Promise<TokenAnswer>;
  onUpdate?: (accountId: string, usage: AccountUsage) => void;
  /** Does this account have a live session right now? Drives cadence. */
  isActive?: (accountId: string) => boolean;
  fetchFn?: typeof fetch;
  exec?: Exec;
  /** Test override; defaults to PHASE_CONSOLE_USAGE_BASE, then the real host. */
  base?: string;
  now?: () => number;
};

const ACTIVE_MS = 90_000;
const IDLE_MS = 10 * 60_000;
const ERROR_BASE_MS = 60_000;
const ERROR_CAP_MS = 30 * 60_000;
/** A meter at or past this reads as exhausted — no point asking often. */
const EXHAUSTED_PCT = 99;

export class UsagePoller {
  private readonly opts: Required<Pick<UsagePollerOptions, 'resolveToken'>> & UsagePollerOptions;
  private readonly base: string;
  private readonly cache = new Map<string, AccountUsage>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private version: string | null = null;
  private stopped = false;

  constructor(opts: UsagePollerOptions) {
    this.opts = opts;
    this.base = (opts.base ?? process.env.PHASE_CONSOLE_USAGE_BASE ?? 'https://api.anthropic.com')
      .replace(/\/+$/, '');
  }

  /** Last-known answer, however old. The age is the caller's to display. */
  snapshot(accountId: string): AccountUsage | undefined {
    return this.cache.get(accountId);
  }

  track(accountId: string): void {
    if (this.stopped || this.timers.has(accountId)) return;
    // First look soon but not instantly — startup spawns enough already.
    this.schedule(accountId, 2_000);
  }

  untrack(accountId: string): void {
    const timer = this.timers.get(accountId);
    if (timer) clearTimeout(timer);
    this.timers.delete(accountId);
    this.cache.delete(accountId);
    this.failures.delete(accountId);
  }

  /** Ask now — a run just started, a login just completed. */
  kick(accountId: string): void {
    if (this.stopped) return;
    this.schedule(accountId, 0);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(accountId: string, delayMs: number): void {
    const existing = this.timers.get(accountId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void this.poll(accountId); }, delayMs);
    timer.unref?.();
    this.timers.set(accountId, timer);
  }

  private async poll(accountId: string): Promise<void> {
    if (this.stopped) return;
    // Single-flight: a kick landing mid-request rides the request.
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const work = this.pollOnce(accountId).finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, work);
    return work;
  }

  private async pollOnce(accountId: string): Promise<void> {
    let nextMs = this.cadence(accountId);
    try {
      const answer = await this.opts.resolveToken(accountId);
      if (!answer) {
        // Nothing to ask with — not signed in yet, profile mid-login. Quietly
        // idle-cadence; the facade kicks when that changes.
        this.remember(accountId, { error: 'no credentials to ask with' });
      } else if ('error' in answer) {
        this.remember(accountId, { error: answer.error });
      } else {
        const outcome = await this.fetchUsage(answer.token);
        if (outcome.kind === 'ok') {
          this.failures.delete(accountId);
          this.remember(accountId, { buckets: outcome.buckets });
          nextMs = this.cadence(accountId);
        } else if (outcome.kind === 'refused') {
          if (answer.tokenKind === 'setup-token') {
            // Permanent for this credential kind — stop asking, keep the account.
            this.remember(accountId, { unsupported: true });
            this.untrackTimerOnly(accountId);
            return;
          }
          nextMs = this.backoff(accountId, 1);
          this.remember(accountId, { error: 'credential was refused — signed out, or the login is stale' });
        } else if (outcome.kind === 'rate-limited') {
          nextMs = this.backoff(accountId, 2);
          this.remember(accountId, { error: 'usage endpoint rate-limited this console' });
        } else {
          nextMs = this.backoff(accountId, 1);
          this.remember(accountId, { error: outcome.detail });
        }
      }
    } catch (error) {
      nextMs = this.backoff(accountId, 1);
      this.remember(accountId, { error: (error as Error).message });
    }
    if (!this.stopped && this.timers.has(accountId)) this.schedule(accountId, nextMs);
  }

  /** Drop the timer but keep the cache — `unsupported` is an answer, not a gap. */
  private untrackTimerOnly(accountId: string): void {
    const timer = this.timers.get(accountId);
    if (timer) clearTimeout(timer);
    this.timers.delete(accountId);
  }

  private cadence(accountId: string): number {
    if (this.opts.isActive?.(accountId)) {
      const cached = this.cache.get(accountId);
      const exhausted = cached && Object.values(cached.buckets).some((b) => b.utilization >= EXHAUSTED_PCT);
      return exhausted ? IDLE_MS : ACTIVE_MS;
    }
    return IDLE_MS;
  }

  private backoff(accountId: string, weight: number): number {
    const count = (this.failures.get(accountId) ?? 0) + weight;
    this.failures.set(accountId, count);
    return Math.min(ERROR_BASE_MS * 2 ** (count - 1), ERROR_CAP_MS);
  }

  /**
   * A failure keeps the old buckets and stamps the reason beside them; only a
   * success moves `fetchedAt`. Stale-and-said-so beats blank.
   */
  private remember(
    accountId: string,
    result: { buckets?: Record<string, UsageBucket>; error?: string; unsupported?: boolean },
  ): void {
    const previous = this.cache.get(accountId);
    const usage: AccountUsage = result.buckets
      ? { buckets: result.buckets, fetchedAt: new Date(this.now()).toISOString() }
      : {
          buckets: previous?.buckets ?? {},
          fetchedAt: previous?.fetchedAt ?? new Date(this.now()).toISOString(),
          ...(result.error ? { error: result.error } : {}),
          ...(result.unsupported ? { unsupported: true } : {}),
        };
    this.cache.set(accountId, usage);
    this.opts.onUpdate?.(accountId, usage);
  }

  private async fetchUsage(token: string): Promise<
    | { kind: 'ok'; buckets: Record<string, UsageBucket> }
    | { kind: 'refused' }
    | { kind: 'rate-limited' }
    | { kind: 'failed'; detail: string }
  > {
    const doFetch = this.opts.fetchFn ?? fetch;
    const response = await doFetch(`${this.base}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-code/${await this.claudeVersion()}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { kind: 'refused' };
    if (response.status === 429) return { kind: 'rate-limited' };
    if (!response.ok) return { kind: 'failed', detail: `usage endpoint answered ${response.status}` };
    const body = (await response.json()) as Record<string, unknown>;
    return { kind: 'ok', buckets: parseBuckets(body) };
  }

  /**
   * The UA version comes from the installed CLI, asked once. A console that
   * cannot run `claude --version` still polls — with the fallback the endpoint
   * has been seen to accept — rather than not polling at all.
   */
  private async claudeVersion(): Promise<string> {
    if (this.version) return this.version;
    try {
      const { stdout } = await (this.opts.exec ?? realExec)('claude', ['--version']);
      this.version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? '2.1.0';
    } catch {
      this.version = '2.1.0';
    }
    return this.version;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/**
 * Buckets are whatever the endpoint says they are. Anything object-shaped with
 * a numeric `utilization` and a string `resets_at` is a meter; keys are kept
 * verbatim so a `seven_day_fable` appears the day it exists.
 */
export function parseBuckets(body: Record<string, unknown>): Record<string, UsageBucket> {
  const buckets: Record<string, UsageBucket> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as { utilization?: unknown; resets_at?: unknown };
    if (typeof entry.utilization !== 'number' || typeof entry.resets_at !== 'string') continue;
    buckets[key] = {
      utilization: Math.max(0, Math.min(100, entry.utilization)),
      resetsAt: entry.resets_at,
    };
  }
  return buckets;
}
