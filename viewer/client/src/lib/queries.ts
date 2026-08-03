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

import { useEffect, useMemo } from 'react';
import {
  QueryClient,
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClientConfig,
} from '@tanstack/react-query';
import {
  api,
  type ConsoleState, type InboxQuery, type NotificationScope, type PlanDetail, type PlanSummary,
  type TerminalState,
} from './api';
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
  terminal: () => ['terminal'] as const,
  approvals: () => ['approvals'] as const,
  runs: () => ['runs'] as const,
  run: (slug: string) => ['run', slug] as const,
  /**
   * Deliberately NOT under `['run', slug]`.
   *
   * Everything else about a plan hangs off its prefix so one event refreshes the
   * lot — but these two must not. The transcript is a one-shot replay of up to
   * 4 MB that live events supersede the moment it lands, and a diagnosis costs a
   * `git status` and two script runs. Under the run prefix, every `run:phase`
   * would refetch both; the console would re-hydrate from the network several
   * times a minute to learn nothing it was not already being told.
   */
  transcript: (slug: string) => ['transcript', slug] as const,
  diagnosis: (slug: string, phase: number | string) => ['diagnosis', slug, String(phase)] as const,
  auth: () => ['auth'] as const,
  skills: () => ['skills'] as const,
  notifications: () => ['notifications'] as const,
  search: (query: string) => ['search', query] as const,
  /** Both push keys sit under one prefix so subscribing refreshes the register. */
  push: () => ['push'] as const,
  policy: (slug: string) => ['policy', slug] as const,
  restart: () => ['restart'] as const,
  shutdown: () => ['shutdown'] as const,
  browse: (path: string) => ['browse', path] as const,
  rootCheck: (path: string) => ['root-check', path] as const,
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

/** The session list travels on the event; writing it beats asking for it back. */
const patchSessions: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.sessions)) return;
  client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) => (prev
    ? {
      ...prev,
      sessions: data.sessions as TerminalState['sessions'],
      ...(typeof data.live === 'number' ? { live: data.live as number } : {}),
    }
    : prev));
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

  /* ---- sessions ----
     The list rides on the event, so this is a cache write rather than a
     refetch: a session appearing or ending must reach the dashboard card and
     the nav badges in the same tick, and there is nothing to ask for that the
     payload does not already carry. Invalidation stays as the belt to that
     braces — `/api/terminal` also answers `available` and the flags. */
  sessions: { invalidate: [keys.terminal()], patch: patchSessions },

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

/** How long a page has to stay open before opening it counts as reading. */
const AUTO_READ_DELAY_MS = 1_200;

/**
 * Opening the page that a notification is about counts as reading it.
 *
 * The 182-unread inbox was two failures compounding. P1 fixed the first — a
 * category that was off still recorded. This is the second: nothing ever became
 * read *by being looked at*, so the only way the count ever fell was a bulk
 * clear, which is indistinguishable from giving up on the inbox entirely.
 *
 * Three properties make it safe to do automatically:
 *
 *  - **Scoped, never global.** The server matches on the record's own `slug` /
 *    `runId` / `phase`, and an empty scope matches nothing — so a route whose
 *    slug has not parsed yet clears zero records rather than the inbox.
 *  - **Delayed.** Tabbing through plans should not silently mark six plans'
 *    notifications read; staying long enough to read one should.
 *  - **Only when there is something to clear.** Gated on the unread count the
 *    shell already holds, so the ordinary visit costs no request at all.
 *
 * The badge and any open inbox update from the `notification:read` event the
 * server emits, which is why nothing is invalidated here.
 */
