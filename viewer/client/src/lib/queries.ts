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
  type AccountsState,
  type ConsoleState,
  type InboxQuery,
  type NotificationScope,
  type PlanDetail,
  type PlanSummary,
  type TerminalState,
  type McpState,
  type SessionRegistryView,
  type ConvergeView,
  type ConvergeStatusView,
} from './api';
import { isClosed } from './closure';
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
  verifyPreflight: (slug: string) => ['plan', slug, 'verify-preflight'] as const,
  handoff: (slug: string, phase: number | string) => ['plan', slug, 'handoff', String(phase)] as const,
  prompt: (slug: string, phase: number | string) => ['plan', slug, 'prompt', String(phase)] as const,
  nextPrompt: (slug: string, phase: number | string) => ['plan', slug, 'next-prompt', String(phase)] as const,
  qaPrompt: (slug: string, phase: number | string) => ['plan', slug, 'qa-prompt', String(phase)] as const,
  gate: (slug: string, phase: number | string) => ['plan', slug, 'gate', String(phase)] as const,
  stats: () => ['stats'] as const,
  terminal: () => ['terminal'] as const,
  /** The session-presence registry — every Claude session the hook reported for this instance. */
  sessionRegistry: () => ['sessions', 'registry'] as const,
  converge: () => ['converge'] as const,
  /** Is the session-presence hook in `~/.claude/settings.json`? */
  hooksStatus: () => ['hooks-status'] as const,
  approvals: () => ['approvals'] as const,
  runs: () => ['runs'] as const,
  run: (slug: string) => ['run', slug] as const,
  /**
   * Admission, and it is deliberately NOT under `['run', slug]`.
   *
   * Both answer questions about *other* plans: what is holding the scope this
   * phase wants, and what would collide if it started now. `run:queue` — the one
   * event that moves them — is not slug-scoped precisely because a grant released
   * on plan A is what unblocks plan B, so these have to be reachable without
   * knowing whose release it was. `['scopes']` as a bare prefix invalidates every
   * plan's answer at once, which is what a release actually changes.
   */
  queue: () => ['queue'] as const,
  tailscale: () => ['tailscale'] as const,
  scopes: (slug: string) => ['scopes', slug] as const,
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
  /**
   * The journal, and — like the transcript above — deliberately NOT under
   * `['run', slug]`.
   *
   * It is a one-shot read of the last N lines that the live `run:journal`
   * firehose supersedes line by line. Under the run prefix every `run:phase`
   * would re-read the whole tail from disk to learn what the stream had
   * already appended.
   */
  journal: (slug: string, id?: number | string) => ['journal', slug, String(id ?? 'latest')] as const,
  /**
   * The plan's ruling ledger. Its own key for a different reason: it is per
   * PLAN, not per run, and it outlives every run of that plan. Nothing but
   * `run:rulings` moves it.
   */
  rulings: (slug: string) => ['rulings', slug] as const,
  /** Money, instance-wide: today against the day cap, per run, and the 7-day series. */
  spend: () => ['spend'] as const,
  /**
   * The unified attention inbox — everything that needs a person.
   *
   * A prefix with the `all` flag under it, so the Now section (open items) and
   * the bell drawer's "including acknowledged" view are two cache entries that
   * ONE `keys.inbox()` invalidation refreshes together. Answering a card on a
   * phone has to take the row off the laptop, and the two surfaces are usually
   * both mounted.
   *
   * Deliberately NOT `keys.notifications()`: that is the LOG of what the
   * console announced, and this is the list of what is still waiting. They
   * were one word apart and two different questions, which is how the badge
   * ended up counting the wrong one.
   */
  inbox: (all?: boolean) => (all == null ? (['inbox'] as const) : (['inbox', all] as const)),
  auth: () => ['auth'] as const,
  accounts: () => ['accounts'] as const,
  mcp: () => ['mcp'] as const,
  mcpCatalog: (query: string) => ['mcp', 'catalog', query] as const,
  launcher: () => ['launcher'] as const,
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
    prev ? { ...prev, unread: data.unread as number } : prev,
  );
};

