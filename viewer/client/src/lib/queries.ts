/**
 * The data plane: TanStack Query for *what is true*, the SSE stream for *when it
 * changed*.
 *
 * The old client cached responses in a Map and dropped entries when the server
 * said "changed". That worked, but the rule lived inside the fetch helper, so
 * "which events make which screen stale" was spread across every view that
 * happened to subscribe. Here it is one table — `EVENT_EFFECTS` — and the client
 * test asserts the table covers every event name the server can emit. An event
 * added on the server with no entry here is a test failure, not a screen that
 * quietly stops updating.
 *
 * Polling is off everywhere. The stream is the freshness signal; an interval on
 * top of it is a second, slower, wronger answer to the same question.
 */

import { useEffect } from 'react';
import {
  QueryClient,
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClientConfig,
} from '@tanstack/react-query';
import { api, type Approval, type ConsoleState, type PlanSummary } from './api';
import { SSE_EVENTS, onSse, type SseEvent } from './sse';

/* ---------------- keys ---------------- */

/**
 * Everything about one plan hangs off `['plan', slug]` on purpose.
 *
 * TanStack matches query keys by prefix, so the single `slugScoped: 'plan'`
 * invalidation in the table below reaches the plan detail, the open handoff, the
 * raw markdown and any boot prompt at once. The alternative — a flat key per
 * endpoint — means every new event has to remember every screen it affects, and
 * the one it forgets is the one that goes stale in front of you.
 */
export const keys = {
  state: () => ['state'] as const,
  plans: () => ['plans'] as const,
  plan: (slug: string) => ['plan', slug] as const,
  planRaw: (slug: string) => ['plan', slug, 'raw'] as const,
  handoff: (slug: string, phase: number | string) => ['plan', slug, 'handoff', String(phase)] as const,
  prompt: (slug: string, phase: number | string) => ['plan', slug, 'prompt', String(phase)] as const,
  nextPrompt: (slug: string, phase: number | string) => ['plan', slug, 'next-prompt', String(phase)] as const,
  qaPrompt: (slug: string, phase: number | string) => ['plan', slug, 'qa-prompt', String(phase)] as const,
  gate: (slug: string, phase: number | string) => ['plan', slug, 'gate', String(phase)] as const,
  stats: () => ['stats'] as const,
  approvals: () => ['approvals'] as const,
  runs: () => ['runs'] as const,
  run: (slug: string) => ['run', slug] as const,
  notifications: () => ['notifications'] as const,
  search: (query: string) => ['search', query] as const,
};

export const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // The stream invalidates; nothing needs a timer. `staleTime: Infinity`
      // plus explicit invalidation is the whole contract.
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
      retry: 1,
    },
  },
};

export const createQueryClient = (): QueryClient => new QueryClient(queryClientConfig);

/* ---------------- event → effect ---------------- */

/** What one event does to the cache. */
type Effect = {
  /** Key prefixes to invalidate. `slugKeys` adds per-slug plan/run keys. */
  invalidate?: readonly (readonly unknown[])[];
  /** Invalidate `['plan', slug]` / `['run', slug]` for the slug(s) in the payload. */
  slugScoped?: 'plan' | 'run' | 'both';
  /** Everything is suspect (a warm/reindex). */
  all?: boolean;
  /** Cheap in-place cache write instead of a refetch. */
  patch?: (client: QueryClient, data: Record<string, unknown>) => void;
  /** Deliberately invalidates nothing — see the note on each. */
  streamOnly?: true;
};

/** The unread badge travels on the event itself; refetching /api/state to learn
 *  a number the payload already carries is a round trip for nothing. */
const patchUnread: Effect['patch'] = (client, data) => {
  if (typeof data.unread !== 'number') return;
  client.setQueryData(keys.state(), (prev: ConsoleState | undefined) =>
    prev ? { ...prev, unread: data.unread as number } : prev);
};

export const EVENT_EFFECTS: Record<SseEvent, Effect> = {
  /* ---- the repo moved under us ---- */
  changed: { invalidate: [keys.plans(), keys.stats(), keys.state()], slugScoped: 'plan' },
  warm: { all: true },
  /* Watcher/server health is part of what `/api/state` reports (including
     `serverStale`, which the shell turns into a banner). */
  health: { invalidate: [keys.state()] },

  /* ---- approvals ---- */
  approval: { invalidate: [keys.approvals()] },
  // A card answered on a phone has to take the badge down on the laptop.
  'approval:resolved': { invalidate: [keys.approvals()] },

  /* ---- the inbox ---- */
  notification: { invalidate: [keys.notifications(), keys.state()] },
  'notification:delivery': { invalidate: [keys.notifications()] },
  'notification:read': { invalidate: [keys.notifications()], patch: patchUnread },
  'notification:cleared': { invalidate: [keys.notifications()], patch: patchUnread },

  /* ---- autopilot ----
     A run starting, finishing, or having a phase land changes the board too:
     `plans` carries each plan's ready-set, and that is what a finished phase
     moves. */
  'run:run': { invalidate: [keys.runs(), keys.plans()], slugScoped: 'both' },
  'run:phase': { invalidate: [keys.runs()], slugScoped: 'both' },
  'run:verify': { slugScoped: 'run' },
  'run:state': { invalidate: [keys.runs(), keys.plans()], slugScoped: 'both' },

  /* ---- the firehose ----
     These two arrive many times a second while a phase is talking. The run view
     subscribes to them directly and appends; routing them through the cache
     would refetch the whole run object per line. Invalidating nothing here is
     the point, not an omission. */
  'run:stream': { streamOnly: true },
  'run:journal': { streamOnly: true },
};