export function useAutoReadNotifications(scope: NotificationScope, enabled = true): void {
  const { data: state } = useConsoleState();
  const unread = state?.unread ?? 0;
  // A stable identity for the scope object, so a caller may build it inline.
  const key = JSON.stringify(scope);

  useEffect(() => {
    if (!enabled || unread < 1) return undefined;
    const parsed = JSON.parse(key) as NotificationScope;
    if (!Object.values(parsed).some((value) => value !== undefined && value !== '')) return undefined;

    const timer = setTimeout(() => {
      // Fire-and-forget: a failed read marker must never surface as an error on
      // a page the operator opened to read something else.
      void api.markNotificationsReadFor(parsed).catch(() => {});
    }, AUTO_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, key, unread]);
}

/**
 * Which sessions exist — live and ended, shells and agents, one registry.
 *
 * This used to be deliberately absent from `EVENT_EFFECTS`, on the reasoning
 * that the socket IS a session's live channel and a list refreshed by unrelated
 * events would be noise. That reasoning was sound for the session's own page and
 * wrong everywhere else: the dashboard's list of what is running, the nav
 * badges, and a second browser you opened all need to know, and none of them
 * holds that socket. So the server emits `sessions` and this follows it.
 */
export function useTerminals(enabled = true) {
  return useQuery({ queryKey: keys.terminal(), queryFn: api.terminal, enabled });
}

/**
 * The same list, for the surfaces that want it regardless of which page they
 * are on. Enabled whenever the console can have a session of either kind — the
 * Agent page asks with `allowAgent`, the Terminal page with `allowTerminal`,
 * and the shell wants the union.
 */
export function useSessions(state: ConsoleState | undefined) {
  return useTerminals(state?.allowTerminal === true || state?.allowAgent === true);
}

/** What Shut down is about to stop. Read before the dialog opens, not after. */
export function useShutdownReadiness(enabled = true) {
  return useQuery({ queryKey: keys.shutdown(), queryFn: api.shutdownReadiness, enabled });
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

/**
 * Several plans at once, under the same `['plan', slug]` keys as `usePlan`.
 *
 * The ready queue and the dashboard both need facts `/api/plans` does not carry
 * — a phase's title, its size, whether it is gated, how much it unblocks — and
 * those live in the per-plan detail. Fetching them here rather than adding a
 * server endpoint keeps the frozen API frozen, and because the keys are shared,
 * the board warms the cache for exactly the plans you are most likely to open
 * next: clicking through to one is then instant.
 *
 * The cost is bounded by the caller passing a short list, and by the server's
 * own cache — a cold plan costs an engine invocation, a warm one costs nothing.
 * Callers render from the summary first and let each row upgrade as its detail
 * lands, so a slow plan delays a title, never the page.
 *
 * ⚠️ **The map is built in a `useMemo`, not in `useQueries`' `combine`.** A
 * `combine` that returns a `Map` returns a value TanStack's structural sharing
 * cannot compare, so every render produces a new snapshot for the
 * `useSyncExternalStore` behind `useQueries` — which re-renders, which combines
 * again. The symptom is not a slow page: React blows the update-depth limit and
 * throws during render, so the *whole app* goes blank and the console only says
 * "an error occurred in <ReadyView>". Keep the derived shape out of `combine`.
 */
export function usePlanDetails(slugs: readonly string[], enabled = true) {
  const results = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: keys.plan(slug),
      queryFn: () => api.plan(slug),
      enabled,
      // A plan whose engine run fails should leave a row un-enriched, not retry
      // a shell-out at somebody several times over.
      retry: false,
    })),
  });

  const bySlug = useMemo(() => {
    const map = new Map<string, PlanDetail>();
    results.forEach((result, i) => {
      if (result.data) map.set(slugs[i], result.data);
    });
    return map;
    // `results` is a fresh array each render, so this recomputes each time. That
    // is a dozen map writes, and it is the price of not handing React a value it
    // has to diff. It cannot loop: nothing here feeds a store.
  }, [results, slugs]);

  return { bySlug, loading: results.some((r) => r.isPending) };
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

/* ---------------- the autopilot ---------------- */

/**
 * One plan's run, its history and its ETA.
 *
 * `keepPreviousData` for the same reason the plan detail has it: a run emits
 * `run:phase` every few seconds while it works, and each one invalidates this
 * key. Dropping to a skeleton on every phase event would make the tab unusable
 * precisely while there is something to watch.
 *
 * `enabled` is the stale-server guard. A console whose server predates the
 * autopilot has no run endpoints, and asking anyway just fills the browser
 * console with 404s — the view says so instead.
 */