/** The account list travels on the event; writing it beats asking for it back. */
const patchAccounts: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.accounts)) return;
  client.setQueryData(keys.accounts(), (prev: AccountsState | undefined) => ({
    accounts: data.accounts as AccountsState['accounts'],
    allowAccounts: prev?.allowAccounts ?? false,
  }));
};

/** The server list travels on the event; writing it beats asking for it back. */
const patchMcp: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.servers)) return;
  client.setQueryData(keys.mcp(), (prev: McpState | undefined) => ({
    servers: data.servers as McpState['servers'],
    allowMcp: prev?.allowMcp ?? false,
  }));
};

/** The session list travels on the event; writing it beats asking for it back. */
const patchSessions: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.sessions)) {
    client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
      prev
        ? {
            ...prev,
            sessions: data.sessions as TerminalState['sessions'],
            ...(typeof data.live === 'number' ? { live: data.live as number } : {}),
          }
        : prev,
    );
  }
  // A recovery verdict moves the run record server-side (the write-back), and
  // a NOT-fixed verdict moves nothing that would emit `run:state` — so the run
  // and plan queries are re-read off the same event either way. This payload
  // had no consumer at all for a while: the run was fixed on disk and every
  // open tab kept the halt banner until a manual reload.
  if (data.type === 'recovery-outcome') {
    void client.invalidateQueries({ queryKey: keys.runs() });
    const slug = (data.recovery as { slug?: string } | undefined)?.slug;
    if (slug) {
      void client.invalidateQueries({ queryKey: keys.run(slug) });
      void client.invalidateQueries({ queryKey: keys.plan(slug) });
    }
  }
};

/** The `foreign` list the server appends to every `sessions` event — the registry, written straight into the cache. */
const patchPresence: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.foreign)) {
    client.setQueryData<SessionRegistryView>(keys.sessionRegistry(), {
      sessions: data.foreign as SessionRegistryView['sessions'],
    });
  }
};
/** A finished convergence pass: merge its view into the cache by slug — the full report rides the event. */
const patchConverge: Effect['patch'] = (client, data) => {
  if (!data || typeof data.slug !== 'string' || !Array.isArray(data.actions)) return;
  const view = data as unknown as ConvergeView;
  client.setQueryData<ConvergeStatusView>(keys.converge(), (current) => {
    const rest = (current?.reports ?? []).filter((report) => report.slug !== view.slug);
    return {
      automatic: current?.automatic ?? true,
      everyMs: current?.everyMs ?? 0,
      pending: (current?.pending ?? []).filter((p) => p.slug !== view.slug),
      running: (current?.running ?? []).filter((slug) => slug !== view.slug),
      reports: [...rest, view],
    };
  });
};

