/**
 * The route vocabulary, as data — no React, no lazy chunks, no DOM.
 *
 * `router.tsx` owns the *registry* (which head renders which lazily-loaded
 * page) because that half cannot exist without React. Everything a caller
 * needs in order to BUILD a URL or to ask what a URL means lives here, so the
 * shell, the palette, the nav and their tests can import it for a few hundred
 * bytes instead of pulling the whole view graph in behind a `lazy()`.
 *
 * Three ideas hold the 3.0 URL space together:
 *
 * 1. **Six destinations, many heads.** `DESTINATIONS` is what the rail and the
 *    tab bar offer. `ROUTE_HEADS` is every head that still resolves — which is
 *    a much longer list, because a head that ever appeared in a bookmark, a
 *    push payload or a handoff never stops working. `destinationFor()` is the
 *    mapping between them, and it is why `#/plan/x/run` lights up *Plans* and
 *    `#/terminal/abc` lights up *Sessions*.
 *
 * 2. **A redirect is a page whose new home already exists.** `REDIRECTS` holds
 *    only the four that are true today. `#/ready`, `#/pulse` and `#/mcp` are
 *    deliberately NOT here: Now does not absorb the first two until Phase 8 and
 *    Settings does not grow an MCP section until Phase 11, and a redirect onto
 *    a home that has not been built yet is a broken link with extra steps. Each
 *    becomes a redirect in the phase that builds its destination.
 *
 * 3. **The three overlays are query parameters, not routes.** `?k=` (command
 *    palette), `?help=` (help sheet) and `?bell=` (announcements drawer) ride on
 *    top of whatever page you are on, so ⌘K from the Runs page does not throw
 *    the Runs page away. That also makes all three deep-linkable and reloadable
 *    for free, which is what lets `#/search?q=…`, `#/guide/:section` and
 *    `#/notifications` retire into them without losing a single old link.
 */

import { DEFAULT_HEAD, DESTINATIONS, ROUTE_HEADS } from '@shared/route-meta.js';
import { handoffHref, navigate, parseHash, phaseHref, planHref, toHash } from '@shared/routes.js';

/** A parsed hash. The shape every page receives and every helper here reads. */
export interface Route {
  segments: string[];
  query: Record<string, string>;
  path: string;
}

export { DEFAULT_HEAD, DESTINATIONS, ROUTE_HEADS };
/** The pure routing rules, re-exported so a caller needs one import, not two. */
export { handoffHref, navigate, parseHash, phaseHref, planHref, toHash };

/* ---------------- destinations ---------------- */

/**
 * head → the destination that stays lit while you are on it.
 *
 * A nav that goes dark whenever you go deeper reads as though you have left the
 * app, so every head that is not itself a destination names the one it belongs
 * under. Heads absent from this map are their own destination.
 */
const DESTINATION_OF: Record<string, string> = {
  plan: 'plans',
  ready: 'now',
  pulse: 'now',
  notifications: 'now',
  dashboard: 'now',
  search: 'now',
  guide: 'now',
  stats: 'insights',
  mcp: 'settings',
  // The two live session pages. Sessions is where they are REBUILT (Phase 10);
  // until then they are their own pages and this is the only thing that says
  // so — which is also what the router test pins, because the alternative was
  // a terminal deep link lighting up nothing at all.
  terminal: 'sessions',
  agent: 'sessions',
};

/** Which of the six a head belongs to — `undefined` for the chromeless picker. */
export function destinationFor(head: string | undefined): string | undefined {
  if (!head) return DEFAULT_HEAD;
  if (head === 'source') return undefined;
  const mapped = DESTINATION_OF[head] ?? head;
  return (DESTINATIONS as readonly string[]).includes(mapped) ? mapped : DEFAULT_HEAD;
}

/* ---------------- redirects ---------------- */

const enc = encodeURIComponent;

/**
 * head → where it goes instead, given the whole route (the query and the deeper
 * segments are usually the point: a search term, a guide section, a plan).
 *
 * Every one of these is a head whose destination EXISTS today. See the header.
 */
export const REDIRECTS: Record<string, (route: Route) => string> = {
  // Now is the home page; `dashboard` is what it used to be called.
  dashboard: () => 'now',
  // The search page is the palette now. `?q=` was its term; `?k=` is the
  // palette's, and it opens pre-filled with it.
  search: (route) => paletteHref(route.query.q ?? '', 'now'),
  // The guide page is the help sheet. `#/guide/mobile?card=tailscale` keeps
  // both halves of its address.
  guide: (route) => helpHref(route.segments[1], route.query.card, 'now'),
  // Statistics is Insights; `?plan=` is the one parameter it carried.
  stats: (route) => (route.query.plan ? `insights?plan=${enc(route.query.plan)}` : 'insights'),
  // The announcements are the bell drawer. The settings half of the old page is
  // still a page (`#/notifications/settings`), so only the BARE head redirects
  // — `redirectTarget` below is what enforces that.
  notifications: () => bellHref('now'),
};

