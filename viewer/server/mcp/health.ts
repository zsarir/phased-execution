/**
 * Is this server actually reachable, and is it signed in?
 *
 * There is exactly one honest way to ask, and it is not `claude mcp list`: that
 * command answers for the servers configured in a config dir, in prose, with
 * status glyphs. What the console needs is the answer for a SPECIFIC set — the
 * set a phase is about to board with — in a form a program can act on.
 *
 * So the probe is a real session that never gets to think:
 *
 *   claude -p "ok" --max-turns 1 --output-format stream-json --verbose
 *          --strict-mcp-config --mcp-config <the set>
 *
 * `system/init` is emitted BEFORE the first model call and carries
 * `mcp_servers: [{name, status}]` plus `mcp_server_errors` for entries that
 * failed config validation. We read that first line and kill the child, so the
 * probe costs a process and a connect, not a turn.
 *
 * Two properties this buys that nothing else does:
 *
 *  - the statuses are the ones THAT session would have seen, including
 *    `needs-auth`, which is the whole point of parking before boarding;
 *  - `init.tools` lists every `mcp__<server>__<tool>` name, which is the
 *    rug-pull fingerprint and the `requiresUserInteraction` audit for free.
 *
 * The poller posture from `accounts/usage.ts` applies unchanged: single-flight,
 * cached, and a failure degrades to the last known answer with its age
 * attached. A probe that cannot run is never an error page — the runner's own
 * classifier still works with health unavailable.
 */

import { spawn } from 'node:child_process';

import { log } from '../log.ts';
import type { McpConfigDoc } from './config.ts';

/** Statuses the CLI reports in `system/init`. Unknown values pass through. */
export type McpStatus = 'connected' | 'needs-auth' | 'pending' | 'failed' | 'unknown';

export type McpHealth = {
  id: string;
  status: McpStatus;
  /** Tool names this server advertised, without the `mcp__<id>__` prefix. */
  tools: string[];
  /** Why the CLI skipped this entry outright, when it did. */
  error?: { type: string; message: string };
};

export type McpProbe = {
  servers: McpHealth[];
  checkedAt: string;
  /** Set when the probe itself could not run — the servers list is then stale. */
  probeError?: string;
};

/** How long we wait for `system/init`. The CLI's own startup timeout is 30s. */
const PROBE_TIMEOUT_MS = 45_000;

export type ProbeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  /** Injected in tests so no suite ever spawns a real CLI. */
  spawnFn?: typeof spawn;
};

/**
 * Probe one config document. Never rejects: a probe that cannot run answers
 * with `probeError` set and an empty list, because "I could not check" and
 * "they are down" are different facts and the caller must be able to tell them
 * apart before it parks somebody's run.
 */
export async function probeMcp(doc: McpConfigDoc, opts: ProbeOptions = {}): Promise<McpProbe> {
  const now = opts.now ?? (() => new Date());
  const ids = Object.keys(doc.mcpServers);
  if (!ids.length) return { servers: [], checkedAt: now().toISOString() };

  const spawnFn = opts.spawnFn ?? spawn;
  const argv = [
    '--print', 'ok',
    '--max-turns', '1',
    '--output-format', 'stream-json',
    '--verbose',
    // The set under test is the only set: without this the CLI would union in
    // the user's own servers and the answer would be about the wrong thing.
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(doc),
  ];

  return new Promise<McpProbe>((resolve) => {
    let settled = false;
    let buffer = '';
    const finish = (probe: McpProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(probe);
    };

    const timer = setTimeout(
      () => finish({ servers: [], checkedAt: now().toISOString(), probeError: 'timed out waiting for the CLI' }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('claude', argv, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ servers: [], checkedAt: now().toISOString(), probeError: (error as Error).message });
      return;
    }

    child.on('error', (error: Error) => {
      finish({ servers: [], checkedAt: now().toISOString(), probeError: error.message });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // `system/init` is the first line unless a SessionStart hook or a plugin
      // install got there first, so scan rather than assume.
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        const parsed = parseInit(line);
        if (parsed) {
          finish({ servers: readInit(parsed, ids), checkedAt: now().toISOString() });
          return;
        }
        cut = buffer.indexOf('\n');
      }
    });

    child.on('close', (code) => {
      // Closed without ever emitting init: something stopped the CLI before it
      // got to its own startup, which is a probe failure, not a server verdict.
      finish({
        servers: [],
        checkedAt: now().toISOString(),
        probeError: `the CLI exited (${code ?? 'signal'}) before reporting server status`,
      });
    });
  });
}

type InitEvent = {
  type?: string;
  subtype?: string;
  tools?: unknown;
  mcp_servers?: unknown;
  mcp_server_errors?: unknown;
};

function parseInit(line: string): InitEvent | null {
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line) as InitEvent;
    return parsed?.type === 'system' && parsed?.subtype === 'init' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the event into one row per server we ASKED about.
 *
 * Driven by the ids we sent, not by what came back: a server the CLI dropped
 * silently must still appear, as `failed`, or the caller would read its absence
 * as "nothing to worry about".
 */
function readInit(event: InitEvent, asked: string[]): McpHealth[] {
  const statuses = new Map<string, McpStatus>();
  if (Array.isArray(event.mcp_servers)) {
    for (const row of event.mcp_servers as { name?: unknown; status?: unknown }[]) {
      if (typeof row?.name !== 'string') continue;
      statuses.set(row.name, normaliseStatus(row.status));
    }
  }

  const errors = new Map<string, { type: string; message: string }>();
  if (Array.isArray(event.mcp_server_errors)) {
    for (const row of event.mcp_server_errors as { name?: unknown; type?: unknown; message?: unknown }[]) {
      if (typeof row?.name !== 'string') continue;
      errors.set(row.name, {
        type: typeof row.type === 'string' ? row.type : 'unknown',
        message: typeof row.message === 'string' ? row.message : 'the CLI skipped this entry',
      });
    }
  }

  const tools = new Map<string, string[]>();
  if (Array.isArray(event.tools)) {
    for (const tool of event.tools) {
      if (typeof tool !== 'string') continue;
      // `mcp__<server>__<tool>`. A server id may not contain `__`, so the first
      // separator after the prefix is the boundary.
      const rest = tool.startsWith('mcp__') ? tool.slice(5) : '';
      const split = rest.indexOf('__');
      if (split <= 0) continue;
      const id = rest.slice(0, split);
      const name = rest.slice(split + 2);
      tools.set(id, [...(tools.get(id) ?? []), name]);
    }
  }

  return asked.map((id) => {
    const error = errors.get(id);
    const status: McpStatus = error ? 'failed' : statuses.get(id) ?? 'failed';
    return {
      id,
      status,
      tools: (tools.get(id) ?? []).sort(),
      ...(error ? { error } : {}),
    };
  });
}

function normaliseStatus(value: unknown): McpStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (raw) {
    case 'connected': return 'connected';
    case 'pending': return 'pending';
    case 'failed': return 'failed';
    case 'needs-auth':
    case 'needs_auth':
    case 'needsauth':
      return 'needs-auth';
    default:
      if (raw) log.warn('mcp.health.unknown-status', { status: raw });
      return 'unknown';
  }
}

/**
 * Whether this status should stop a phase from boarding.
 *
 * `pending` deliberately does not: a remote server with a cached tool list
 * reports pending and connects on its first tool call, which is normal and
 * costs the run nothing. Only a wall — no credentials, or no server — parks.
 */
export function blocksBoarding(status: McpStatus): boolean {
  return status === 'needs-auth' || status === 'failed';
}