export function useRun(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.run(slug ?? ''),
    queryFn: () => api.run(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Every run of every plan, newest first.
 *
 * `keepPreviousData` for the same reason `useRun` has it, and it matters more
 * here: a live run emits `run:phase` every few seconds and `EVENT_EFFECTS`
 * invalidates this key on each one. Without a placeholder the fleet table — and
 * the dashboard's live strip — would drop to a skeleton every few seconds
 * precisely while there is something to watch.
 */
export function useRuns(enabled = true) {
  return useQuery({
    queryKey: keys.runs(),
    queryFn: api.runs,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The recorded events of a run, replayed once into the console.
 *
 * Never invalidated (see `keys.transcript`): what happened after it was read
 * arrives on the live stream, and re-reading it would only re-deliver events the
 * console already folded. A missing replay is not an error worth showing.
 */
export function useTranscript(slug: string | undefined, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...keys.transcript(slug ?? ''), id ?? 'latest'],
    queryFn: () => api.runTranscript(slug!, id),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/** Fetched when a diagnosis panel is opened, because most rows are never opened. */
export function useDiagnosis(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.diagnosis(slug ?? '', phase ?? ''),
    queryFn: () => api.phaseDiagnosis(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    retry: false,
  });
}

/**
 * Whether the CLI is signed in.
 *
 * A signed-out session does not look like a failure: it reports success, uses
 * one turn, costs nothing and changes nothing. `force` re-probes rather than
 * reading the server's cache — what the "Check again" button is for.
 */
export function useAuth(enabled: boolean) {
  return useQuery({ queryKey: keys.auth(), queryFn: () => api.auth(), enabled, retry: false });
}

/** Cached server-side, so switching tabs does not rescan a few hundred SKILL.md files. */
export function useSkills(enabled: boolean) {
  return useQuery({ queryKey: keys.skills(), queryFn: api.skills, enabled, retry: false });
}

/* ---------------- the remaining surfaces ---------------- */

/**
 * The whole portfolio — every plan read, every issue collected.
 *
 * It is invalidated by `changed` like the plans list, because it is the same
 * facts aggregated: a phase landing moves the velocity chart and the ready
 * total, and a stats page that disagrees with the board it sits beside is worse
 * than no stats page.
 */
export function useStats(enabled = true) {
  return useQuery({ queryKey: keys.stats(), queryFn: api.stats, enabled });
}

/**
 * Full-text search, debounced by the caller.
 *
 * Keyed by the query text so every distinct search is its own cache entry and
 * going back to a previous term is instant. `keepPreviousData` keeps the last
 * result on screen while a longer term is fetched — a list that blanks on every
 * keystroke is unreadable at typing speed.
 */
export function useSearch(query: string) {
  const text = query.trim();
  return useQuery({
    queryKey: keys.search(text),
    queryFn: () => api.search(text),
    enabled: text.length >= 2,
    placeholderData: keepPreviousData,
  });
}

/**
 * One page of the inbox.
 *
 * The filters are part of the key: "unread only, approvals, 60 rows" is a
 * different answer from the server, not a client-side slice of one. `EVENT_
 * EFFECTS` invalidates the `notifications` prefix on all four inbox events, so
 * every variant a tab is holding refreshes together — which is what makes a
 * card answered on a phone take the badge down here.
 */
export function useInbox(query: InboxQuery) {
  return useQuery({
    queryKey: [...keys.notifications(), query.category ?? '', query.unread ?? false, query.limit ?? 60],
    queryFn: () => api.notifications(query),
    placeholderData: keepPreviousData,
  });
}

/** The push register: which devices are subscribed, and to what. */
export function usePush(enabled = true) {
  return useQuery({ queryKey: keys.push(), queryFn: api.push, enabled, retry: false });
}

/**
 * The permission rules, at one scope.
 *
 * `retry: false` because a console whose server predates the policy endpoint
 * answers 404 and will keep answering 404; the card hides rather than retrying
 * at somebody.
 */
export function usePolicy(slug: string | undefined) {
  return useQuery({
    queryKey: keys.policy(slug ?? ''),
    queryFn: () => api.policy(slug || undefined),
    retry: false,
  });
}

/** Whether this console can restart itself — asked before the button renders. */
export function useRestartReadiness(enabled = true) {
  return useQuery({
    queryKey: keys.restart(),
    queryFn: api.restartReadiness,
    enabled,
    retry: false,
  });
}

/**
 * One directory's sub-directories, for the picker.
 *
 * Never invalidated by an event: the file system is not what the console
 * watches, and a picker that refetched on every `changed` would fight the
 * person typing in it. `keepPreviousData` keeps the list stable while walking
 * into a folder.
 */
export function useDirListing(path: string) {
  return useQuery({
    queryKey: keys.browse(path),
    queryFn: () => api.browse(path),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Whether a path is a source directory — the Open button's whole basis. */
export function useRootCheck(path: string) {
  return useQuery({
    queryKey: keys.rootCheck(path),
    queryFn: () => api.checkRoot(path),
    enabled: path.trim().length > 0,
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
  /** Live claude sessions — the Agent entry's badge. */
  agentSessions: number;
  /** Live shells — the Terminal entry's badge. */
  terminalSessions: number;
}

export function shellCounts(
  plans: PlanSummary[] | undefined,
  // Only the status is read, and saying so keeps this callable with a stub: the
  // full `Approval` is a nine-field server shape, and a counting function should
  // not demand one to be tested.
  approvals: readonly { status: string }[] | undefined,
  unread: number,
  // Both kinds arrive in one list from one registry; the nav shows each page
  // its own, because a single number on two entries reads as double-counting.
  // Ended records are excluded — a badge is "what is running", not history.
  sessions?: readonly { kind?: string; exited?: unknown }[],
): ShellCounts {
  const list = plans ?? [];
  const live = (sessions ?? []).filter((session) => !session.exited);
  return {
    plans: list.filter((p) => p.kind === 'plan').length,
    phases: list.reduce((n, p) => n + (p.phases ?? 0), 0),
    ready: list.reduce((n, p) => n + (p.ready?.length ?? 0), 0),
    approvals: (approvals ?? []).filter((a) => a.status === 'pending').length,
    unread,
    agentSessions: live.filter((session) => session.kind === 'claude').length,
    terminalSessions: live.filter((session) => (session.kind ?? 'shell') === 'shell').length,
  };
}
