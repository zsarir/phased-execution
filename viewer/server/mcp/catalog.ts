/**
 * Servers worth suggesting, and where to find the rest.
 *
 * Two sources, in that order of trust:
 *
 *  1. **The shipped list below.** Small, curated, and every entry's endpoint or
 *     package was verified reachable when it was added. It works offline, which
 *     matters because the console is a localhost tool and the catalog is most
 *     useful exactly when somebody is setting a machine up.
 *  2. **The official registry** at `registry.modelcontextprotocol.io`, searched
 *     on demand. Thousands of servers, published by anyone. Results are marked
 *     as such and never merged into the curated set, because "in the registry"
 *     is a statement about publication, not about trust.
 *
 * A network failure degrades to the curated list with a note. It is never an
 * error page: the operator's actual job — add a server I already know I want —
 * does not depend on the registry being up.
 *
 * **Keep the list SHORT.** Every attached server costs context on every turn
 * and adds a name that can collide with another server's tools; the practical
 * advice the ecosystem has converged on is three to six, not fifteen. A catalog
 * that reads like an app store invites the opposite. Entries earn their place
 * by being the ones a coding agent actually reaches for.
 */

import { log } from '../log.ts';
import type { McpSecretRef, McpTransport } from './store.ts';

export type CatalogEntry = {
  /** The id this would register under, and the token a plan would name. */
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  /** `oauth` needs `claude mcp login`; `header`/`env` need a value from us. */
  auth: 'none' | 'oauth' | 'header' | 'env';
  secretRefs?: McpSecretRef[];
  /** What the operator would have to fetch, when `auth` is not `none`/`oauth`. */
  authNote?: string;
  /** Grouping in the picker. Free text, not a schema. */
  category: string;
  /** The registry's own name, when this came from there rather than from us. */
  registryName?: string;
  source: 'curated' | 'registry';
  homepage?: string;
};

const BEARER: McpSecretRef = { kind: 'header', name: 'Authorization', template: 'Bearer {}' };

/**
 * The curated set. Endpoints below were each confirmed to answer an MCP
 * `initialize` (401 for the OAuth ones, 200 for the open ones) and each npm
 * package confirmed to exist, on 2026-08-09. Re-check before adding to it.
 */
