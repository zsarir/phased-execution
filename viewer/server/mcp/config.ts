/**
 * Registry ids → the `--mcp-config` document the CLI reads.
 *
 * This is the only place a secret is joined to a server definition, and the
 * only place that writes a file containing one. Both facts are load-bearing:
 *
 *  - **0600, under the instance state dir, one per run**, exactly as
 *    `writeSettingsFile` does for the per-run permission settings. The
 *    `chmodSync` after the write is not redundant — `writeFileSync`'s `mode`
 *    applies only when it creates the file, so a rewrite of an existing path
 *    would otherwise keep whatever mode it had.
 *  - **The config is passed with `--strict-mcp-config`**, so the set this file
 *    resolves is the ONLY set the session gets. Without it the CLI would union
 *    in whatever `~/.claude.json` and the project's `.mcp.json` happen to hold,
 *    and an unattended run would be talking to servers nobody chose for it.
 *    Determinism here is a safety property, not a tidiness one.
 *
 * `${VAR}` values are passed through untouched rather than expanded. The CLI
 * expands them itself, in the child's environment, with `${VAR:-default}`
 * support — re-implementing that here would be a second, subtly different
 * expander, and would put the resolved value in a file when the whole point of
 * writing `${VAR}` was to keep it out of one.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpCredentials } from './credentials.ts';
import { MCP_CONFIG_DIR, type McpServerMeta } from './store.ts';

/** One entry of the `mcpServers` object, as the CLI's schema defines it. */
type McpConfigEntry = {
  type: 'http' | 'sse' | 'ws' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
  timeout?: number;
};

export type McpConfigDoc = { mcpServers: Record<string, McpConfigEntry> };

/**
 * Build the document for a set of servers, splicing in whatever secrets they
 * declared. A ref with no stored secret is left out rather than written as an
 * empty header: an absent `Authorization` fails at connect with a 401 the
 * console can classify as "needs authentication", while an empty one is a
 * malformed request the server reports as something else entirely.
 */
export async function buildMcpConfig(
  servers: McpServerMeta[],
  credentials: McpCredentials,
): Promise<McpConfigDoc> {
  const mcpServers: Record<string, McpConfigEntry> = {};
  for (const meta of servers) {
    const headers: Record<string, string> = { ...(meta.headers ?? {}) };
    const env: Record<string, string> = { ...(meta.env ?? {}) };
    for (const ref of meta.secretRefs ?? []) {
      const secret = await credentials.read(meta.id, ref);
      if (!secret) continue;
      const value = ref.template ? ref.template.replace('{}', secret) : secret;
      if (ref.kind === 'header') headers[ref.name] = value;
      else env[ref.name] = value;
    }
    const entry: McpConfigEntry = { type: meta.transport };
    if (meta.transport === 'stdio') {
      entry.command = meta.command ?? '';
      if (meta.args?.length) entry.args = [...meta.args];
      if (Object.keys(env).length) entry.env = env;
    } else {
      entry.url = meta.url ?? '';
      if (Object.keys(headers).length) entry.headers = headers;
    }
    if (meta.alwaysLoad) entry.alwaysLoad = true;
    // Below 1000 the CLI ignores it and falls through to MCP_TOOL_TIMEOUT, so a
    // smaller number would read as configured while doing nothing.
    if (meta.timeoutMs && meta.timeoutMs >= 1000) entry.timeout = meta.timeoutMs;
    mcpServers[meta.id] = entry;
  }
  return { mcpServers };
}

/**
 * Write the document for one run and return its path, or null when the set is
 * empty — an empty `mcpServers` with `--strict-mcp-config` is a real
 * instruction ("no servers at all"), but the caller expresses that by passing
 * no flag, which is cheaper and reads the same to the CLI.
 */
export function writeMcpConfigFile(runId: string, doc: McpConfigDoc): string | null {
  if (!Object.keys(doc.mcpServers).length) return null;
  mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const path = join(MCP_CONFIG_DIR, `run-${runId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  // `mode` on writeFileSync only applies on create; a rewrite would keep the old one.
  chmodSync(path, 0o600);
  return path;
}

/**
 * What a person should see instead of the file: the same document with every
 * secret replaced. Used by the UI's "what will this run connect to" preview and
 * by anything that logs a config, so neither has to remember to redact.
 */
export function redactConfig(doc: McpConfigDoc): McpConfigDoc {
  const out: Record<string, McpConfigEntry> = {};
  for (const [id, entry] of Object.entries(doc.mcpServers)) {
    const copy: McpConfigEntry = { ...entry };
    if (copy.headers) copy.headers = redactValues(copy.headers);
    if (copy.env) copy.env = redactValues(copy.env);
    out[id] = copy;
  }
  return { mcpServers: out };
}

/**
 * A `${VAR}` reference is not a secret and stays legible — seeing which
 * variable a server wants is most of what makes a misconfiguration findable.
 * Everything else becomes a fixed mask, with no length hint.
 */
function redactValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = /^\$\{[^}]+\}$/.test(value.trim()) ? value : '••••••';
  }
  return out;
}
