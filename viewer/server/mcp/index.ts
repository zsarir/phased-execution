/**
 * The MCP facade — every answer that leaves this module is already redacted.
 *
 * Same boundary discipline as `accounts/index.ts`: a route never reaches into
 * the store, never touches `credentials.ts`, and never has to remember to strip
 * something. `McpServerView` is what the browser is allowed to know, and it is
 * constructed in exactly one place.
 *
 * What this module is responsible for, beyond CRUD:
 *
 *  - **Health, cached.** Probing costs a process, so a set is probed once and
 *    the answer is reused with its age attached. Stale-with-an-age is always
 *    preferable to an error: the runner's own failure classifier works fine
 *    with health unavailable, and a console that refuses to render because a
 *    probe timed out would be worse than one that says "as of four minutes ago".
 *  - **The rug-pull check.** Every probe fingerprints what each server
 *    advertised. A server whose tool list changes under a plan that already
 *    trusted it is the documented MCP supply-chain attack, and the only defence
 *    a client can offer is to have written down what it used to be.
 *  - **The unattended-safety check.** A tool marked
 *    `anthropic/requiresUserInteraction` can never be approved in `claude -p`
 *    (the CLI converts an allow from a prompt tool into a deny), so a run that
 *    depends on one is a run that will stall. Named at attach time, not at 3am.
 */

import { realExec, type Exec } from '../accounts/credentials.ts';
import { log } from '../log.ts';
import { buildMcpConfig, redactConfig, writeMcpConfigFile, type McpConfigDoc } from './config.ts';
import { McpCredentials, refKey } from './credentials.ts';
import { blocksBoarding, probeMcp, type McpHealth, type McpProbe, type McpStatus } from './health.ts';
import {
  assertUsableId, McpStore, normaliseTransport,
  type McpSecretRef, type McpServerMeta, type McpTransport,
} from './store.ts';

export { CURATED, searchCatalog, searchCurated, type CatalogEntry } from './catalog.ts';
export { blocksBoarding, type McpHealth, type McpStatus } from './health.ts';
export { MCP_TRANSPORTS, type McpServerMeta, type McpTransport } from './store.ts';

/** What leaves the server. No secrets, no filesystem paths. */
export type McpServerView = {
  id: string;
  label: string;
  transport: McpTransport;
  /** Remote servers only. Safe to show: a URL with a secret in it is refused on add. */
  url?: string;
  /** stdio only, as a display string — `npx -y @playwright/mcp@latest`. */
  command?: string;
  enabled: boolean;
  /** How this server authenticates, and whether it currently can. */
  auth: {
    kind: 'none' | 'oauth' | 'header' | 'env';
    /** Which values it needs, and whether we hold each. Never the values. */
    secrets: { ref: string; held: boolean }[];
  };
  status: McpStatus;
  /** Age of that status, so the UI can say "as of 4 minutes ago" honestly. */
  checkedAt?: string;
  /** Why it failed, when the CLI said. Already redacted by the CLI itself. */
  issue?: string;
  toolCount?: number;
  /** Tools that can never be approved in an unattended run. */
  interactiveTools?: string[];
  /** Set when the advertised tools changed since we last looked. */
  toolsChanged?: { added: string[]; removed: string[]; seenAt: string };
  source?: string;
  lastUsed?: string;
};

export type McpOptions = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  onChange?: () => void;
  /** A server's tool list changed under us — the rug-pull announcement. */
  onToolsChanged?: (view: McpServerView, added: string[], removed: string[]) => void;
  /** A server went from working to needing attention. Transitions only. */
  onStatusChange?: (view: McpServerView, status: McpStatus) => void;
  now?: () => number;
  /** Injected in tests so no suite ever spawns a real CLI. */
  probeFn?: typeof probeMcp;
};

/** How long a health answer is reused before the next probe. */
const HEALTH_TTL_MS = 5 * 60_000;

export class Mcp {
  private readonly store = new McpStore();
  private readonly creds: McpCredentials;
  private readonly opts: McpOptions;
  private readonly probe: typeof probeMcp;
  private readonly now: () => number;
  /** id → last health row, with the time it was taken. */
  private health = new Map<string, { row: McpHealth; at: number }>();
  /** id → last announced status, so only transitions are announced. */
  private announced = new Map<string, McpStatus>();
  /** id → the change we found but have not yet had acknowledged. */
  private drift = new Map<string, { added: string[]; removed: string[]; seenAt: string }>();
  private inFlight: Promise<void> | null = null;