export const EVENT_EFFECTS: Record<SseEvent, Effect> = {
  /* ---- the repo moved under us ---- */
  // Queue and runs ride along: lock files live under docs/handoffs, so a
  // foreign claim or release arrives as `changed` — and the queue page used
  // to sit stale (observed live: entries [] while a real manual lock held
  // the phase) because nothing here invalidated it.
  changed: {
    invalidate: [keys.plans(), keys.stats(), keys.state(), keys.queue(), keys.runs()],
    slugScoped: 'plan',
  },
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

  /* ---- the unified work inbox ----
     `Service.emit()` debounces this one, so it arrives when something a person
     is waiting on actually changed. All three keys move together because a
     single fact reaches the operator through all three surfaces: the inbox
     rows, the approval cards the run page still draws, and the badge that
     `/api/state` feeds. */
  inbox: { invalidate: [keys.inbox(), keys.approvals(), keys.notifications()] },

  /* ---- sessions ----
     The list rides on the event, so this is a cache write rather than a
     refetch: a session appearing or ending must reach the dashboard card and
     the nav badges in the same tick, and there is nothing to ask for that the
     payload does not already carry. Invalidation stays as the belt to that
     braces — `/api/terminal` also answers `available` and the flags. */
  // The registry rides the same event: the server appends `foreign` — every
  // hook-reported session with its presence — to each `sessions` emission.
  sessions: {
    invalidate: [keys.terminal(), keys.sessionRegistry()],
    patch: (client, data) => {
      patchSessions(client, data);
      patchPresence(client, data);
    },
  },

  /* ---- autopilot ----
     A run starting, finishing, or having a phase land changes the board too:
     `plans` carries each plan's ready-set, and that is what a finished phase
     moves. */
  'run:run': { invalidate: [keys.runs(), keys.plans(), keys.spend()], slugScoped: 'both' },
  'run:phase': { invalidate: [keys.runs(), keys.spend()], slugScoped: 'both' },
  'run:verify': { slugScoped: 'run' },
  'run:state': { invalidate: [keys.runs(), keys.plans(), keys.spend()], slugScoped: 'both' },
  /* A lane's liveness answer CHANGED — it went silent, started spinning, hit a
     stalemate, or came back. `runner.ts` emits only transitions, so this is
     news by construction and can afford to invalidate: the run payload carries
     `liveness[]`, and the fleet table badges a stalled run without being on
     its page. */
  'run:liveness': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* A ruling landed in the ledger. Both halves move: the plan-wide ledger the
     page reads, and `run.rulings` — the slice the run payload carries. */
  'run:rulings': {
    invalidate: [],
    slugScoped: 'run',
    patch: (client, data) => {
      const slug = typeof data.slug === 'string' ? data.slug : null;
      if (slug) void client.invalidateQueries({ queryKey: keys.rulings(slug) });
    },
  },
  /* Admission moved. `runs` because a phase crossing between queued and
     running is a change to a run; `state` because the header's "2 of 3
     running, 1 queued" is read from `/api/state`. Deliberately NOT
     slug-scoped: a grant released on one plan is precisely what unblocks
     another, and the plan that needs to hear about it is the other one —
     which is also why `['scopes']` is invalidated as a bare prefix rather
     than for the slug the event happens to name. */
  'run:queue': { invalidate: [keys.runs(), keys.state(), keys.queue(), ['scopes']] },
  /* A convergence pass landed: the view rides the event, so this is a cache
     write by slug; `runs` is invalidated too because a relaunch or a heal has
     just changed a run, and `/api/converge` is re-read as the belt to those
     braces (the pending/running lists move independently of any one pass). */
  'run:converge': { invalidate: [keys.converge(), keys.runs()], patch: patchConverge },

  /* ---- accounts ----
     The redacted list rides on the event (see `patchAccounts`), so this is a
     cache write first; the invalidation is the belt to those braces, because
     `/api/accounts` also carries `allowAccounts`. */
  accounts: { invalidate: [keys.accounts()], patch: patchAccounts },

  /* ---- MCP servers ----
     Same shape as accounts, and for the same reason: the redacted list rides on
     the event, and the invalidation is the belt to those braces because
     `/api/mcp` also carries `allowMcp`. A registry change also moves F15, which
     the lint panel reads through the plan — hence `plans` too. */
  mcp: { invalidate: [keys.mcp(), keys.plans()], patch: patchMcp },

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

  if (effect.all) {
    void client.invalidateQueries();
    return;
  }

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
    return () => {
      for (const off of offs) off();
    };
  }, [client]);
}

/* ---------------- the shell's own queries ---------------- */

export function useConsoleState() {
  return useQuery({ queryKey: keys.state(), queryFn: api.state });
}

export function usePlans(enabled = true) {
  return useQuery({ queryKey: keys.plans(), queryFn: api.plans, enabled });
}

/** The instance's Claude accounts with their meters — live via the `accounts` event. */
export function useAccounts(enabled = true) {
  return useQuery({ queryKey: keys.accounts(), queryFn: api.accounts, enabled });
}

/** This instance's MCP servers with their health — live via the `mcp` event. */
export function useMcp(enabled = true) {
  return useQuery({ queryKey: keys.mcp(), queryFn: api.mcp, enabled });
}

/**
 * The catalog for one search string.
 *
 * Its own key per query rather than one cache entry, because the registry half
 * of the answer is a network round trip and re-typing a search you already ran
 * should not repeat it. `staleTime: Infinity` (the app default) is right here:
 * the published catalog does not move while somebody is reading it.
 */
