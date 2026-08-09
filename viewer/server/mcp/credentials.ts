/**
 * Secrets for MCP servers — the one file in `mcp/` that touches credentials.
 *
 * Scope, deliberately narrow. This holds ONLY the secrets a console must splice
 * into a config itself: a bearer header for a remote server, an API key in a
 * stdio server's environment. Three other kinds of secret exist in this system
 * and none of them are ours:
 *
 *  - **OAuth tokens for remote servers.** `claude mcp login` owns those,
 *    per `CLAUDE_CONFIG_DIR`, and refreshes them on its own schedule. The rule
 *    the account registry already lives by applies unchanged: never write the
 *    CLI's own credential store, because a second writer is how two processes
 *    corrupt one login. This console starts that flow and reads the resulting
 *    status; it never sees the token.
 *  - **`${VAR}` references.** Not secrets — the *name* of one. Resolved from
 *    the console's environment when a run starts, exactly as the CLI resolves
 *    them in a `.mcp.json`, so a plan can name `github` without a team sharing
 *    a token.
 *  - **`headersHelper` output.** A server can generate its own headers at
 *    connect time. That command's output never passes through here.
 *
 * macOS gets the keychain under a service of our own,
 * `phase-console-mcp-<id>`; everywhere else a 0600 file under the server's
 * directory. Every process goes through the accounts module's injectable
 * `Exec`, because tests must never talk to a real keychain — and neither may CI.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { realExec, type Exec } from '../accounts/credentials.ts';
import { MCP_DIR, type McpSecretRef, type McpServerMeta } from './store.ts';

/** Our own keychain service for one server's secrets. */
export function mcpKeychainService(id: string, ref: string): string {
  return `phase-console-mcp-${id}-${ref}`;
}

/** A secret's stable key within a server: `header:Authorization`, `env:API_KEY`. */
export function refKey(ref: McpSecretRef): string {
  return `${ref.kind}:${ref.name}`;
}

function secretsFile(id: string): string {
  return join(MCP_DIR, id, 'secrets.json');
}

export class McpCredentials {
  private readonly exec: Exec;
  private readonly platform: NodeJS.Platform;

  constructor(exec: Exec = realExec, platform: NodeJS.Platform = process.platform) {
    this.exec = exec;
    this.platform = platform;
  }

  async store(id: string, ref: McpSecretRef, secret: string): Promise<void> {
    const key = refKey(ref);
    if (this.platform === 'darwin') {
      // `-U` updates in place, so re-pasting a rotated token is not an error.
      await this.exec('security', [
        'add-generic-password', '-U',
        '-s', mcpKeychainService(id, key),
        '-a', process.env.USER ?? 'phase-console',
        '-w', secret,
      ]);
      return;
    }
    const file = secretsFile(id);
    const held = this.readFileSecrets(id);
    held[key] = secret;
    mkdirSync(join(MCP_DIR, id), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(held, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async read(id: string, ref: McpSecretRef): Promise<string | null> {
    const key = refKey(ref);
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.exec('security', [
          'find-generic-password', '-s', mcpKeychainService(id, key), '-w',
        ]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    }
    return this.readFileSecrets(id)[key] ?? null;
  }

  /** Whether a value is present, without reading it — what the UI actually asks. */
  async has(id: string, ref: McpSecretRef): Promise<boolean> {
    return (await this.read(id, ref)) !== null;
  }

  async delete(id: string, ref: McpSecretRef): Promise<void> {
    const key = refKey(ref);
    if (this.platform === 'darwin') {
      try {
        await this.exec('security', ['delete-generic-password', '-s', mcpKeychainService(id, key)]);
      } catch { /* never stored, or already gone — same outcome */ }
      return;
    }
    const held = this.readFileSecrets(id);
    if (!(key in held)) return;
    delete held[key];
    if (Object.keys(held).length) {
      writeFileSync(secretsFile(id), `${JSON.stringify(held, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } else {
      try { unlinkSync(secretsFile(id)); } catch { /* same */ }
    }
  }

  /** Everything a server held, dropped with it. Best effort, never throws. */
  async deleteAll(meta: McpServerMeta): Promise<void> {
    for (const ref of meta.secretRefs ?? []) {
      try { await this.delete(meta.id, ref); } catch { /* removal must not be blockable */ }
    }
    if (this.platform !== 'darwin') {
      try { unlinkSync(secretsFile(meta.id)); } catch { /* same */ }
    }
  }

  private readFileSecrets(id: string): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(secretsFile(id), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch { /* absent or unreadable reads as "no secret", which is the safe answer */ }
    return {};
  }
}