  constructor(opts: McpOptions = {}) {
    this.opts = opts;
    this.creds = new McpCredentials(opts.exec ?? realExec, opts.platform ?? process.platform);
    this.probe = opts.probeFn ?? probeMcp;
    this.now = opts.now ?? Date.now;
  }

  /* ---------------- reading ---------------- */

  has(id: string): boolean { return this.store.has(id); }
  isEnabled(id: string): boolean { return this.store.isEnabled(id); }
  meta(id: string): McpServerMeta | undefined { return this.store.get(id); }

  /**
   * The ids a run may attach — registered AND switched on.
   *
   * This is also what the engine is told through `PE_MCP_SERVERS`, which is how
   * F15 knows what a plan may name.
   */
  enabledIds(): string[] { return this.store.enabledIds(); }

  async list(): Promise<McpServerView[]> {
    return Promise.all(this.store.list().map((meta) => this.view(meta)));
  }

  /**
   * The set a phase would actually run with, from the ids it named.
   *
   * Unknown and disabled ids are reported rather than dropped: a plan naming a
   * server this machine does not have is exactly the situation the preflight
   * exists to catch, and silently running without it would be the one outcome
   * nobody asked for.
   */
  resolve(ids: readonly string[]): { servers: McpServerMeta[]; unknown: string[]; disabled: string[] } {
    const servers: McpServerMeta[] = [];
    const unknown: string[] = [];
    const disabled: string[] = [];
    for (const id of [...new Set(ids)]) {
      const meta = this.store.get(id);
      if (!meta) { unknown.push(id); continue; }
      if (!this.store.isEnabled(id)) { disabled.push(id); continue; }
      servers.push(meta);
    }
    return { servers, unknown, disabled };
  }

  /* ---------------- writing ---------------- */

  async add(input: {
    id?: string;
    label: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    secretRefs?: McpSecretRef[];
    secrets?: Record<string, string>;
    alwaysLoad?: boolean;
    timeoutMs?: number;
    source?: 'manual' | 'catalog' | 'imported';
  }): Promise<McpServerView> {
    const transport = normaliseTransport(input.transport);
    if (!transport) throw new Error(`unknown transport ${JSON.stringify(input.transport)}`);

    const label = input.label.trim();
    if (!label) throw new Error('name the server — plans and permission rules refer to it by name');
    const id = (input.id?.trim() || this.store.newId(label)).toLowerCase();
    assertUsableId(id);

    if (transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('a stdio server needs a command to run');
    } else {
      const url = input.url?.trim() ?? '';
      if (!url) throw new Error('a remote server needs a URL');
      assertSafeUrl(url);
    }

    const meta: McpServerMeta = {
      id,
      transport,
      label,
      createdAt: new Date(this.now()).toISOString(),
      ...(transport === 'stdio'
        ? {
            command: input.command!.trim(),
            ...(input.args?.length ? { args: input.args } : {}),
            ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
          }
        : {
            url: input.url!.trim(),
            ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
          }),
      ...(input.secretRefs?.length ? { secretRefs: input.secretRefs } : {}),
      ...(input.alwaysLoad ? { alwaysLoad: true } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.source ? { source: input.source } : {}),
    };

    this.store.add(meta);
    for (const ref of meta.secretRefs ?? []) {
      const secret = input.secrets?.[refKey(ref)];
      if (secret) await this.creds.store(id, ref, secret);
    }
    this.changed();
    return this.view(meta);
  }

  async setSecret(id: string, ref: McpSecretRef, secret: string): Promise<void> {
    if (!this.store.has(id)) throw new Error(`no MCP server called ${id}`);
    await this.creds.store(id, ref, secret);
    // A new credential can only change the answer, so stop reusing the old one.
    this.health.delete(id);
    this.changed();
  }

  async rename(id: string, label: string): Promise<McpServerView | undefined> {
    const next = label.trim();
    if (!next) throw new Error('a server needs a name');
    const meta = this.store.update(id, { label: next });
    if (!meta) return undefined;
    this.changed();
    return this.view(meta);
  }