export function useMcpCatalog(query: string, enabled = true) {
  return useQuery({
    queryKey: keys.mcpCatalog(query),
    queryFn: () => api.mcpCatalog(query),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Every Claude session the presence hook reported for this instance — a person's, an agent's, a lane's — with its presence. */
export function useSessionRegistry(enabled = true) {
  return useQuery({ queryKey: keys.sessionRegistry(), queryFn: api.sessionRegistry, enabled });
}

/** The session-presence hook's presence in `~/.claude/settings.json`. */

/** The convergence loop's standing and its last pass per plan (`GET /api/converge`). */
export function useConverge(enabled = true) {
  return useQuery({
    queryKey: keys.converge(),
    queryFn: api.converge,
    enabled,
    staleTime: 15_000,
  });
}
export function useHooksStatus(enabled = true) {
  return useQuery({ queryKey: keys.hooksStatus(), queryFn: api.hooksStatus, enabled });
}

/** Where a one-click desktop launcher would land on the server's platform. */
export function useLauncherPlan(enabled = true) {
  return useQuery({ queryKey: keys.launcher(), queryFn: api.launcherPlan, enabled });
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
 * What boarding would find wrong with this plan's §Verification commands.
 *
 * Under the `['plan', slug]` prefix on purpose, unlike the journal and the
 * rulings: it is a reading OF the plan file and of this machine's PATH, so the
 * one thing that invalidates it — the plan changing on disk — is exactly what
 * that prefix already invalidates.
 *
 * Failure is not an error worth retrying at people: a console whose server
 * predates the endpoint 404s, and the health panel's honest answer to that is
 * to say nothing rather than to claim the plan is clean.
 */
export function useVerifyPreflight(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.verifyPreflight(slug ?? ''),
    queryFn: () => api.verifyPreflight(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
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
 * What holds a scope, and what is waiting behind it.
 *
 * `keepPreviousData` because the answer is a live thing that moves while it is
 * being read: without it the queue card blanks on every admission, which is the
 * exact moment somebody is looking at it.
 */
export function useQueue(enabled = true) {
  return useQuery({
    queryKey: keys.queue(),
    queryFn: api.queue,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * This machine's tailnet, for the Settings card.
 *
 * Polled rather than pushed, and only while the card showing it is mounted: the
 * answer changes when a phone wakes up or someone runs `tailscale serve`,
 * neither of which this server has any way to hear about. The interval is
 * deliberately slower than the server's own 30-second memo, so a Settings tab
 * left open overnight costs about one process spawn a minute — most polls are
 * answered from that memo without touching the CLI at all.
 */
export function useTailscale(enabled = true) {
  return useQuery({
    queryKey: keys.tailscale(),
    queryFn: api.tailscale,
    enabled,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * This plan's phases, their declared scopes, and what each would collide with.
 *
 * Answered from the plan's Repos column plus every live lock across every plan,
 * so it is the one call that can say *why* a phase is not starting. Cheap enough
 * to hold open on the run page; refreshed by `run:queue` for every plan at once.
 */
export function useRunScopes(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.scopes(slug ?? ''),
    queryFn: () => api.runScopes(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
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
 * A run's journal — the audit trail, read once and then appended to live.
 *
 * `keepPreviousData` because the tail is re-read whenever the run id changes
 * and the reader is usually mid-scroll; dropping to a skeleton there loses
 * their place. A run with no journal file yet is not an error worth retrying.
 */
export function useJournal(slug: string | undefined, id?: number, limit = 500, enabled = true) {
  return useQuery({
    queryKey: keys.journal(slug ?? '', id),
    queryFn: () => api.runJournal(slug!, id, limit),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The plan's whole ruling ledger, oldest first.
 *
 * Answers for a plan nobody has ever started a run on, which is every plan
 * somebody is driving by hand — so it is NOT gated on there being a run.
 */
export function useRulings(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.rulings(slug ?? ''),
    queryFn: () => api.runRulings(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * Money: today's settled spend against the day cap, each run against its
 * budget, and the 7-day series.
 *
 * Instance-wide and cheap to invalidate — TanStack only refetches a query
 * something is currently rendering, so the `run:phase` invalidation costs
 * nothing on the pages that do not show it.
 */
export function useSpend(enabled = true) {
  return useQuery({
    queryKey: keys.spend(),
    queryFn: api.spend,
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Everything that needs a person, in one list.
 *
 * `all` includes what has been acknowledged — the drawer's "show everything"
 * view. Acknowledgement is an annotation and never a resolution, so an acked
 * row is still a row; it is only hidden by default.
 *
 * `placeholderData` because the SSE `inbox` event invalidates this whenever
 * anything moves, and a list that blanked to a skeleton every time a run
 * emitted a phase would be unreadable exactly while there is something to
 * read. `retry: false`: a console whose server predates the endpoint answers
 * 404 and will keep answering 404 — the section says so instead of asking
 * again at somebody.
 */
export function useAttentionInbox(all = false, enabled = true) {
  return useQuery({
    queryKey: keys.inbox(all),
    queryFn: () => api.inbox(all),
    enabled,
    placeholderData: keepPreviousData,
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
  /**
   * How many things are waiting on a PERSON — Now's badge, and the only count
   * that wears the accent hue.
   *
   * The unified inbox's length, minus its `fyi` rows: a ruling worth reading
   * and a lock nobody is queued behind are real items and neither is a person
   * being waited on. The name was `needsYou` rather than `approvals` from the
   * first day precisely so widening what it counts did not mean renaming the
   * badge on every surface that reads it — and this is that widening.
   *
   * Falls back to the pending approvals when no inbox is passed (a server too
   * old for `/api/inbox`, or a test that hands neither), which is exactly what
   * this counted before.
   */
  needsYou: number;
  /** Every live session, of either kind — the Sessions destination's badge. */
  sessions: number;
  /** Live claude sessions. */
  agentSessions: number;
  /** Live shells. */
  terminalSessions: number;
  /**
   * Registered MCP servers that need a person: not signed in, not connecting,
   * or advertising different tools than they used to. Not a count of servers —
   * a healthy registry of nine shows nothing at all.
   */
  mcpAttention: number;
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
  // Only what makes a badge light. A disabled server is excluded on purpose:
  // the operator already said no to it, and nagging about a thing they turned
  // off is how a badge becomes something people stop reading.
  mcp?: readonly { enabled: boolean; status: string; toolsChanged?: unknown }[],
  // The unified inbox, when the server has one. `undefined` — an older server,
  // or a still-loading first paint — falls back to the approvals count rather
  // than to zero: a badge that reads 0 while a session is parked on a
  // permission card is worse than one that under-counts.
  inbox?: readonly { severity: string }[],
): ShellCounts {
  const list = plans ?? [];
  const live = (sessions ?? []).filter((session) => !session.exited);
  return {
    // `plans` and `phases` are the CENSUS and count everything, closed included —
    // the same split the server makes, where `totals.phases`/`done`/`percent`
    // still see every plan. Closing a plan quiets it; it does not delete it, and
    // a rail that stopped counting them would disagree with the dashboard's own
    // subtitle. `ready` is the opposite kind of number: it is a call to action
    // with a badge on it, it links straight to the departures board, and it has
    // to say exactly what that board will show.
    plans: list.filter((p) => p.kind === 'plan').length,
    phases: list.reduce((n, p) => n + (p.phases ?? 0), 0),
    ready: list.reduce((n, p) => n + (isClosed(p) ? 0 : (p.ready?.length ?? 0)), 0),
    approvals: (approvals ?? []).filter((a) => a.status === 'pending').length,
    unread,
    needsYou: inbox
      ? inbox.filter((item) => item.severity !== 'fyi').length
      : (approvals ?? []).filter((a) => a.status === 'pending').length,
    sessions: live.length,
    agentSessions: live.filter((session) => session.kind === 'claude').length,
    terminalSessions: live.filter((session) => (session.kind ?? 'shell') === 'shell').length,
    mcpAttention: (mcp ?? []).filter(
      (server) =>
        server.enabled &&
        (server.status === 'needs-auth' || server.status === 'failed' || server.toolsChanged),
    ).length,
  };
}
