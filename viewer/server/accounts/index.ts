/**
 * Accounts — the facade the rest of the console talks to.
 *
 * One object owns the registry (`store.ts`), the secrets and credential reads
 * (`credentials.ts`) and the meters (`usage.ts`), and everything it hands out
 * is REDACTED: an `AccountView` carries names, emails, plans and percentages,
 * never a token and never a path to one. The service streams these views to
 * the browser verbatim, so the redaction boundary is here, not in a route.
 *
 * The runner asks three questions and nothing else: `envFor(accountId)` when
 * spawning, `markLimited(...)` when a session hits a wall, and
 * `pickAccount(...)` when policy says switch. All three are answerable from
 * cache — the runner never waits on a keychain or the network mid-phase.
 */

import { rmSync, mkdirSync } from 'node:fs';

import { log } from '../log.ts';
import { parseAuth } from '../runner/auth.ts';
import {
  AccountStore, DEFAULT_ACCOUNT_ID, profileConfigDir,
  type AccountKind, type AccountMeta,
} from './store.ts';
import { Credentials, realExec, type Exec } from './credentials.ts';
import { UsagePoller, type AccountUsage, type TokenAnswer } from './usage.ts';

export { DEFAULT_ACCOUNT_ID, ACCOUNT_ID_RE, profileConfigDir } from './store.ts';
export type { AccountMeta, AccountKind } from './store.ts';
export type { AccountUsage, UsageBucket } from './usage.ts';

/**
 * Where an account's login stands. `unknown` is the honest word for a
 * setup-token — it exposes no expiry and no refresh, so the console can only
 * find out by spending it.
 */
export type AuthState = 'ok' | 'expiring' | 'expired' | 'signed-out' | 'unknown';

/** What leaves the server. No secrets, no filesystem paths. */
export type AccountView = {
  id: string;
  kind: AccountKind;
  /** True for the synthesized machine login — cannot be removed. */
  builtIn: boolean;
  name?: string;
  email?: string;
  org?: string;
  plan?: string;
  /** Profiles only: has anyone actually completed `claude auth login` in it? */
  signedIn?: boolean;
  /** Where this account's login stands, from the CLI's own credential. */
  authState?: AuthState;
  usage?: AccountUsage;
  limitedUntil?: Record<string, string>;
};

export type AccountsOptions = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  onChange?: () => void;
  /** Threshold crossings, for the announcer (W6). Percent, per bucket. */
  onThreshold?: (view: AccountView, bucket: string, level: 'warn' | 'alert', utilization: number, resetsAt: string) => void;
  /**
   * An account's login went from known-good to expired/signed-out. Fired once
   * per transition, never on first observation — a profile mid-login must not
   * raise "sign in again" before anyone has signed in at all.
   */
  onAuthChange?: (view: AccountView, state: AuthState) => void;
  usageBase?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

export const WARN_PCT = 80;
export const ALERT_PCT = 95;

/** How long an identity read (exec-backed on macOS) is trusted before re-asking. */
const IDENTITY_TTL_MS = 60_000;

/** Expiry closer than this reads as `expiring` — the CLI refresh window. */
const AUTH_EXPIRING_MS = 30 * 60_000;

type Identity = {
  email?: string; org?: string; plan?: string; signedIn: boolean; at: number;
  /** The oauth blob's own expiry, when one was readable. */
  expiresAt?: number;
};

/** Where a login-backed credential stands right now. */
function authStateOf(signedIn: boolean, expiresAt: number | undefined, now: number): AuthState {
  if (!signedIn) return 'signed-out';
  if (!expiresAt) return 'ok';
  if (expiresAt <= now) return 'expired';
  if (expiresAt <= now + AUTH_EXPIRING_MS) return 'expiring';
  return 'ok';
}

export class Accounts {
  private readonly store = new AccountStore();
  private readonly creds: Credentials;
  private readonly poller: UsagePoller;
  private readonly exec: Exec;
  private readonly identities = new Map<string, Identity>();
  /** The default account has no registry row; its learned windows live here. */
  private defaultLimits: Record<string, string> = {};
  /** Last announced threshold level per account:bucket, for hysteresis. */
  private announced = new Map<string, 'warn' | 'alert'>();
  /** Last observed auth state per account — the transition detector. */
  private auth = new Map<string, AuthState>();
  private isActive: (accountId: string) => boolean = () => false;
  private readonly opts: AccountsOptions;