/** Slugs named by an event payload, in the two shapes the server uses. */
function slugsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as { slug?: unknown; slugs?: unknown };
  if (Array.isArray(record.slugs)) return record.slugs.filter((s): s is string => typeof s === 'string');
  if (typeof record.slug === 'string') return [record.slug];
  return [];
}

function applyEffect(client: QueryClient, name: SseEvent, data: unknown): void {
  const effect = EVENT_EFFECTS[name];
  if (!effect || effect.streamOnly) return;

  if (effect.all) { void client.invalidateQueries(); return; }

  for (const key of effect.invalidate ?? []) {
    void client.invalidateQueries({ queryKey: key });
  }

  if (effect.slugScoped) {
    for (const slug of slugsOf(data)) {
      if (effect.slugScoped !== 'run') void client.invalidateQueries({ queryKey: keys.plan(slug) });
      if (effect.slugScoped !== 'plan') void client.invalidateQueries({ queryKey: keys.run(slug) });
    }
  }

  if (effect.patch && data && typeof data === 'object') {
    effect.patch(client, data as Record<string, unknown>);
  }
}

/**
 * Mount once, in the shell. Wires every server event to its cache effect.
 */
export function useLiveData(): void {
  const client = useQueryClient();
  useEffect(() => {
    const offs = SSE_EVENTS.map((name) => onSse(name, (data) => applyEffect(client, name, data)));
    return () => { for (const off of offs) off(); };
  }, [client]);
}

/* ---------------- the shell's own queries ---------------- */

export function useConsoleState() {
  return useQuery({ queryKey: keys.state(), queryFn: api.state });
}

export function usePlans(enabled = true) {
  return useQuery({ queryKey: keys.plans(), queryFn: api.plans, enabled });
}

/**
 * A session parked on an approval is invisible until someone looks, so the badge
 * is kept current from wherever you happen to be in the app — but only on a
 * server that has a runner. Asking one that predates it just fills the browser
 * console with 404s.
 */
export function useApprovals(enabled: boolean) {
  return useQuery({ queryKey: keys.approvals(), queryFn: api.approvals, enabled });
}

/* ---------------- the plan surface ---------------- */

/**
 * One plan, and the fix for the defect that made the old plan view unusable
 * while anything else was happening.
 *
 * The old view held the detail in `useState`, and its `changed` subscriber set
 * it back to `null` before refetching — so *any* write anywhere in the repo
 * (another session finishing a phase, a file saved in an editor, the watcher
 * warming) blanked the page you were reading to a spinner and scrolled you back
 * to the top. `placeholderData: keepPreviousData` is the whole fix: the last
 * answer stays on screen while the next one is fetched, including across a slug
 * change, and `isFetching` is what says "a newer one is coming".
 */
export function usePlan(slug: string | undefined) {
  return useQuery({
    queryKey: keys.plan(slug ?? ''),
    queryFn: () => api.plan(slug!),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });
}

export function useHandoff(slug: string | undefined, phase: number | string | undefined) {
  return useQuery({
    queryKey: keys.handoff(slug ?? '', phase ?? ''),
    queryFn: () => api.handoff(slug!, phase!),
    enabled: Boolean(slug) && phase != null && phase !== '',
    placeholderData: keepPreviousData,
  });
}

export function usePlanRaw(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.planRaw(slug ?? ''),
    queryFn: () => api.planRaw(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * A gate's machine-checkable status. Only asked for phases that declare one —
 * the engine shells out per call, so this is not something to ask idly.
 */
export function useGateStatus(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.gate(slug ?? '', phase ?? ''),
    queryFn: () => api.gate(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    // A gate that cannot be evaluated is not an error worth retrying at people.
    retry: false,
  });
}

/** The numbers on the rail and the tab bar. */
export interface ShellCounts {
  plans: number;
  phases: number;
  ready: number;
  approvals: number;
  unread: number;
}

export function shellCounts(
  plans: PlanSummary[] | undefined,
  approvals: Approval[] | undefined,
  unread: number,
): ShellCounts {
  const list = plans ?? [];
  return {
    plans: list.filter((p) => p.kind === 'plan').length,
    phases: list.reduce((n, p) => n + (p.phases ?? 0), 0),
    ready: list.reduce((n, p) => n + (p.ready?.length ?? 0), 0),
    approvals: (approvals ?? []).filter((a) => a.status === 'pending').length,
    unread,
  };
}