export const CURATED: Omit<CatalogEntry, 'source'>[] = [
  // ---- the ones a coding agent reaches for most --------------------------
  {
    id: 'github', label: 'GitHub', category: 'Code & review',
    description: 'Read and comment on pull requests, search code across repos, triage issues, '
      + 'inspect failing CI runs.',
    transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    auth: 'header', secretRefs: [BEARER],
    authNote: 'A fine-grained personal access token scoped to the repositories Claude may touch — '
      + 'github.com/settings/personal-access-tokens.',
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'playwright', label: 'Playwright', category: 'Browser',
    description: 'Drive a real browser through the accessibility tree — navigate, click, fill, read '
      + 'the page. Turns "I made the change" into "I made the change and watched it render".',
    transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    auth: 'none', homepage: 'https://playwright.dev/docs/getting-started-mcp',
  },
  {
    id: 'context7', label: 'Context7', category: 'Docs',
    description: 'Version-specific documentation for libraries and frameworks, fetched on demand '
      + 'instead of recalled from training.',
    transport: 'http', url: 'https://mcp.context7.com/mcp',
    auth: 'none', homepage: 'https://context7.com',
  },
  {
    id: 'chrome-devtools', label: 'Chrome DevTools', category: 'Browser',
    description: 'Performance traces, console, network and the DOM of a running Chrome — debugging '
      + 'a page rather than merely driving it.',
    transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'],
    auth: 'none', homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    id: 'sentry', label: 'Sentry', category: 'Observability',
    description: 'The errors your application actually reported: stack traces, frequency, and which '
      + 'deployment introduced them.',
    transport: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth',
    homepage: 'https://mcp.sentry.dev',
  },
  {
    id: 'linear', label: 'Linear', category: 'Issue tracking',
    description: 'Issues, projects, comments and cycles — so a phase can start from the ticket that '
      + 'asked for it.',
    transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth',
    homepage: 'https://linear.app/docs/mcp',
  },

  // ---- knowledge and search ----------------------------------------------
  {
    id: 'deepwiki', label: 'DeepWiki', category: 'Docs',
    description: 'Ask questions about any public GitHub repository and get answers grounded in its '
      + 'code — useful for a dependency you have to understand but do not own.',
    transport: 'http', url: 'https://mcp.deepwiki.com/mcp', auth: 'none',
    homepage: 'https://deepwiki.com',
  },
  {
    id: 'huggingface', label: 'Hugging Face', category: 'Docs',
    description: 'Models, datasets, papers and Spaces on the Hub.',
    transport: 'http', url: 'https://huggingface.co/mcp', auth: 'none',
    homepage: 'https://huggingface.co/settings/mcp',
  },

  // ---- product surfaces ---------------------------------------------------
  {
    id: 'notion', label: 'Notion', category: 'Docs',
    description: 'Pages, databases, comments and workspace search.',
    transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth',
    homepage: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'figma', label: 'Figma', category: 'Design',
    description: 'Files, designs and Dev Mode context — the source of truth a UI phase is supposed '
      + 'to be implementing.',
    transport: 'http', url: 'https://mcp.figma.com/mcp', auth: 'oauth',
    homepage: 'https://www.figma.com/developers/mcp',
  },
  {
    id: 'atlassian', label: 'Jira & Confluence', category: 'Issue tracking',
    description: 'Atlassian’s own endpoint for Jira issues and Confluence pages.',
    transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse', auth: 'oauth',
    homepage: 'https://support.atlassian.com/atlassian-rovo-mcp-server/',
  },

  // ---- infrastructure -----------------------------------------------------
  {
    id: 'vercel', label: 'Vercel', category: 'Infrastructure',
    description: 'Deployments, build logs, runtime errors and project configuration.',
    transport: 'http', url: 'https://mcp.vercel.com', auth: 'oauth',
    homepage: 'https://vercel.com/docs/mcp/vercel-mcp',
  },
  {
    id: 'supabase', label: 'Supabase', category: 'Data',
    description: 'Projects, database schema and docs.',
    transport: 'http', url: 'https://mcp.supabase.com/mcp', auth: 'oauth',
    homepage: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'cloudflare-docs', label: 'Cloudflare docs', category: 'Docs',
    description: 'Cloudflare’s documentation, searchable. No account needed.',
    transport: 'http', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'grafana', label: 'Grafana', category: 'Observability',
    description: 'Dashboards, datasources, Prometheus and Loki queries, incidents.',
    transport: 'http', url: 'https://mcp.grafana.com/mcp', auth: 'oauth',
    homepage: 'https://grafana.com/docs/grafana/latest/observability-as-code/mcp-server/',
  },

  // ---- local, no network --------------------------------------------------
  {
    id: 'postgres', label: 'PostgreSQL (DBHub)', category: 'Data',
    description: 'Query a relational database through a connection string. Point it at a READ-ONLY '
      + 'user — an unattended run should not be able to write to your database.',
    transport: 'stdio', command: 'npx',
    args: ['-y', '@bytebase/dbhub', '--dsn', '${DATABASE_URL}'],
    auth: 'env',
    authNote: 'Set DATABASE_URL in the console’s own environment before starting it — a read-only DSN.',
    homepage: 'https://github.com/bytebase/dbhub',
  },
  {
    id: 'filesystem', label: 'Filesystem', category: 'Local',
    description: 'Read and write files under directories you name. Rarely worth attaching: Claude '
      + 'Code already has Read, Write and Edit scoped to the working tree.',
    transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'],
    auth: 'env',
    authNote: 'Set MCP_FS_ROOT to the directory this server may see.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'memory', label: 'Memory', category: 'Local',
    description: 'A knowledge graph the session can write to and read back — persistent notes across '
      + 'phases, in a plan whose phases genuinely need to share findings.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    auth: 'none', homepage: 'https://github.com/modelcontextprotocol/servers',
  },
];

/** The curated list, filtered by a search string over id, label and description. */
export function searchCurated(query: string): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const all = CURATED.map((entry) => ({ ...entry, source: 'curated' as const }));
  if (!needle) return all;
  return all.filter((entry) =>
    entry.id.includes(needle)
    || entry.label.toLowerCase().includes(needle)
    || entry.category.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle));
}

