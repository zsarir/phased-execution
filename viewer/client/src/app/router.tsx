/**
 * The route registry: the one place a route head becomes a screen.
 *
 * Restructured for 3.0 from a flat `head → lazy(view)` object into a
 * declarative **`ROUTE_TABLE`**, because a head is no longer always a page. It
 * is either:
 *
 *   `{ kind: 'page',     lazy }`  — a chunk to render, or
 *   `{ kind: 'redirect', to   }`  — a URL to send you to instead.
 *
 * Making that a *value* rather than a branch inside the render is what lets one
 * test walk `ROUTE_HEADS` and assert every member of the shared vocabulary
 * resolves — pages and aliases alike — which is the guarantee the old registry
 * could only give for pages.
 *
 * Two rules survive from 2.x and still hold:
 *
 * 1. **The vocabulary is not ours.** `ROUTE_HEADS` lives in
 *    `shared/route-meta.js` because the *server* builds notification deep links
 *    from the same list (`server/push/catalogue.ts` → `routeFor`). A head
 *    renamed here and not there is a push notification that opens a blank page,
 *    which is why the Node suite asserts every `routeFor` destination is in that
 *    array and the client test below asserts every entry of that array resolves.
 *    Neither test can pass alone if the two drift.
 *
 * 2. **Every page is lazy.** A route costs its own chunk and nothing else. The
 *    plan surface (with `marked` and the DAG maths) must not be in the bundle a
 *    phone downloads to look at what needs it, and xterm — ~250 KB — must not be
 *    anywhere except the two heads that actually open a pty.
 *
 * The 3.0 shape (`app/routes.ts` holds the reasoning): six destinations, every
 * older head still resolving, and three overlays that ride the query string
 * rather than taking a head of their own.
 */

