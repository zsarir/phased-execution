/**
 * The route contract, asserted against data.
 *
 * `web-imports.test.ts` policed the legacy client's module graph and retired
 * with it. What still needs holding is the contract between the server and the
 * built client: every URL the server can emit must land on a head the client
 * registers, the `run` tab that every in-flight-run notification routes to must
 * keep existing, and the routing rules in `shared/routes.js` must round-trip
 * every form this system produces.
 *
 * `test/notifications.test.ts` already walks the catalogue with a full payload
 * and asserts the exact URLs. This file pins the other side: payloads that
 * arrive with no slug or no phase (routeFor must degrade upwards, never emit
 * `#/plan/undefined`), slugs that need encoding, and the parse/build functions
 * themselves — which nothing else exercises directly, although a service worker
 * navigation, the client router and every href builder all stand on them.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, routeFor } from '../server/push/catalogue.ts';
import type { RouteContext } from '../server/push/catalogue.ts';
import { ROUTE_HEADS, PLAN_TABS, LEGACY_PLAN_TABS, isRouteHead } from '../shared/route-meta.js';
import { parseHash, toHash, planHref, phaseHref, handoffHref } from '../shared/routes.js';

/** Full, partial, empty and hostile — the payload states a real push can be in. */
const CONTEXTS: RouteContext[] = [
  { slug: 'demo', phase: 4 },
  { slug: 'demo' },
  { slug: 'demo', phase: null },
  {},
  { slug: 'a plan/with?odd chars', phase: 9 },
];

test('every URL the server can emit lands on a registered head, whatever the payload knows', () => {
  for (const category of CATEGORIES) {
    for (const context of CONTEXTS) {
      const url = routeFor(category.id, context);
      const head = parseHash(toHash(url)).segments[0];
      assert.ok(
        isRouteHead(head),
        `routeFor('${category.id}', ${JSON.stringify(context)}) → ${url} — '${head}' is not in ROUTE_HEADS`,
      );
      assert.ok(!url.includes('undefined'), `routeFor('${category.id}') leaked an undefined into ${url}`);
    }
  }
});

test('a server-emitted plan URL names a tab the plan view actually registers', () => {
  for (const category of CATEGORIES) {
    for (const context of CONTEXTS) {
      const { segments } = parseHash(toHash(routeFor(category.id, context)));
      if (segments[0] !== 'plan') continue;
      const tail = segments[2];
      assert.ok(
        PLAN_TABS.includes(tail) || tail === 'phase' || tail === 'handoff',
        `routeFor('${category.id}') targets plan tab '${tail}', which the plan view does not register`,
      );
    }
  }
});

test('the run tab the server routes every in-flight notification to still exists', () => {
  // Renaming or dropping `run` in route-meta without editing `catalogue.ts`
  // would send approval pushes to the router's silent fallback — the exact bug
  // routeFor was written to end.
  assert.ok(PLAN_TABS.includes('run'), `'run' must stay in PLAN_TABS: ${PLAN_TABS.join(', ')}`);
});

test('toHash accepts every form this system produces for the same route', () => {
  // `plans` from code, `/plans` typed by hand, `#/plans` from the router, and
  // the `/#/plans` a server-built notification URL carries (it must be a URL
  // path, because a service worker resolves it against the origin).
  for (const form of ['plans', '/plans', '#/plans', '/#/plans']) {
    assert.equal(toHash(form), '#/plans', `toHash('${form}')`);
  }
});

test('the href builders round-trip a slug that needs encoding, and a phase number', () => {
  const slug = 'p8 demo/tricky?plan';

  assert.deepEqual(parseHash(planHref(slug, 'source')).segments, ['plan', slug, 'source']);
  assert.deepEqual(parseHash(phaseHref(slug, 8)).segments, ['plan', slug, 'phase', '8']);
  assert.deepEqual(parseHash(handoffHref(slug, 7)).segments, ['plan', slug, 'handoff', '7']);

  // The default tab is part of the contract: `planHref(slug)` is what most of
  // the client links, and it must land on a registered tab.
  const bare = parseHash(planHref(slug)).segments;
  assert.equal(bare[0], 'plan');
  assert.ok(PLAN_TABS.includes(bare[2]), `planHref's default tab '${bare[2]}' is not in PLAN_TABS`);
});

test('every retired plan tab still names somewhere real', () => {
  // These ids are in bookmarks, in handoff prose, and in push payloads minted
  // by servers older than this build. `app/routes.ts` `planTabRedirect` builds
  // the URL; this asserts the VOCABULARY it reads is not self-contradictory —
  // a `tab` that is not a tab, or an id that is both retired and live, is a
  // redirect into nothing.
  for (const [id, to] of Object.entries(LEGACY_PLAN_TABS as Record<string, { tab?: string; head?: string }>)) {
    assert.ok(!PLAN_TABS.includes(id), `'${id}' is both a live tab and a retired one`);
    assert.ok(to.tab || to.head, `retired tab '${id}' names no destination`);
    if (to.tab) assert.ok(PLAN_TABS.includes(to.tab), `'${id}' → '${to.tab}', which is not a tab`);
    if (to.head) assert.ok(isRouteHead(to.head), `'${id}' → head '${to.head}', which is not a route head`);
  }
});

test('a query survives the parse', () => {
  const route = parseHash('#/search?q=a+b%26c');
  assert.deepEqual(route.segments, ['search']);
  assert.equal(route.query.q, 'a b&c');
});