export type CatalogResult = {
  entries: CatalogEntry[];
  /** Set when the registry could not be reached — the entries are curated only. */
  registryError?: string;
};

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_TIMEOUT_MS = 8_000;

/**
 * Curated matches first, then whatever the official registry adds.
 *
 * `version=latest` matters: without it the registry returns every published
 * version of every server and the list reads as duplicates.
 */
export async function searchCatalog(
  query: string,
  opts: { limit?: number; fetchFn?: typeof fetch; includeRegistry?: boolean } = {},
): Promise<CatalogResult> {
  const curated = searchCurated(query);
  if (opts.includeRegistry === false || !query.trim()) return { entries: curated };

  const known = new Set(curated.map((entry) => entry.id));
  try {
    const doFetch = opts.fetchFn ?? fetch;
    const url = `${REGISTRY_URL}?search=${encodeURIComponent(query.trim())}`
      + `&version=latest&limit=${Math.min(opts.limit ?? 20, 50)}`;
    const response = await doFetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the registry answered ${response.status}`);
    const body = await response.json() as { servers?: unknown };
    const found = Array.isArray(body?.servers) ? body.servers : [];
    const entries: CatalogEntry[] = [];
    for (const row of found) {
      const entry = fromRegistry(row);
      if (entry && !known.has(entry.id)) {
        known.add(entry.id);
        entries.push(entry);
      }
    }
    return { entries: [...curated, ...entries] };
  } catch (error) {
    // Degrade, never fail: the curated list is the answer to most questions and
    // the operator's own reason for opening this page does not need the network.
    log.warn('mcp.catalog.registry-unreachable', { error: (error as Error).message });
    return { entries: curated, registryError: (error as Error).message };
  }
}

type RegistryRow = {
  server?: {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    websiteUrl?: unknown;
    remotes?: unknown;
    packages?: unknown;
  };
};

/**
 * One registry row → a catalog entry, or null when we cannot start it.
 *
 * Remotes are preferred over packages: an HTTP endpoint needs no install and
 * supports OAuth, while a package means running somebody's code locally. A row
 * offering neither is skipped rather than shown as something that cannot be added.
 */
function fromRegistry(row: unknown): CatalogEntry | null {
  const server = (row as RegistryRow)?.server;
  if (!server || typeof server.name !== 'string') return null;

  // Registry names are reverse-DNS (`io.github.owner/server`); the last segment
  // is what a person would call it and what our id rules accept.
  const id = server.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) ?? '';
  if (!id) return null;

  const label = typeof server.title === 'string' && server.title.trim() ? server.title : id;
  const description = typeof server.description === 'string' ? server.description : '';
  const homepage = typeof server.websiteUrl === 'string' ? server.websiteUrl : undefined;

  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  for (const remote of remotes as { type?: unknown; url?: unknown; headers?: unknown }[]) {
    if (typeof remote?.url !== 'string') continue;
    const raw = typeof remote.type === 'string' ? remote.type : 'http';
    const transport: McpTransport = raw === 'sse' ? 'sse' : raw === 'ws' ? 'ws' : 'http';
    const headers = Array.isArray(remote.headers) ? remote.headers : [];
    const secret = (headers as { name?: unknown; isSecret?: unknown }[])
      .find((header) => header?.isSecret === true && typeof header.name === 'string');
    return {
      id, label, description, transport, url: remote.url,
      auth: secret ? 'header' : 'oauth',
      ...(secret ? { secretRefs: [{ kind: 'header' as const, name: String(secret.name) }] } : {}),
      category: 'From the registry', registryName: server.name, source: 'registry',
      ...(homepage ? { homepage } : {}),
    };
  }

  const packages = Array.isArray(server.packages) ? server.packages : [];
  for (const pkg of packages as { registryType?: unknown; identifier?: unknown; runtimeHint?: unknown }[]) {
    if (typeof pkg?.identifier !== 'string') continue;
    if (pkg.registryType !== 'npm') continue;   // pypi/oci would need a different runner
    return {
      id, label, description, transport: 'stdio',
      command: typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : 'npx',
      args: ['-y', pkg.identifier],
      auth: 'none',
      category: 'From the registry', registryName: server.name, source: 'registry',
      ...(homepage ? { homepage } : {}),
    };
  }

  return null;
}
