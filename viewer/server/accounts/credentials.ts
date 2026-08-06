/**
 * Secrets and environments for accounts — the one file that touches credentials.
 *
 * Two distinct jobs, kept together because they share the same discipline:
 *
 *  1. Holding the secrets THIS console owns: the pasted `claude setup-token`
 *     values behind `token` accounts. macOS gets the keychain (a service name
 *     of our own, `phase-console-account-<id>`); everywhere else a 0600 file
 *     under the account's directory.
 *
 *  2. READING the credentials the Claude CLI owns, so the usage poller can ask
 *     the same endpoint `/usage` asks. Reading only: the CLI holds locks
 *     around its own credential writes and refreshes tokens on its own
 *     schedule — a second writer is how two processes corrupt one login. The
 *     service names are the CLI's own scheme: `Claude Code-credentials` for
 *     the machine login, `Claude Code-credentials-<first 8 hex of
 *     sha256(CLAUDE_CONFIG_DIR)>` for a redirected profile.
 *
 * Every process this module spawns goes through an injectable `Exec`, because
 * tests must never talk to a real keychain — and neither may CI.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { ACCOUNTS_DIR, profileConfigDir, type AccountMeta } from './store.ts';

export type Exec = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

const EXEC_TIMEOUT_MS = 20_000;

export const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...(opts?.env ? { env: opts.env } : {}) },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
  });

/** The CLI's keychain service for a given (possibly redirected) config dir. */
export function claudeKeychainService(configDir: string | null): string {
  if (!configDir) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Our own keychain service for a token account's secret. */
export function consoleKeychainService(accountId: string): string {
  return `phase-console-account-${accountId}`;
}

function tokenFile(accountId: string): string {
  return join(ACCOUNTS_DIR, accountId, 'token');
}

export class Credentials {
  private readonly exec: Exec;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;

  constructor(exec: Exec = realExec, platform: NodeJS.Platform = process.platform, home: string = homedir()) {
    this.exec = exec;
    this.platform = platform;
    this.home = home;
  }

  /* ---------------- token accounts: secrets we own ---------------- */

  async storeToken(accountId: string, token: string): Promise<void> {
    if (this.platform === 'darwin') {
      // `-U` updates in place, so re-pasting a token is not an error.
      await this.exec('security', [
        'add-generic-password', '-U',
        '-s', consoleKeychainService(accountId),
        '-a', process.env.USER ?? 'phase-console',
        '-w', token,
      ]);
      return;
    }
    mkdirSync(join(ACCOUNTS_DIR, accountId), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(accountId), `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async readToken(accountId: string): Promise<string | null> {
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.exec('security', [
          'find-generic-password', '-s', consoleKeychainService(accountId), '-w',
        ]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    }
    try {
      return readFileSync(tokenFile(accountId), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  async deleteToken(accountId: string): Promise<void> {
    if (this.platform === 'darwin') {
      try {
        await this.exec('security', ['delete-generic-password', '-s', consoleKeychainService(accountId)]);
      } catch { /* never stored, or already gone — same outcome */ }
      return;
    }
    try { unlinkSync(tokenFile(accountId)); } catch { /* same */ }
  }

  /* ---------------- the environment a child runs under ---------------- */

  /**
   * What to merge into a child's env so it runs AS this account.
   *
   * `null` means "inherit" — the default account is whatever the machine's
   * own `claude` is signed into, and saying nothing is exactly right. A token
   * account must NOT also set `CLAUDE_CONFIG_DIR`: the token outranks the
   * stored login in the CLI's precedence, and the default config dir is what
   * keeps its session transcripts portable to and from the machine login.
   */
  async envFor(account: AccountMeta | null): Promise<NodeJS.ProcessEnv | null> {
    if (!account || account.kind === 'default') return null;
    if (account.kind === 'profile') {
      return { CLAUDE_CONFIG_DIR: profileConfigDir(account.id) };
    }
    const token = await this.readToken(account.id);
    if (!token) {
      log.warn('accounts.token.missing', { account: account.id });
      return null;
    }
    return { CLAUDE_CODE_OAUTH_TOKEN: token };
  }

  /** The config dir a child under this env would use — for transcript porting. */
  configDirFor(account: AccountMeta | null): string {
    if (account?.kind === 'profile') return profileConfigDir(account.id);
    return join(this.home, '.claude');
  }

  /* ---------------- the CLI's credentials: read-only ---------------- */

  /**
   * The OAuth blob the CLI keeps for a login — enough to call the usage
   * endpoint. `configDir === null` reads the machine login.
   *
   * A profile whose hashed keychain item is missing answers `null` rather
   * than falling back to the plain service name: the plain item is a
   * DIFFERENT account's credential, and a wrong answer here would render one
   * account's meters under another's name.
   */
  async readClaudeOauth(configDir: string | null): Promise<ClaudeOauth | null> {
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.exec('security', [
          'find-generic-password', '-s', claudeKeychainService(configDir), '-w',
        ]);
        return parseOauth(stdout);
      } catch {
        return null;
      }
    }
    try {
      const file = join(configDir ?? join(this.home, '.claude'), '.credentials.json');
      return parseOauth(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Who a config dir is signed in as, from the CLI's own `.claude.json`.
   * The machine login keeps that file at `~/.claude.json`; a redirected
   * profile keeps it inside its config dir.
   */
  readIdentity(configDir: string | null): { email?: string; org?: string } | null {
    const file = configDir ? join(configDir, '.claude.json') : join(this.home, '.claude.json');
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        oauthAccount?: { emailAddress?: string; organizationName?: string };
      };
      const account = parsed?.oauthAccount;
      if (!account) return null;
      return {
        ...(typeof account.emailAddress === 'string' && account.emailAddress ? { email: account.emailAddress } : {}),
        ...(typeof account.organizationName === 'string' && account.organizationName ? { org: account.organizationName } : {}),
      };
    } catch {
      return null;
    }
  }
}

export type ClaudeOauth = {
  accessToken: string;
  /** Epoch milliseconds, when the CLI recorded one. */
  expiresAt?: number;
  subscriptionType?: string;
};

function parseOauth(raw: string): ClaudeOauth | null {
  try {
    const parsed = JSON.parse(raw.trim()) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      ...(typeof oauth.expiresAt === 'number' ? { expiresAt: oauth.expiresAt } : {}),
      ...(typeof oauth.subscriptionType === 'string' && oauth.subscriptionType
        ? { subscriptionType: oauth.subscriptionType }
        : {}),
    };
  } catch {
    return null;
  }
}
