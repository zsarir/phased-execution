/**
 * MCP servers — the registry (never a secret, never a path), the catalog, the
 * probes and sign-in.
 */

import { request, post, q } from './client';

/* ---------------- MCP servers ---------------- */

/** As the CLI spells them in `.mcp.json`. `streamable-http` is normalised to `http`. */
export type McpTransport = 'http' | 'sse' | 'ws' | 'stdio';

/** What the CLI's own `system/init` reports for a server, plus our "never asked". */
export type McpStatus = 'connected' | 'needs-auth' | 'pending' | 'failed' | 'unknown';

/** One registered server. Carries no secret and no path — the facade sees to that. */
export interface McpServerView {
  id: string;
  label: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  enabled: boolean;
  auth: {
    kind: 'none' | 'oauth' | 'header' | 'env';
    /** Which values it needs, and whether the console holds each. Never the values. */
    secrets: { ref: string; held: boolean }[];
  };
  status: McpStatus;
  /** When that status was taken, so the UI can age it honestly. */
  checkedAt?: string;
  issue?: string;
  toolCount?: number;
  /** Tools an unattended run could never approve (`requiresUserInteraction`). */
  interactiveTools?: string[];
  /** The advertised tools changed since we last looked — the rug-pull flag. */
  toolsChanged?: { added: string[]; removed: string[]; seenAt: string };
  /**
   * Environment variables this server's command still refers to and nothing
   * supplies. A registration nobody finished — it will never connect, however
   * many times it is probed, and it must never be attached in the belief that
   * it might.
   */
  needsConfig?: string[];
  source?: string;
  lastUsed?: string;
}

export interface McpState {
  servers: McpServerView[];
  allowMcp: boolean;
}

/** One suggestion, from our curated list or from the official registry. */
export interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  auth: 'none' | 'oauth' | 'header' | 'env';
  secretRefs?: { kind: 'header' | 'env'; name: string; template?: string }[];
  authNote?: string;
  category: string;
  registryName?: string;
  source: 'curated' | 'registry';
  homepage?: string;
}

export interface McpCatalogResult {
  entries: McpCatalogEntry[];
  /** Set when the official registry could not be reached — curated only. */
  registryError?: string;
}

/** The multi-modal outcome of starting `claude mcp login` — as accounts do it. */
export interface McpLoginStart {
  id: string;
  command: string;
  mode: 'embedded' | 'external' | 'command';
  terminal?: { sessionId: string; token: string; expiresAt: number };
  detail?: string;
}

/** The MCP fetchers — merged into `api` by `./index`. */
export const mcpApi = {
  /* ---- MCP servers ---- */
  mcp: () => request<McpState>('/api/mcp'),
  /** Ungated: browsing what exists is how somebody decides to turn the flag on. */
  mcpCatalog: (query: string, registry = true) =>
    request<McpCatalogResult>(`/api/mcp/catalog?q=${q(query)}${registry ? '' : '&registry=0'}`),
  mcpAdd: (body: Record<string, unknown>) => post<{ server: McpServerView }>('/api/mcp', body),
  mcpDelete: (id: string) => request<{ removed: boolean }>(`/api/mcp/${q(id)}`, { method: 'DELETE' }),
  mcpPatch: (id: string, body: Record<string, unknown>) => request<{ server: McpServerView }>(
    `/api/mcp/${q(id)}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ),
  /** Starts `claude mcp login <id> --no-browser` where a person can answer it. */
  mcpLogin: (id: string) => post<McpLoginStart>(`/api/mcp/${q(id)}/login`, {}),
  /** Re-probe every enabled server. Not behind the flag — checking changes nothing. */
  mcpRefresh: () => post<{ servers: McpServerView[] }>('/api/mcp/refresh', {}),
  /** "I have seen that its tools changed." Clears the rug-pull flag. */
  mcpAcknowledge: (id: string) => post<{ acknowledged: boolean }>(`/api/mcp/${q(id)}/acknowledge`, {}),
};
