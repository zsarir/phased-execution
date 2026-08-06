/**
 * The account registry — which Claude identities THIS instance may start work as.
 *
 * Per instance, deliberately (like the push keys and the approvals queue, and
 * unlike `runs/`): two consoles on one machine are usually two projects with
 * two different ideas of which accounts should be burning quota on them, so
 * each instance keeps its own registration system. The same human account
 * signed into two instances is simply two profiles that refresh independently.
 *
 * Three kinds, one registry:
 *
 *  - `default` — the machine's own `claude` login. Synthesized on every read,
 *    never stored, never deletable: it exists because the CLI is signed in,
 *    not because this console registered anything.
 *  - `profile` — a console-managed `CLAUDE_CONFIG_DIR` under this instance's
 *    state dir. The operator signs into it with `claude auth login`; the CLI
 *    owns the credentials (keychain on macOS, `.credentials.json` elsewhere)
 *    and their refresh. This file holds only the metadata around that.
 *  - `token` — a pasted `claude setup-token` value. The secret itself lives in
 *    the keychain (or a 0600 file) via `credentials.ts`; the registry holds
 *    the name the operator gave it, because a bare token has no email to show.
 *
 * Nothing in this file is a secret. Tokens, access tokens and refresh tokens
 * never appear in `accounts.json` — that is `credentials.ts`'s single job.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';

export type AccountKind = 'default' | 'profile' | 'token';

export type AccountMeta = {
  id: string;
  kind: AccountKind;
  /** What the operator called it — required for tokens, optional elsewhere. */
  name?: string;
  /** From `claude auth status` / `.claude.json` after a login completes. */
  email?: string;
  /** `pro`, `max`, … — `subscriptionType` as the CLI reports it. */
  plan?: string;
  createdAt: string;
  lastUsed?: string;
  /**
   * Buckets this account is known to have exhausted, from an actual limit hit
   * (the runner's classifier) — bucket name → ISO reset time. The usage poller
   * corroborates when it can; this survives when it cannot (a token account
   * the usage endpoint refuses still learns its windows the hard way).
   */
  limitedUntil?: Record<string, string>;
};

/** The one id every instance has without registering anything. */
export const DEFAULT_ACCOUNT_ID = 'default';

/** Ids are path segments and journal keys — keep them boring. */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Module-level, same discipline as the log/push/approvals paths: resolved the
 * moment this module loads, from the instance identity resolved before it.
 */
export const ACCOUNTS_DIR = join(INSTANCE_STATE_DIR, 'accounts');
const REGISTRY_FILE = join(ACCOUNTS_DIR, 'accounts.json');

/** A profile account's whole `~/.claude` world lives here. */
export function profileConfigDir(id: string): string {
  return join(ACCOUNTS_DIR, id, 'config');
}

type RegistryFile = {
  version: 1;
  accounts: AccountMeta[];
  /**
   * What the operator renamed the machine login to. A top-level field rather
   * than a stored meta row: the default is synthesized on every `list()`, and
   * a stored row for it would double-list, double-poll, and force relaxing
   * `add()`'s built-in guard. Old readers ignore the extra key.
   */
  defaultName?: string;
};

export class AccountStore {
  private accounts: AccountMeta[] = [];
  private machineName: string | undefined;

  constructor() {
    const { accounts, defaultName } = readRegistry();
    this.accounts = accounts;
    this.machineName = defaultName;
  }

  /** The operator's name for the machine login, when they gave it one. */
  get defaultName(): string | undefined {
    return this.machineName;
  }

  setDefaultName(name: string | undefined): void {
    this.machineName = name?.trim() ? name.trim() : undefined;
    this.persist();
  }

  /** Stored accounts only — the synthesized default is the facade's business. */
  stored(): AccountMeta[] {
    return this.accounts.map((a) => ({ ...a }));
  }

  get(id: string): AccountMeta | undefined {
    const found = this.accounts.find((a) => a.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Mint an id from the display name — readable in journals and paths, unique
   * by suffix when the readable part collides.
   */
  newId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
      || 'account';
    let id = base === DEFAULT_ACCOUNT_ID ? `${base}-2` : base;
    while (this.accounts.some((a) => a.id === id)) {
      id = `${base}-${randomBytes(2).toString('hex')}`;
    }
    return id;
  }

  add(meta: AccountMeta): void {
    if (meta.id === DEFAULT_ACCOUNT_ID) throw new Error('the default account is built in');
    if (!ACCOUNT_ID_RE.test(meta.id)) throw new Error(`account id ${JSON.stringify(meta.id)} is not usable`);
    if (this.accounts.some((a) => a.id === meta.id)) throw new Error(`account ${meta.id} already exists`);
    this.accounts.push({ ...meta });
    this.persist();
  }

  update(id: string, patch: Partial<Omit<AccountMeta, 'id' | 'kind'>>): AccountMeta | undefined {
    const found = this.accounts.find((a) => a.id === id);
    if (!found) return undefined;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (found as Record<string, unknown>)[key];
      else (found as Record<string, unknown>)[key] = value;
    }
    this.persist();
    return { ...found };
  }

  remove(id: string): AccountMeta | undefined {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index < 0) return undefined;
    const [gone] = this.accounts.splice(index, 1);
    this.persist();
    return gone;
  }

  /**
   * Record an exhausted window. Kept tidy on write: reset times that have
   * already passed are dropped rather than carried around as stale alarm.
   */
  markLimited(id: string, bucket: string, resetsAt: string, now = new Date()): void {
    const found = this.accounts.find((a) => a.id === id);
    // The default account has no stored row — the facade keeps its windows in
    // memory; everything registered persists them here.
    if (!found) return;
    const kept: Record<string, string> = {};
    for (const [name, iso] of Object.entries(found.limitedUntil ?? {})) {
      if (Date.parse(iso) > now.getTime()) kept[name] = iso;
    }
    kept[bucket] = resetsAt;
    found.limitedUntil = kept;
    this.persist();
  }

  private persist(): void {
    const body: RegistryFile = {
      version: 1,
      accounts: this.accounts,
      ...(this.machineName ? { defaultName: this.machineName } : {}),
    };
    mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, REGISTRY_FILE);
  }
}

/** An unreadable registry degrades to empty — same posture as the instance registry. */
function readRegistry(): { accounts: AccountMeta[]; defaultName: string | undefined } {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as RegistryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.accounts)) {
      return {
        accounts: parsed.accounts.filter((a) => a && typeof a.id === 'string' && ACCOUNT_ID_RE.test(a.id)),
        defaultName: typeof parsed.defaultName === 'string' && parsed.defaultName.trim()
          ? parsed.defaultName.trim()
          : undefined,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('accounts.registry.unreadable', { error: (error as Error).message });
    }
  }
  return { accounts: [], defaultName: undefined };
}