  constructor(opts: AccountsOptions = {}) {
    this.opts = opts;
    this.exec = opts.exec ?? realExec;
    this.creds = new Credentials(this.exec, opts.platform ?? process.platform);
    this.poller = new UsagePoller({
      resolveToken: (id) => this.resolveToken(id),
      onUpdate: (id, usage) => this.usageUpdated(id, usage),
      isActive: (id) => this.isActive(id),
      exec: this.exec,
      ...(opts.usageBase ? { base: opts.usageBase } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  /** The runner tells us how to recognise an account with a live session. */
  setActiveProbe(probe: (accountId: string) => boolean): void {
    this.isActive = probe;
  }

  startPolling(): void {
    this.poller.track(DEFAULT_ACCOUNT_ID);
    for (const meta of this.store.stored()) this.poller.track(meta.id);
  }

  stop(): void {
    this.poller.stop();
  }

  /* ---------------- reading ---------------- */

  has(id: string): boolean {
    return id === DEFAULT_ACCOUNT_ID || Boolean(this.store.get(id));
  }

  meta(id: string): AccountMeta | undefined {
    if (id === DEFAULT_ACCOUNT_ID) {
      return {
        id: DEFAULT_ACCOUNT_ID, kind: 'default', createdAt: '',
        ...(this.store.defaultName ? { name: this.store.defaultName } : {}),
      };
    }
    return this.store.get(id);
  }

  /** Every account as the browser may see it. Identity reads are cached. */
  async list(): Promise<AccountView[]> {
    const views: AccountView[] = [await this.view(this.meta(DEFAULT_ACCOUNT_ID)!)];
    for (const meta of this.store.stored()) views.push(await this.view(meta));
    return views;
  }

  private async view(meta: AccountMeta): Promise<AccountView> {
    const identity = await this.identity(meta);
    const usage = this.poller.snapshot(meta.id);
    const limited = this.limitedUntil(meta.id);
    // Display the LAST OBSERVED state, never a recomputation: the identity
    // cache can be up to a minute staler than the poller's read, and a view
    // that recomputed from it un-noted a fresh `expired` — which made the
    // transition announce again on the next poll.
    const state = meta.kind === 'token'
      ? 'unknown'
      : this.auth.get(meta.id) ?? authStateOf(identity.signedIn, identity.expiresAt, Date.now());
    return {
      id: meta.id,
      kind: meta.kind,
      builtIn: meta.id === DEFAULT_ACCOUNT_ID,
      ...(meta.name ? { name: meta.name } : {}),
      ...(identity.email ? { email: identity.email } : meta.email ? { email: meta.email } : {}),
      ...(identity.org ? { org: identity.org } : {}),
      ...(identity.plan ? { plan: identity.plan } : meta.plan ? { plan: meta.plan } : {}),
      ...(meta.kind === 'profile' ? { signedIn: identity.signedIn } : {}),
      authState: state,
      ...(usage ? { usage } : {}),
      ...(Object.keys(limited).length ? { limitedUntil: limited } : {}),
    };
  }

  /**
   * Who a login-backed account belongs to, from the CLI's own files — cheap
   * enough to keep fresh, exec-backed enough to cache. Token accounts have no
   * identity beyond the name the operator gave them (the whole reason the add
   * flow demands a name).
   */
  private async identity(meta: AccountMeta): Promise<Identity> {
    if (meta.kind === 'token') return { signedIn: true, at: 0 };
    const cached = this.identities.get(meta.id);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached;
    const configDir = meta.kind === 'profile' ? profileConfigDir(meta.id) : null;
    const who = this.creds.readIdentity(configDir);
    const oauth = await this.creds.readClaudeOauth(configDir);
    const identity: Identity = {
      ...(who?.email ? { email: who.email } : {}),
      ...(who?.org ? { org: who.org } : {}),
      ...(oauth?.subscriptionType ? { plan: oauth.subscriptionType } : {}),
      signedIn: Boolean(oauth),
      at: Date.now(),
      ...(oauth?.expiresAt ? { expiresAt: oauth.expiresAt } : {}),
    };
    this.identities.set(meta.id, identity);
    // A FRESH credential read is an auth observation; a cache hit is not.
    this.noteAuth(meta.id, authStateOf(identity.signedIn, identity.expiresAt, Date.now()));
    return identity;
  }

  /**
   * Record an observed auth state; announce only the transition INTO a broken
   * state FROM a known-good one. First observation never fires (a fresh
   * profile mid-login must not raise "sign in again"), and the poller's own
   * refresh attempt runs before its reads land here, so a login the CLI can
   * still refresh never presents as broken at all.
   */
  private noteAuth(id: string, state: AuthState): void {
    const before = this.auth.get(id);
    if (before === state) return;
    this.auth.set(id, state);
    this.changed();
    const broken = state === 'expired' || state === 'signed-out';
    const wasGood = before === 'ok' || before === 'expiring';
    if (broken && wasGood && this.opts.onAuthChange) {
      const meta = this.meta(id);
      if (meta) void this.view(meta).then((view) => this.opts.onAuthChange?.(view, state));
    }
  }

  /** Last observed login state, for callers that only need the word. */
  authStateFor(accountId: string | undefined): AuthState | undefined {
    return this.auth.get(accountId ?? DEFAULT_ACCOUNT_ID);
  }

  /* ---------------- registration ---------------- */

  /**
   * A pasted `claude setup-token`. Validated by shape only — the token is
   * proven the first time something runs under it, and the usage poller will
   * say `unsupported` if the endpoint refuses the kind. The name is required
   * because a token carries no email to show (requirement: ask the operator
   * to name the account when the API cannot).
   */
  async addToken(name: string, token: string): Promise<AccountView> {
    const trimmed = token.trim();
    if (!/^[\w-]{20,512}$/.test(trimmed)) {
      throw new Error('that does not look like a token from `claude setup-token`');
    }
    const id = this.store.newId(name);
    await this.creds.storeToken(id, trimmed);
    const meta: AccountMeta = { id, kind: 'token', name, createdAt: new Date().toISOString() };
    this.store.add(meta);
    this.poller.track(id);
    this.poller.kick(id);
    this.changed();
    log.info('accounts.token.added', { account: id });
    return this.view(meta);
  }

  /**
   * Start a profile: the directory exists from this moment, the login happens
   * in a terminal the service puts in front of the operator, and
   * `completeLogin` reads back who they became.
   */
  beginProfile(name?: string): { id: string; dir: string } {
    const id = this.store.newId(name ?? 'account');
    const dir = profileConfigDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.store.add({ id, kind: 'profile', ...(name ? { name } : {}), createdAt: new Date().toISOString() });
    this.poller.track(id);
    this.changed();
    log.info('accounts.profile.created', { account: id });
    return { id, dir };
  }

  /** After a login terminal exits: read back the identity, remember it. */
  async completeLogin(id: string): Promise<AccountView | undefined> {
    const meta = this.store.get(id);
    if (!meta || meta.kind !== 'profile') return undefined;
    this.identities.delete(id);
    const dir = profileConfigDir(id);
    // `claude auth status` under the profile confirms — and refreshes — its
    // credentials; the identity file fills in the address to display.
    try {
      const { stdout } = await this.exec('claude', ['auth', 'status'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      });
      const status = parseAuth(stdout, '', new Date().toISOString());
      if (status.email || status.subscription) {
        this.store.update(id, {
          ...(status.email ? { email: status.email } : {}),
          ...(status.subscription ? { plan: status.subscription } : {}),
        });
      }
    } catch (error) {
      log.warn('accounts.login.probe-failed', { account: id, error: (error as Error).message });
    }
    const who = this.creds.readIdentity(dir);
    if (who?.email) this.store.update(id, { email: who.email });
    this.poller.kick(id);
    this.changed();
    return this.view(this.store.get(id)!);
  }

  /**
   * Forget an account. The profile directory (and with it, on Linux, its
   * credentials file) is removed, and on macOS so is the CLI's HASHED keychain
   * item for that directory — it exists only because this console minted the
   * dir, and with the dir gone its hash can never come up again. The plain
   * `Claude Code-credentials` item (the machine login) is never touched:
   * deleting from the CLI's shared store is the one write this console never
   * performs.
   */
  async remove(id: string): Promise<boolean> {
    if (id === DEFAULT_ACCOUNT_ID) throw new Error('the machine login cannot be removed here');
    const meta = this.store.remove(id);
    if (!meta) return false;
    this.poller.untrack(id);
    this.identities.delete(id);
    this.auth.delete(id);
    if (meta.kind === 'token') await this.creds.deleteToken(id);
    if (meta.kind === 'profile') await this.creds.deleteProfileCredential(profileConfigDir(id));
    try {
      rmSync(profileConfigDir(id), { recursive: true, force: true });
      rmSync(profileConfigDir(id).replace(/\/config$/, ''), { recursive: true, force: true });
    } catch { /* best effort — an empty husk is untidy, not unsafe */ }
    this.changed();
    log.info('accounts.removed', { account: id, kind: meta.kind });
    return true;
  }

  /**
   * Give an account a new display name. The NAME only, never the id: ids are
   * journal keys, throttle keys, path segments and the keychain-service hash
   * input — renaming one would orphan credentials and break every reference.
   * The machine login stores its name as the registry's `defaultName`, because
   * its row is synthesized and a stored row would double-list.
   */
  async rename(id: string, name: string): Promise<AccountView | undefined> {
    const trimmed = name.trim().slice(0, 64);
    if (id === DEFAULT_ACCOUNT_ID) {
      this.store.setDefaultName(trimmed || undefined);
    } else {
      if (!this.store.get(id)) return undefined;
      this.store.update(id, { name: trimmed || undefined });
    }
    this.changed();
    log.info('accounts.renamed', { account: id, named: Boolean(trimmed) });
    const meta = this.meta(id);
    return meta ? this.view(meta) : undefined;
  }

  /* ---------------- what the runner needs ---------------- */

  /** Env to merge into a child so it runs as this account. `null` = inherit. */
  async envFor(accountId: string | undefined): Promise<NodeJS.ProcessEnv | null> {
    if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return null;
    return this.creds.envFor(this.store.get(accountId) ?? null);
  }

  /** The config dir a child under this account uses — transcript porting. */
  configDirFor(accountId: string | undefined): string {
    const meta = accountId ? this.meta(accountId) : null;
    return this.creds.configDirFor(meta ?? null);
  }

  markLimited(accountId: string | undefined, bucket: string, resetsAt: string): void {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (id === DEFAULT_ACCOUNT_ID) {
      const kept: Record<string, string> = {};
      for (const [name, iso] of Object.entries(this.defaultLimits)) {
        if (Date.parse(iso) > Date.now()) kept[name] = iso;
      }
      kept[bucket] = resetsAt;
      this.defaultLimits = kept;
    } else {
      this.store.markLimited(id, bucket, resetsAt);
    }
    this.poller.kick(id);
    this.changed();
  }

  limitedUntil(accountId: string | undefined): Record<string, string> {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const raw = id === DEFAULT_ACCOUNT_ID ? this.defaultLimits : this.store.get(id)?.limitedUntil ?? {};
    const live: Record<string, string> = {};
    for (const [bucket, iso] of Object.entries(raw)) {
      if (Date.parse(iso) > Date.now()) live[bucket] = iso;
    }
    return live;
  }

  /** Last-known meters for one account, straight from the poller's cache. */
  usageFor(accountId: string | undefined): AccountUsage | undefined {
    return this.poller.snapshot(accountId ?? DEFAULT_ACCOUNT_ID);
  }

  /**
   * The account a limit-hit run should continue under: any other account
   * whose shared windows are not known-exhausted, freshest headroom first.
   * Unknown usage ranks between the measured — an account we know is at 20%
   * beats it; one measured at 80% does not. Sync on purpose: answered from
   * cache, mid-phase, with nothing to await.
   *
   * `undefined` reads as "escaping the machine login" (the runner's shape:
   * an absent accountId IS the default account); an explicit `null` means
   * "exclude no one" — the launch-time `auto` pick.
   */
  pickAccount(excluding: string | null | undefined, forModel?: string): string | null {
    return this.rankAccounts(excluding, forModel)[0] ?? null;
  }

  /**
   * Every account such a run COULD continue under, best first — the list
   * `pickAccount` takes its head from, for callers that must probe before they
   * trust (the auth preflight tries each in turn with `checkAuthFor`, because
   * headroom says nothing about whether the login still works).
   *
   * The predicate, in full — the account-selection rule the resource ladder
   * climbs by: not the one being escaped; its shared windows (`five_hour`,
   * `seven_day`) neither learned-exhausted nor measured at 99%+; for a named
   * model, its per-model window likewise; and its login not KNOWN broken
   * (`expired` / `signed-out` as last observed — `unknown` and never-observed
   * pass, since a setup-token exposes no expiry and a fresh profile has not
   * been read yet). Ranked by the worse of the two shared utilizations,
   * ascending; unknown usage scores 50, between the measured.
   */
  rankAccounts(excluding: string | null | undefined, forModel?: string): string[] {
    const exclude = excluding === null ? null : excluding ?? DEFAULT_ACCOUNT_ID;
    // A per-model window disqualifies only for the model that would spend it
    // (`seven_day_opus` ↔ an opus run) and never feeds the score: an account
    // exhausted on Opus is the RIGHT place for a Sonnet phase, and worst-case
    // scoring would defeat the per-model design of the windows.
    const family = forModel ? /(opus|sonnet|haiku|fable)/.exec(forModel.toLowerCase())?.[1] : undefined;
    const candidates: { id: string; score: number }[] = [];
    const ids = [DEFAULT_ACCOUNT_ID, ...this.store.stored().map((m) => m.id)];
    for (const id of ids) {
      if (id === exclude) continue;
      // A login observed broken is no place to continue: the switch would
      // spend a session discovering what the registry already knows.
      const auth = this.auth.get(id);
      if (auth === 'expired' || auth === 'signed-out') continue;
      const limited = this.limitedUntil(id);
      // Exact shared keys only — a learned `seven_day_opus` must never
      // blanket-disqualify an account for every model.
      if (limited.five_hour || limited.seven_day) continue;
      const buckets = this.poller.snapshot(id)?.buckets ?? {};
      const shared = [buckets.five_hour?.utilization, buckets.seven_day?.utilization]
        .filter((v): v is number => typeof v === 'number');
      if (shared.some((v) => v >= 99)) continue;
      if (family) {
        const key = `seven_day_${family}`;
        if (limited[key]) continue;
        const measured = buckets[key]?.utilization;
        if (typeof measured === 'number' && measured >= 99) continue;
      }
      candidates.push({ id, score: shared.length ? Math.max(...shared) : 50 });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates.map((c) => c.id);
  }

  /** A display name for journals and banners. */
  labelFor(accountId: string | undefined): string {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (id === DEFAULT_ACCOUNT_ID) return this.store.defaultName ?? 'the machine login';
    const meta = this.store.get(id);
    return meta?.name ?? meta?.email ?? id;
  }

  /* ---------------- internals ---------------- */

  private async resolveToken(accountId: string): Promise<TokenAnswer> {
    const meta = this.meta(accountId);
    if (!meta) return null;
    if (meta.kind === 'token') {
      const token = await this.creds.readToken(accountId);
      return token ? { token, tokenKind: 'setup-token' } : { error: 'stored token is missing' };
    }
    const configDir = meta.kind === 'profile' ? profileConfigDir(accountId) : null;
    let oauth = await this.creds.readClaudeOauth(configDir);
    if (oauth && oauth.expiresAt && oauth.expiresAt < Date.now() + 60_000) {
      // Stale. `claude auth status` under the same env makes the CLI refresh
      // its own credential — the one safe way to write it — then re-read.
      try {
        const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env };
        await this.exec('claude', ['auth', 'status'], { env });
        oauth = await this.creds.readClaudeOauth(configDir);
      } catch { /* the stale token may still be honoured; try it */ }
    }
    // The authoritative auth-state writer: it rides every poller tick and sits
    // AFTER the refresh attempt, so only a login the CLI itself could not
    // rescue ever reads as expired here.
    this.noteAuth(accountId, authStateOf(Boolean(oauth), oauth?.expiresAt, Date.now()));
    if (!oauth) {
      return meta.kind === 'profile'
        ? { error: 'not signed in yet — finish `claude auth login` for this profile' }
        : { error: 'no Claude login found on this machine' };
    }
    return { token: oauth.accessToken };
  }

  private usageUpdated(accountId: string, usage: AccountUsage): void {
    this.thresholds(accountId, usage);
    this.changed();
  }

  /**
   * Warn at 80, alert at 95, once per level per window — the announced level
   * resets when the meter drops back under (a new window), so the next climb
   * announces again. Fed from real polls only; stale cache never re-fires.
   */
  private thresholds(accountId: string, usage: AccountUsage): void {
    if (!this.opts.onThreshold || usage.error || usage.unsupported) return;
    for (const [bucket, meter] of Object.entries(usage.buckets)) {
      const key = `${accountId}:${bucket}:${meter.resetsAt}`;
      const level: 'warn' | 'alert' | null =
        meter.utilization >= ALERT_PCT ? 'alert' : meter.utilization >= WARN_PCT ? 'warn' : null;
      if (!level) {
        this.announced.delete(key);
        continue;
      }
      const before = this.announced.get(key);
      if (before === 'alert' || before === level) continue;
      this.announced.set(key, level);
      const meta = this.meta(accountId);
      if (!meta) continue;
      void this.view(meta).then((view) => {
        this.opts.onThreshold?.(view, bucket, level, meter.utilization, meter.resetsAt);
      });
    }
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}