/**
 * Where this route actually goes, or `null` if it is already there.
 *
 * `notifications` is the one head whose redirect depends on its depth:
 * `#/notifications` is the retired inbox and becomes the drawer, while
 * `#/notifications/settings` is a real page that Phase 11 folds into Settings.
 */
export function redirectTarget(route: Route): string | null {
  const head = route.segments[0];
  if (!head) return null;
  if (head === 'notifications' && route.segments.length > 1) return null;
  const to = REDIRECTS[head];
  return to ? to(route) : null;
}

/* ---------------- how a page is framed ---------------- */

/**
 * `source` is the pre-open directory picker: it renders INSTEAD of the shell,
 * not inside it, because there is nothing to navigate to until a root is open.
 */
export const CHROMELESS_HEADS: ReadonlySet<string> = new Set(['source']);

/**
 * Views that own their height: the shell gives them a non-scrolling flex column
 * (banner + view sum to the viewport) instead of the one page scroller. A
 * banner used to push a 100%-tall terminal frame down and put the key bar below
 * the fold on every SSE reconnect. Any view rendered under these heads must be
 * flex-aware (`h-full min-h-0`).
 */
export const FULL_HEIGHT_HEADS: ReadonlySet<string> = new Set(['terminal', 'agent']);

/* ---------------- href builders ---------------- */

export const nowHref = (): string => '#/now';
export const plansHref = (): string => '#/plans';
export const runsHref = (): string => '#/runs';
export const insightsHref = (plan?: string): string => (plan ? `#/insights?plan=${enc(plan)}` : '#/insights');
export const settingsHref = (section?: string): string =>
  section ? `#/settings/${enc(section)}` : '#/settings';
export const sessionsHref = (id?: string): string => (id ? `#/sessions/${enc(id)}` : '#/sessions');
export const runHref = (slug: string): string => planHref(slug, 'run');

/* ---------------- the three overlays ---------------- */

/**
 * The query keys the shell watches. Exported because "is an overlay open?" is
 * asked in four places and spelling it out four times is how one of them ends
 * up spelling it differently.
 */
export const OVERLAY_KEYS = { palette: 'k', help: 'help', bell: 'bell' } as const;

/**
 * An overlay's address, ON the page you are already on.
 *
 * `base` is only for the redirects, which arrive from a head that has no page
 * of its own to sit on and therefore have to name one.
 */
function overlayHref(
  key: string,
  value: string,
  base: string | Route,
  extra?: Record<string, string | undefined>,
): string {
  const path = typeof base === 'string' ? base.replace(/^#\/?/, '') : base.path;
  const query = typeof base === 'string' ? {} : { ...base.query };
  // Never stack two overlays: opening one closes the others, which is also
  // what pressing its key while another is up should do.
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  query[key] = value;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v == null || v === '') delete query[k];
    else query[k] = v;
  }
  const search = new URLSearchParams(query).toString();
  return `#/${path}${search ? `?${search}` : ''}`;
}

/** `?k=` — the command palette, pre-filled with `term`. */
export const paletteHref = (term = '', base: string | Route = 'now'): string =>
  overlayHref(OVERLAY_KEYS.palette, term, base);

/** `?help=<section>&card=<card>` — the help sheet. */
export const helpHref = (section?: string, card?: string, base: string | Route = 'now'): string =>
  overlayHref(OVERLAY_KEYS.help, section ?? '', base, { card });

/** `?bell=1` — the announcements drawer. */
export const bellHref = (base: string | Route = 'now'): string => overlayHref(OVERLAY_KEYS.bell, '1', base);

/** The same route with every overlay closed — what Escape and a backdrop mean. */
export function closeOverlaysHref(route: Route): string {
  const query = { ...route.query };
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  // `card` is the help sheet's second half and has no meaning without it.
  delete query.card;
  const search = new URLSearchParams(query).toString();
  return `#/${route.path}${search ? `?${search}` : ''}`;
}

/** Which overlay this route asks for, if any. `''` is a value — an open, empty palette. */
export function openOverlay(route: Route): 'palette' | 'help' | 'bell' | null {
  if (route.query[OVERLAY_KEYS.palette] != null) return 'palette';
  if (route.query[OVERLAY_KEYS.help] != null) return 'help';
  if (route.query[OVERLAY_KEYS.bell] != null) return 'bell';
  return null;
}