import {
  createContext,
  lazy,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import {
  CHROMELESS_HEADS,
  DEFAULT_HEAD,
  DESTINATIONS,
  FULL_HEIGHT_HEADS,
  REDIRECTS,
  destinationFor,
  navigate as navigateTo,
  parseHash,
  redirectTarget,
  toHash,
  type Route,
} from './routes';

export type { Route };
export { CHROMELESS_HEADS, DEFAULT_HEAD, DESTINATIONS, FULL_HEIGHT_HEADS, destinationFor, redirectTarget };

/* ---------------- the table ---------------- */

export interface ViewProps {
  route: Route;
}

type View = LazyExoticComponent<ComponentType<ViewProps>>;

export interface PageRoute {
  kind: 'page';
  lazy: View;
}

export interface RedirectRoute {
  kind: 'redirect';
  /** Given the whole route, because the query and the deeper segments carry meaning. */
  to: (route: Route) => string;
}

export type RouteEntry = PageRoute | RedirectRoute;

const page = (lazyView: View): PageRoute => ({ kind: 'page', lazy: lazyView });
const redirect = (to: (route: Route) => string): RedirectRoute => ({ kind: 'redirect', to });

/**
 * One entry per `ROUTE_HEADS` member — the client test fails if that stops
 * being true in either direction.
 *
 * The order mirrors `ROUTE_HEADS`: the six destinations, then the pages a
 * destination has not absorbed yet, then the aliases.
 */
export const ROUTE_TABLE: Record<string, RouteEntry> = {
  /* ---- the six destinations ---- */
  // The needs-you inbox, the live lanes, next up and the plans in flight —
  // the four pages this one absorbed, on the route that was always its home.
  now: page(lazy(() => import('@/features/now'))),
  plans: page(lazy(() => import('@/features/plans'))),
  runs: page(lazy(() => import('@/features/runs'))),
  // A placeholder until Phase 10 rebuilds the terminal into it — it links to
  // the two pages that do the work today rather than pretending to be them.
  sessions: page(lazy(() => import('@/features/sessions'))),
  insights: page(lazy(() => import('@/views/stats'))),
  settings: page(lazy(() => import('@/views/settings'))),

  /* ---- pages a destination has not absorbed yet ---- */
  plan: page(lazy(() => import('@/features/plans/detail'))),
  // Only `#/notifications/settings` reaches this now; the bare head is a
  // redirect into the drawer (see `redirectTarget`).
  notifications: page(lazy(() => import('@/views/notifications'))),
  mcp: page(lazy(() => import('@/views/mcp'))),
  source: page(lazy(() => import('@/views/source'))),
  // xterm and its addons are ~250 KB of JavaScript that only these two heads
  // need. Lazy is not an optimisation here — it is why a phone opening Now does
  // not download a terminal emulator. `check-dist.mjs` pins the chunk names.
  terminal: page(lazy(() => import('@/views/terminal'))),
  agent: page(lazy(() => import('@/views/agent'))),

  /* ---- aliases: a head whose new home already exists ---- */
  dashboard: redirect(REDIRECTS.dashboard),
  stats: redirect(REDIRECTS.stats),
  search: redirect(REDIRECTS.search),
  guide: redirect(REDIRECTS.guide),
  // Phase 8: Now grew the two sections these pages were, so both retire into
  // it with the `?focus=` that keeps what each address MEANT.
  ready: redirect(REDIRECTS.ready),
  pulse: redirect(REDIRECTS.pulse),
};

/** `''` and anything unregistered land on Now rather than nowhere. */
export function resolveHead(head: string | undefined): string {
  if (!head) return DEFAULT_HEAD;
  return head in ROUTE_TABLE ? head : DEFAULT_HEAD;
}

export function resolveEntry(head: string | undefined): RouteEntry {
  return ROUTE_TABLE[resolveHead(head)];
}

/**
 * The component for a head, or `null` when the head is an alias.
 *
 * A caller that gets `null` should have followed `redirectTarget` first; the
 * shell does, and this returns `null` rather than guessing so that a missed
 * redirect is a blank frame with a stack trace instead of a silently wrong page.
 */
export function resolveView(head: string | undefined): View | null {
  const entry = resolveEntry(head);
  return entry.kind === 'page' ? entry.lazy : null;
}

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

/**
 * The test harness's route, when one is mounted.
 *
 * `null` — the default — means "read the address bar", which is what the app
 * itself always does. A provider is the only way a test can render a page at a
 * route without mutating `window.location` and leaking it into the next test.
 */
interface MemoryRouter {
  route: Route;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}

const MemoryRouterContext = createContext<MemoryRouter | null>(null);

export function useRoute(): Route {
  const memory = useContext(MemoryRouterContext);
  const live = useSyncExternalStore(subscribe, snapshot, () => cachedRoute);
  return memory ? memory.route : live;
}

/**
 * `navigate`, aware of a memory router.
 *
 * The bare `navigate` export below still writes to `location.hash` and is what
 * nearly every caller wants. This hook is for the ones rendered inside the test
 * harness, and for the shell itself — which must not push the app out of a
 * `MemoryRouterProvider` the moment someone taps a nav item in a test.
 */
export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  const memory = useContext(MemoryRouterContext);
  return memory ? memory.navigate : navigateTo;
}

/**
 * A router in memory, for tests.
 *
 * Renders its children against `initial` and moves when something navigates,
 * with no `window.location` involved at all — so a suite can mount the shell at
 * `#/plan/x/run?bell=1`, assert, and leave the address bar exactly as it found
 * it. `onNavigate` is there for the tests whose whole subject is "did this link
 * go to the right place".
 */
export function MemoryRouterProvider({
  initial = '#/now',
  onNavigate,
  children,
}: {
  initial?: string;
  onNavigate?: (path: string) => void;
  children: ReactNode;
}) {
  const [hash, setHash] = useState(() => toHash(initial));
  const go = useCallback(
    (path: string) => {
      const next = toHash(path);
      onNavigate?.(next);
      setHash(next);
    },
    [onNavigate],
  );
  const value = useMemo<MemoryRouter>(() => ({ route: parseHash(hash) as Route, navigate: go }), [hash, go]);
  return <MemoryRouterContext.Provider value={value}>{children}</MemoryRouterContext.Provider>;
}

export { navigateTo as navigate, toHash };
export { ROUTE_HEADS };
