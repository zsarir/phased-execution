/**
 * The MCP registry — which Model Context Protocol servers THIS instance may
 * attach to the sessions it starts.
 *
 * Per instance, for the same reason the account registry is (and unlike
 * `runs/`): two consoles on one machine are usually two projects, and a server
 * that belongs in one — a production database, a customer's issue tracker — is
 * exactly the wrong thing to hand the other. The registry is also what makes a
 * plan's `**MCP servers (every session):**` line mean anything: the plan names
 * an id, and this file is where that id becomes a URL or a command.
 *
 * Two kinds, one registry:
 *
 *  - `remote` — an HTTP, SSE or WebSocket endpoint. Authenticates by OAuth
 *    (the CLI's own flow, whose tokens this console never touches) or by a
 *    header this console holds.
 *  - `stdio` — a local command the CLI spawns. Authenticates, if at all, by
 *    environment variables.
 *
 * Nothing in this file is a secret. Bearer tokens, API keys and header values
 * never appear in `servers.json` — that is `credentials.ts`'s single job. What
 * lands here is the *shape* of the secret (`secretRefs`: which header or env
 * key needs one) so the UI can say "this needs a token" without holding one,
 * and so `config.ts` knows what to resolve at spawn time.
 *
 * `${VAR}` references are the deliberate exception: they are not secrets, they
 * are the NAME of one, resolved from the console's own environment when a run
 * starts. A team can share a plan naming `github` without sharing the token.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';

/**
 * Transports, exactly as the CLI spells them in `.mcp.json`.
 *
 * `streamable-http` is the MCP specification's own name for `http` and the CLI
 * accepts it as an alias, so a config pasted from a server's own documentation
 * works unedited. It is normalised to `http` on the way in — one spelling in
 * the registry, both spellings accepted from the world.
 */
export const MCP_TRANSPORTS = ['http', 'sse', 'ws', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export function isMcpTransport(value: unknown): value is McpTransport {
  return typeof value === 'string' && (MCP_TRANSPORTS as readonly string[]).includes(value);
}

/** `streamable-http` → `http`; everything else passes through unchanged. */
export function normaliseTransport(value: unknown): McpTransport | undefined {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'streamable-http') return 'http';
  return isMcpTransport(raw) ? raw : undefined;
}

/**
 * Where a secret has to be spliced in before the CLI sees the config.
 *
 * `header` for remote servers (`headers.Authorization`), `env` for stdio ones
 * (`env.GITHUB_TOKEN`). The registry stores the location and never the value.
 */
export type McpSecretRef = {
  kind: 'header' | 'env';
  /** The header name or environment variable this server needs a value for. */
  name: string;
  /**
   * A template for the value, with `{}` where the secret goes — `Bearer {}` is
   * the common one. Absent means the secret IS the whole value.
   */
  template?: string;
};

export type McpServerMeta = {
  id: string;
  transport: McpTransport;
  /** What the operator called it. The id is what plans name; this is prose. */
  label?: string;
  /** Remote transports only. */
  url?: string;
  /** stdio only. */
  command?: string;
  args?: string[];
  /**
   * Non-secret environment for a stdio server. A `${VAR}` value here is
   * resolved from the console's own environment at spawn time, exactly as the
   * CLI resolves it in a `.mcp.json`.
   */
  env?: Record<string, string>;
  /** Non-secret headers for a remote server. `${VAR}` resolves the same way. */
  headers?: Record<string, string>;
  /** Which headers/env keys need a value from `credentials.ts`. */
  secretRefs?: McpSecretRef[];
  /**
   * Load this server's tools upfront instead of behind tool search. Costs
   * context on every turn, so it is off unless the operator says otherwise.
   */
  alwaysLoad?: boolean;
  /** Per-server tool-call wall clock, milliseconds, as the CLI's `timeout`. */
  timeoutMs?: number;
  /** Where the operator got it — shown in the UI, never acted on. */
  source?: 'manual' | 'catalog' | 'imported';
  createdAt: string;
  lastUsed?: string;
  /**
   * The tool names this server last advertised, sorted. This is the rug-pull
   * fingerprint: a server whose tools change under a plan that already trusted
   * it is the documented MCP supply-chain attack, and the only way to notice is
   * to have written down what it used to be.
   */
  toolFingerprint?: { tools: string[]; seenAt: string };
  /**
   * Tools this server marks `anthropic/requiresUserInteraction`. An unattended
   * `-p` run can never approve one — the CLI converts an allow from a prompt
   * tool into a deny — so knowing the names is how the console warns instead of
   * letting a phase discover it at the wall.
   */
  interactiveTools?: string[];
};

/**
 * Ids are path segments, journal keys, permission-rule fragments (`mcp__<id>`)
 * and the tokens plans name. Keep them boring, and keep them to what the CLI
 * itself accepts in `claude mcp add` (letters, digits, hyphen, underscore).
 */
export const MCP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Names the CLI keeps for its own built-in servers. Registering one of these
 * would be silently skipped at load with a rename warning, so refuse it here
 * where there is somebody to tell.
 */
export const RESERVED_MCP_IDS = [
  'workspace', 'claude-in-chrome', 'computer-use', 'claude preview', 'claude browser',
];

