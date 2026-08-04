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
// The URL vocabulary itself is FROZEN by the server (`server/push/catalogue.ts`):
// `#/plan/:slug/run`, `#/plan/:slug/phase/:n`, `#/plan/:slug/route`, `#/ready`,
// `#/runs`, `#/plans`, `#/settings`, `#/notifications`, `#/guide`. Renaming a head or
// a tab here means editing that server file too — the test will catch a divergence.

/**
 * Top-level route heads — `route.segments[0]`. The empty hash (`#/`) and any
 * unknown head resolve to `dashboard` (the client registry maps '' → 'dashboard').
 * `source` renders outside the app shell (the pre-open directory picker).
 * `terminal` takes an optional session id (`#/terminal/<id>`) so a shell survives
 * a reload; it is a route whether or not `--allow-terminal` was given, because a
 * route that explains why it is off is better than one that vanishes.
 * `agent` is the same shape for interactive claude sessions (`#/agent/<id>`,
 * gated by `--allow-agent`) — with no id it renders the launcher.
 * NOTE: the route-registry guard asserts every head here resolves to a real
 * component AND that no component exists without a head — adding one means
 * adding both sides.
 * @type {readonly string[]}
 */
export const ROUTE_HEADS = Object.freeze([
  'dashboard',
  'plans',
  'plan',
  'ready',
  'runs',
  'stats',
  'search',
  'settings',
  'source',
  'notifications',
  'guide',
  'terminal',
  'agent',
]);

/**
 * Plan-detail tab ids — the second segment of `#/plan/:slug/:tab`. `run` is
 * load-bearing (the whole autopilot lives there and the server routes every
 * in-flight-run notification to it); a test asserts it stays present. `phase` and
 * `handoff` are detail sub-routes (`#/plan/:slug/phase/:n`), not tabs, so they are
 * not listed here.
 * @type {readonly string[]}
 */
export const PLAN_TABS = Object.freeze([
  'route',
  'phases',
  'run',
  'handoffs',
  'analysis',
  'overview',
  'raw',
]);

/**
 * Guide section ids — the segment of `#/guide/:section`. The guide is rebuilt as
 * deep-linkable tabbed sections (replacing the single long scroll); `mobile` is the
 * dedicated phone-setup section. Deep links to these must survive a reload.
 * @type {readonly string[]}
 */
export const GUIDE_SECTIONS = Object.freeze([
  'concepts',
  'running',
  'autopilot',
  'sessions',
  'notifications',
  'permissions',
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