  setEnabled(id: string, on: boolean): boolean {
    const ok = this.store.setEnabled(id, on);
    if (ok) this.changed();
    return ok;
  }

  async remove(id: string): Promise<boolean> {
    const gone = this.store.remove(id);
    if (!gone) return false;
    await this.creds.deleteAll(gone);
    this.health.delete(id);
    this.announced.delete(id);
    this.drift.delete(id);
    this.changed();
    return true;
  }

  /** The operator has seen the tool-list change; stop flagging it. */
  acknowledgeDrift(id: string): boolean {
    const had = this.drift.delete(id);
    if (had) this.changed();
    return had;
  }

  /* ---------------- health ---------------- */

  /**
   * Probe every enabled server, unless a fresh answer is already in hand.
   *
   * Single-flight: concurrent callers share one probe. A caller that needs the
   * truth right now (the operator pressed Refresh) passes `force`.
   */
  async refresh(opts: { force?: boolean; cwd?: string } = {}): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const ids = this.store.enabledIds();
    if (!ids.length) return;
    if (!opts.force && ids.every((id) => this.fresh(id))) return;

    this.inFlight = this.runProbe(ids, opts.cwd).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * Probe a specific set and say whether it may board.
   *
   * This is the preflight. It answers with the rows so the caller can write a
   * halt message that names the server and the reason, rather than "an MCP
   * server is unhappy" — the same standard the §Verification park is held to.
   */
  async preflight(ids: readonly string[], opts: { cwd?: string } = {}): Promise<{
    ok: boolean;
    rows: McpHealth[];
    blocking: McpHealth[];
    unknown: string[];
    disabled: string[];
    probeError?: string;
  }> {
    const { servers, unknown, disabled } = this.resolve(ids);
    if (unknown.length || disabled.length) {
      return { ok: false, rows: [], blocking: [], unknown, disabled };
    }
    if (!servers.length) return { ok: true, rows: [], blocking: [], unknown: [], disabled: [] };

    const doc = await buildMcpConfig(servers, this.creds);
    const probe = await this.probe(doc, opts.cwd ? { cwd: opts.cwd } : {});
    this.absorb(probe);
    if (probe.probeError) {
      // Could not check ≠ they are down. Boarding proceeds: the run's own
      // failure handling is still there, and refusing to start a phase because
      // a probe timed out would turn a flaky check into a stopped plan.
      return { ok: true, rows: [], blocking: [], unknown: [], disabled: [], probeError: probe.probeError };
    }
    const blocking = probe.servers.filter((row) => blocksBoarding(row.status));
    return { ok: blocking.length === 0, rows: probe.servers, blocking, unknown: [], disabled: [] };
  }

  /**
   * The `--mcp-config` file for a run, or null when it attaches nothing.
   *
   * Callers pass the path to `spawn` together with `--strict-mcp-config`, which
   * is what makes the resolved set the only set the session gets.
   */
  async configFor(runId: string, ids: readonly string[]): Promise<string | null> {
    const { servers } = this.resolve(ids);
    if (!servers.length) return null;
    const doc = await buildMcpConfig(servers, this.creds);
    for (const meta of servers) this.store.update(meta.id, { lastUsed: new Date(this.now()).toISOString() });
    return writeMcpConfigFile(runId, doc);
  }

  /** The same document a run would get, with every secret masked. */
  async previewFor(ids: readonly string[]): Promise<McpConfigDoc> {
    const { servers } = this.resolve(ids);
    return redactConfig(await buildMcpConfig(servers, this.creds));
  }

  /* ---------------- internals ---------------- */

  private fresh(id: string): boolean {
    const held = this.health.get(id);
    return Boolean(held && this.now() - held.at < HEALTH_TTL_MS);
  }

  private async runProbe(ids: string[], cwd?: string): Promise<void> {
    const { servers } = this.resolve(ids);
    if (!servers.length) return;
    const doc = await buildMcpConfig(servers, this.creds);
    const probe = await this.probe(doc, cwd ? { cwd } : {});
    if (probe.probeError) {
      log.warn('mcp.probe.failed', { error: probe.probeError });
      return;   // keep the last known answer, with its age
    }
    await this.absorb(probe);
    this.changed();
  }