/**
 * Module-level, same discipline as the accounts/log/push/approvals paths:
 * resolved the moment this module loads, from the instance identity resolved
 * before it. A late resolution would write global state under a private id.
 */
export const MCP_DIR = join(INSTANCE_STATE_DIR, 'mcp');
const REGISTRY_FILE = join(MCP_DIR, 'servers.json');

/** Where the per-run resolved `--mcp-config` files go. 0600, like settings. */
export const MCP_CONFIG_DIR = join(INSTANCE_STATE_DIR, 'mcp-config');

type RegistryFile = {
  version: 1;
  servers: McpServerMeta[];
  /**
   * Ids the operator has switched off without removing. Kept beside the rows
   * rather than as a field on them so that "disabled" survives a row being
   * rewritten by an import, and so the disabled set can be read without
   * walking every server.
   */
  disabled?: string[];
};

export class McpStore {
  private servers: McpServerMeta[] = [];
  private off: Set<string>;

  constructor() {
    const { servers, disabled } = readRegistry();
    this.servers = servers;
    this.off = new Set(disabled);
  }

  list(): McpServerMeta[] {
    return this.servers.map((s) => ({ ...s }));
  }

  get(id: string): McpServerMeta | undefined {
    const found = this.servers.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  has(id: string): boolean {
    return this.servers.some((s) => s.id === id);
  }

  /** Ids that are registered AND switched on — what a run may actually attach. */
  enabledIds(): string[] {
    return this.servers.filter((s) => !this.off.has(s.id)).map((s) => s.id);
  }

  isEnabled(id: string): boolean {
    return this.has(id) && !this.off.has(id);
  }

  setEnabled(id: string, on: boolean): boolean {
    if (!this.has(id)) return false;
    if (on) this.off.delete(id);
    else this.off.add(id);
    this.persist();
    return true;
  }

  /**
   * Mint an id from the label — readable in plans, in journals and in
   * `mcp__<id>__<tool>` permission rules, unique by suffix when it collides.
   */
  newId(label: string): string {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)
      || 'server';
    let id = RESERVED_MCP_IDS.includes(base) ? `${base}-mcp` : base;
    while (this.servers.some((s) => s.id === id)) {
      id = `${base}-${randomBytes(2).toString('hex')}`;
    }
    return id;
  }

  add(meta: McpServerMeta): void {
    assertUsableId(meta.id);
    if (this.servers.some((s) => s.id === meta.id)) throw new Error(`MCP server ${meta.id} already exists`);
    this.servers.push({ ...meta });
    this.persist();
  }

  update(id: string, patch: Partial<Omit<McpServerMeta, 'id'>>): McpServerMeta | undefined {
    const found = this.servers.find((s) => s.id === id);
    if (!found) return undefined;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (found as Record<string, unknown>)[key];
      else (found as Record<string, unknown>)[key] = value;
    }
    this.persist();
    return { ...found };
  }

  remove(id: string): McpServerMeta | undefined {
    const index = this.servers.findIndex((s) => s.id === id);
    if (index < 0) return undefined;
    const [gone] = this.servers.splice(index, 1);
    this.off.delete(id);
    this.persist();
    return gone;
  }

  /**
   * Record what a server advertised, and say whether it changed.
   *
   * Returns the previous fingerprint when the tool list differs from it, so the
   * caller can announce a rug-pull rather than quietly overwriting the memory of
   * what this server used to be. A first observation is not a change.
   */
  noteTools(id: string, tools: string[], now = new Date()): { changed: boolean; before?: string[] } {
    const found = this.servers.find((s) => s.id === id);
    if (!found) return { changed: false };
    const sorted = [...new Set(tools)].sort();
    const before = found.toolFingerprint?.tools;
    const changed = Boolean(before) && !sameList(before ?? [], sorted);
    found.toolFingerprint = { tools: sorted, seenAt: now.toISOString() };
    this.persist();
    return changed ? { changed, before } : { changed: false };
  }

  private persist(): void {
    const body: RegistryFile = {
      version: 1,
      servers: this.servers,
      ...(this.off.size ? { disabled: [...this.off].sort() } : {}),
    };
    mkdirSync(MCP_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, REGISTRY_FILE);
  }
}

export function assertUsableId(id: string): void {
  if (!MCP_ID_RE.test(id)) {
    throw new Error(
      `MCP server id ${JSON.stringify(id)} is not usable — lowercase letters, digits, `
      + '`-` and `_` only, starting with a letter or digit',
    );
  }
  if (RESERVED_MCP_IDS.includes(id)) {
    throw new Error(`${id} is reserved for one of Claude Code's built-in servers — pick another name`);
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** An unreadable registry degrades to empty — same posture as the account registry. */
function readRegistry(): { servers: McpServerMeta[]; disabled: string[] } {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as RegistryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.servers)) {
      return {
        servers: parsed.servers.filter(
          (s) => s && typeof s.id === 'string' && MCP_ID_RE.test(s.id) && isMcpTransport(s.transport),
        ),
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((d) => typeof d === 'string') : [],
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('mcp.registry.unreadable', { error: (error as Error).message });
    }
  }
  return { servers: [], disabled: [] };
}
