/**
 * Hash routing, and the one place a route head becomes a screen.
 *
 * Two rules make this safe to change:
 *
 * 1. **The vocabulary is not ours.** `ROUTE_HEADS` lives in `shared/route-meta.js`
 *    because the *server* builds notification deep links from the same list
 *    (`server/push/catalogue.ts` → `routeFor`). A head renamed here and not there
 *    is a push notification that opens a blank page — which is why the Node test
 *    suite asserts every `routeFor` destination is in that array, and why the
 *    client test below asserts every entry of that array resolves to a component.
 *    Neither test can pass alone if the two drift.
 *
 * 2. **Every view is lazy.** The registry maps to `lazy()` components, so a route
 *    costs its own chunk and nothing else. The plan surface (with `marked` and
 *    the DAG maths) must not be in the bundle a phone downloads to look at the
 *    ready queue.
 */

import { lazy, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import { parseHash, navigate as navigateTo, toHash } from '@shared/routes.js';

export interface Route {
  segments: string[];
  query: Record<string, string>;
  path: string;
}

/** The head an empty hash means. */
export const DEFAULT_HEAD = 'dashboard';

/* ---------------- the registry ---------------- */

export interface ViewProps {
  route: Route;
}

type View = LazyExoticComponent<ComponentType<ViewProps>>;

/**
 * One entry per `ROUTE_HEADS` member — the client test fails if that stops being
 * true in either direction.
 */
export const VIEWS: Record<string, View> = {
  dashboard: lazy(() => import('./views/dashboard')),
  plans: lazy(() => import('./views/plans')),
  plan: lazy(() => import('./views/plan')),
  ready: lazy(() => import('./views/ready')),
  runs: lazy(() => import('./views/runs')),
  stats: lazy(() => import('./views/stats')),
  search: lazy(() => import('./views/search')),
  settings: lazy(() => import('./views/settings')),
  mcp: lazy(() => import('./views/mcp')),
  source: lazy(() => import('./views/source')),
  notifications: lazy(() => import('./views/notifications')),
  guide: lazy(() => import('./views/guide')),
  // xterm and its addons are ~250 KB of JavaScript that only this route needs.
  // Lazy is not an optimisation here — it is why a phone opening the ready
  // queue does not download a terminal emulator.
  terminal: lazy(() => import('./views/terminal')),
  // Same reasoning: the agent page shares the terminal pane (and with it the
  // lazy pane-* chunk xterm lives in — see vite.config.ts globIgnores) and
  // stays off every other route.
  agent: lazy(() => import('./views/agent')),
};

/** `''` and anything unregistered land on the dashboard rather than nowhere. */
export function resolveHead(head: string | undefined): string {
  if (!head) return DEFAULT_HEAD;
  return head in VIEWS ? head : DEFAULT_HEAD;
}

export function resolveView(head: string | undefined): View {
  return VIEWS[resolveHead(head)];
}

/**
 * `source` is the pre-open directory picker: it renders instead of the shell,
 * not inside it, because there is nothing to navigate to until a root is open.
 */
export const CHROMELESS_HEADS = new Set(['source']);

/**
 * Views that own their height: the shell gives them a non-scrolling flex
 * column (banner + view sum to the viewport) instead of the one page
 * scroller. A banner used to push a 100%-tall terminal frame down and put
 * the KeyBar below the fold on every SSE reconnect. Any view rendered under
 * these heads must be flex-aware (`h-full min-h-0`).
 */
export const FULL_HEIGHT_HEADS = new Set(['terminal', 'agent']);

/* ---------------- the hook ---------------- */

function subscribe(notify: () => void): () => void {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

// `useSyncExternalStore` compares snapshots by identity, so parsing on every
// read would loop forever. The parse is memoised on the raw hash string.
let cachedHash: string | null = null;
let cachedRoute: Route = { segments: [], query: {}, path: '' };

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash) as Route;
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, () => cachedRoute);
}

export { navigateTo as navigate, toHash };
export { ROUTE_HEADS };