  /** Fold a probe into the cache, raising the two alarms it can raise. */
  private async absorb(probe: McpProbe): Promise<void> {
    const at = Date.parse(probe.checkedAt) || this.now();
    for (const row of probe.servers) {
      this.health.set(row.id, { row, at });

      if (row.status === 'connected' && row.tools.length) {
        const { changed, before } = this.store.noteTools(row.id, row.tools);
        if (changed && before) {
          const added = row.tools.filter((tool) => !before.includes(tool));
          const removed = before.filter((tool) => !row.tools.includes(tool));
          const seenAt = probe.checkedAt;
          this.drift.set(row.id, { added, removed, seenAt });
          log.warn('mcp.tools.changed', { server: row.id, added, removed });
          const meta = this.store.get(row.id);
          if (meta && this.opts.onToolsChanged) {
            this.opts.onToolsChanged(await this.view(meta), added, removed);
          }
        }
      }

      const previous = this.announced.get(row.id);
      // Only the transition INTO a problem is worth telling somebody about; a
      // first observation of a server that has always needed signing in is not
      // news, it is the state the operator is looking at the page to fix.
      if (previous && previous !== row.status && blocksBoarding(row.status)) {
        const meta = this.store.get(row.id);
        if (meta && this.opts.onStatusChange) this.opts.onStatusChange(await this.view(meta), row.status);
      }
      this.announced.set(row.id, row.status);
    }
  }

  /** The single construction point for everything the browser sees. */
  private async view(meta: McpServerMeta): Promise<McpServerView> {
    const held = this.health.get(meta.id);
    const secrets = await Promise.all((meta.secretRefs ?? []).map(async (ref) => ({
      ref: refKey(ref),
      held: await this.creds.has(meta.id, ref),
    })));
    const drift = this.drift.get(meta.id);
    const interactive = meta.interactiveTools ?? [];

    return {
      id: meta.id,
      label: meta.label ?? meta.id,
      transport: meta.transport,
      ...(meta.url ? { url: meta.url } : {}),
      ...(meta.command ? { command: [meta.command, ...(meta.args ?? [])].join(' ') } : {}),
      enabled: this.store.isEnabled(meta.id),
      auth: { kind: authKind(meta), secrets },
      status: held?.row.status ?? 'unknown',
      ...(held ? { checkedAt: new Date(held.at).toISOString() } : {}),
      ...(held?.row.error ? { issue: held.row.error.message } : {}),
      ...(held?.row.tools.length ? { toolCount: held.row.tools.length } : {}),
      ...(interactive.length ? { interactiveTools: interactive } : {}),
      ...(drift ? { toolsChanged: drift } : {}),
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.lastUsed ? { lastUsed: meta.lastUsed } : {}),
    };
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}

/**
 * How a server proves who it is.
 *
 * A remote server with no header we hold falls to `oauth`, because that is what
 * the CLI will try — and `claude mcp login` is the verb the UI should offer.
 */
function authKind(meta: McpServerMeta): 'none' | 'oauth' | 'header' | 'env' {
  const refs = meta.secretRefs ?? [];
  if (refs.some((ref) => ref.kind === 'header')) return 'header';
  if (refs.some((ref) => ref.kind === 'env')) return 'env';
  if (meta.transport === 'stdio') return 'none';
  return meta.headers?.Authorization ? 'header' : 'oauth';
}

/**
 * Refuse a URL that carries its own credential.
 *
 * A URL is shown in the UI, in logs and in the config preview, and the CLI
 * itself declines to print an expanded server URL for exactly this reason: a
 * token in a query string ends up somewhere it was never meant to be. Whoever
 * wants that server should paste the token as a header, where it is kept.
 */
function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${JSON.stringify(url)} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:' && parsed.hostname !== 'localhost'
      && parsed.hostname !== '127.0.0.1') {
    throw new Error('a remote MCP server must be https (or wss), unless it is on localhost');
  }
  if (parsed.username || parsed.password) {
    throw new Error('put credentials in a header, not in the URL — a URL is shown in the UI and in logs');
  }
  for (const [key, value] of parsed.searchParams) {
    if (/token|key|secret|password|auth/i.test(key) && value) {
      throw new Error(
        `the URL carries a credential in ?${key}= — add it as a header instead, `
        + 'so it is stored in the keychain rather than displayed',
      );
    }
  }
}
