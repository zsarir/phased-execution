// Route metadata — the single source of truth for the client's route vocabulary.
//
// This module is deliberately plain, dependency-free ESM (+ JSDoc). It is imported
// two ways with NO build step:
//   • by the Vite/React client, to build the route→view registry and the plan tabs;
//   • by the Node test suite (`node --test`), which asserts that every notification
//     deep-link the server can emit (`server/push/catalogue.ts` routeFor) lands on a
//     head this client actually registers, and that a plan's `run` tab still exists.
//
// Before this file, the tests scraped `web/app.js` for `head === '…'` and
// `web/views/plan.js` for `const TABS = […]`. That coupled the tests to a specific
// hand-written dispatch shape. The rewrite replaces both scrapes with imports of the
// two arrays below, so the contract is asserted against data, not source text.
//
// The URL vocabulary the SERVER emits is frozen by `server/push/catalogue.ts`
// (`routeFor`, the only emitter): `#/plan/:slug/run`, `#/plan/:slug/phase/:n`,
// `#/plan/:slug/route`, `#/ready`, `#/runs`, `#/plans`, `#/agent[/:id]`,
// `#/terminal[/:id]`, `#/settings`. Renaming one of those heads means editing that
// server file too — the test will catch a divergence.
//
// (`#/notifications` and `#/guide` were listed here as server-emitted until 3.0 and
// never were: no `routeFor` branch has ever produced either. They are client-only
// heads, which is what let 3.0 turn both into overlays without touching the server.)
//
// 3.0 added `now`, `sessions` and `insights` and kept EVERY older head. Some of the
// old ones are now redirects rather than pages (`app/routes.ts` `REDIRECTS`), but a
// head that ever appeared in a bookmark, a push payload or a handoff stays in this
// list and stays resolvable — which is the whole contract this array exists for.

/**
 * Top-level route heads — `route.segments[0]`. The empty hash (`#/`) and any
 * unknown head resolve to `DEFAULT_HEAD` below.
 *
 * The first six are the 3.0 DESTINATIONS — what the rail and the phone tab bar
 * offer. Everything after them is a head that still resolves (a page a later
 * phase has not rebuilt yet, or a redirect onto its new home) but is not a place
 * the navigation sends you.
 *
 * `source` renders outside the app shell (the pre-open directory picker).
 * `terminal` takes an optional session id (`#/terminal/<id>`) so a shell survives
 * a reload; it is a route whether or not `--allow-terminal` was given, because a
 * route that explains why it is off is better than one that vanishes.
 * `agent` is the same shape for interactive claude sessions (`#/agent/<id>`,
 * gated by `--allow-agent`) — with no id it renders the launcher. Both are
 * DESTINED for `sessions`, which is the nav entry that lights up on them.
 *
 * NOTE: the route-registry guard asserts every head here has a `ROUTE_TABLE`
 * entry AND that no entry exists without a head — adding one means adding both
 * sides.
 * @type {readonly string[]}
 */
export const ROUTE_HEADS = Object.freeze([
  // the six destinations
  'now',
  'plans',
  'runs',
  'sessions',
  'insights',
  'settings',
  // pages a destination has not absorbed yet, plus the deep-link heads
  'plan',
  'ready',
  'pulse',
  'notifications',
  'mcp',
  'source',
  'terminal',
  'agent',
  // redirects onto the above
  'dashboard',
  'stats',
  'search',
  'guide',
]);

/**
 * The head an empty or unknown hash means.
 *
 * Shared rather than client-local because it is the answer to "where does a
 * notification whose deep link no longer resolves land?", and that question has
 * to have the same answer on both sides of the wire.
 * @type {string}
 */
export const DEFAULT_HEAD = 'now';

/**
 * The six destinations, in nav order — the rail, the phone tab bar and the
 * palette's navigation group all read this.
 * @type {readonly string[]}
 */
export const DESTINATIONS = Object.freeze(['now', 'plans', 'runs', 'sessions', 'insights', 'settings']);

/**
 * Plan-detail tab ids — the second segment of `#/plan/:slug/:tab`. `run` is
 * load-bearing (the whole autopilot lives there and the server routes every
 * in-flight-run notification to it); a test asserts it stays present. `phase` and
 * `handoff` are detail sub-routes (`#/plan/:slug/phase/:n`), not tabs, so they are
 * not listed here.
 *
 * Five in 3.0, down from seven. `analysis`, `overview` and `raw` were three
 * readings of the same file that a person had to try in turn: the numbers, the
 * prose, the bytes. The numbers are Insights' subject and the other two are one
 * tab with a switch — see `LEGACY_PLAN_TABS`.
 * @type {readonly string[]}
 */
export const PLAN_TABS = Object.freeze(['route', 'phases', 'run', 'handoffs', 'source']);

/**
 * A retired tab id -> where its address goes now.
 *
 * Shared rather than client-local for the same reason `PLAN_TABS` is: these ids
 * are in bookmarks, in handoff prose, and in push payloads minted by servers
 * older than this build. `insights` is a HEAD, not a tab — the analysis numbers
 * became the Insights destination, so that redirect leaves the plan page
 * entirely and carries `?plan=` to keep which plan it was about. The other two
 * are tabs of this page.
 *
 * A value naming a head is spelled with no leading `#/`; the caller builds the
 * URL (`app/routes.ts` `planTabRedirect`), because only it knows the slug and
 * how to encode it. `view` is the half of a tab an address meant — the same
 * device `?focus=` uses for Now's bands, and the reason `#/plan/x/raw` does not
 * quietly become "the prose reading of x".
 * @type {Readonly<Record<string, {tab?: string, head?: string, view?: string}>>}
 */
export const LEGACY_PLAN_TABS = Object.freeze({
  // The prose reading and the byte reading of one file: one tab, one switch.
  overview: Object.freeze({ tab: 'source' }),
  raw: Object.freeze({ tab: 'source', view: 'raw' }),
  // Velocity, completions, spend, ETA — the estate-wide questions, which is
  // where they answer better than on one plan.
  analysis: Object.freeze({ head: 'insights' }),
});

/**
 * Guide section ids — the segment of `#/guide/:section`. The guide is rebuilt as
 * deep-linkable tabbed sections (replacing the single long scroll); `mobile` is the
 * dedicated phone-setup section. Deep links to these must survive a reload.
 *
 * `running` is how you START the console; `run` is what a run then DOES. They
 * were one 183-line section until the split, and the id stayed with the install
 * half because that is where the launcher prompt lives. `concepts` must remain
 * first — it is the section an unknown id falls back to.
 * @type {readonly string[]}
 */
export const GUIDE_SECTIONS = Object.freeze([
  'concepts',
  'running',
  'run',
  'autopilot',
  'sessions',
  'notifications',
  'permissions',
  'mcp',
  'mobile',
  'troubleshooting',
  'reference',
]);

/**
 * True when `head` is a registered top-level route head.
 * @param {string} head
 * @returns {boolean}
 */
export function isRouteHead(head) {
  return ROUTE_HEADS.includes(head);
}
