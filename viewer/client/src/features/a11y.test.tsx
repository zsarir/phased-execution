/**
 * The accessibility smoke — every destination, and every Settings section.
 *
 * The SHELL's own axe cases live in `app/shell/a11y.test.tsx` (the chrome is on
 * screen everywhere, so a violation there is a violation on every page). This
 * file is the other half: the six pages that render inside it.
 *
 * `test/axe.ts` was built in Phase 2 and **nothing called it for nine phases**.
 * The primitives were checked by hand as they were written and no page was ever
 * run through axe at all, which is how a page ends up with two navigations
 * sharing one accessible name (Settings did, until this file) or a control
 * whose label is really a paragraph.
 *
 * jsdom lays nothing out, so this cannot see contrast (asserted from the
 * stylesheet by `styles/contrast.test.ts`) or anything that needs a viewport.
 * What it CAN see is everything structural: names, roles, labels, ARIA
 * validity, heading and landmark nesting, duplicate ids, form labelling. Those
 * are the failures that make a page unusable with a screen reader, and they are
 * the ones a human reviewer never notices because the page looks right.
 *
 * The fixtures are deliberately POPULATED rather than empty. An empty page
 * renders empty states, and an empty state has no table, no list, no toolbar
 * and no dialog trigger — a smoke that only ever saw those would pass on every
 * page in the app while proving nothing about any of them.
 */

import { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';

/* ------------------------------------------------------------------ *
 * One fetch stub for the whole app.
 *
 * Every fetcher in `lib/api/*` funnels through `client.ts` `request()`, which
 * funnels through `fetch`. Stubbing there rather than mocking `api` is what
 * lets six destinations share one harness — and it exercises the real
 * fetchers, so a page that asks for something nobody has fixtured fails here
 * rather than silently rendering a skeleton forever.
 * ------------------------------------------------------------------ */

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowMcp: false,
  staticRoot: 'dist',
  distRev: 'abc123def456',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd', supervised: true },
  repo: { available: true, branch: 'main', dirty: ['docs/plans/demo.md'] },
  recentRoots: [],
  models: ['claude-opus-5', 'claude-fable-5'],
  port: 4123,
  unread: 2,
  prefs: {},
};

const PLANS = [
  {
    slug: 'demo',
    kind: 'plan',
    title: 'A demo plan',
    phases: 8,
    ready: [2],
    status: 'active',
    closed: false,
  },
  { slug: 'other', kind: 'plan', title: 'Another', phases: 6, ready: [], status: 'complete', closed: true },
];

const PORTFOLIO = {
  generatedAt: Date.parse('2026-08-22T12:00:00Z'),
  totals: {
    plans: 2,
    documents: 1,
    orphans: 1,
    closed: 1,
    phases: 14,
    done: 9,
    ready: 2,
    waiting: 2,
    inProgress: 1,
    stuck: 0,
    percent: 64,
    remainingWeight: 310_000,
    remainingSessions: 2,
  },
  byStatus: [
    { status: 'active', count: 1, closed: false },
    { status: 'complete', count: 1, closed: true },
  ],
  activeLocks: [{ slug: 'demo', phase: 2, owner: 'someone@host', expired: true, leaseUntil: 0 }],
  issues: [
    { slug: 'demo', kind: 'index-drift', severity: 'warning', message: 'INDEX.md disagrees', phase: 2 },
    { slug: 'other', kind: 'orphan', severity: 'info', message: 'a handoff folder with no plan' },
  ],
  velocity: [
    { week: '2026-W30', count: 2 },
    { week: '2026-W31', count: 5 },
  ],
  calendar: [{ date: '2026-08-21', count: 3 }],
  medianCycleDays: 1,
  sizeMix: [
    { size: 'S', count: 3 },
    { size: 'M', count: 8 },
  ],
  repos: [{ repo: 'phased-execution', count: 11 }],
  skills: [{ skill: 'phased-execution', count: 4 }],
  models: [{ model: 'claude-fable-5', count: 11 }],
  stalled: [{ slug: 'demo', days: 12, ready: [2, 3] }],
  busiest: [{ slug: 'demo', completions: 9 }],
  rate: { ratePerWeight: 60, basis: 'plan', samples: 5, spread: 0.4 },
};

const SPEND = {
  today: { settledUsd: 12.5, ladderUsd: 3.25, capUsd: 600 },
  runs: [{ runId: 'r1', slug: 'demo', spentUsd: 12.5, budgetUsd: 40 }],
  series: [
    { day: '2026-08-21', settledUsd: 8, ladderUsd: 1 },
    { day: '2026-08-22', settledUsd: 12.5, ladderUsd: 3.25 },
  ],
};

const INBOX = [
  {
    id: 'demo#2#gate',
    kind: 'gate',
    severity: 'needs-you',
    title: 'Phase 2 is behind a human gate',
    detail: 'Approve it on the plan page.',
    slug: 'demo',
    phase: 2,
    at: Date.parse('2026-08-22T11:00:00Z'),
    actions: [],
  },
];

/** path → body. A miss is an explicit 404, never an accidental empty object. */
const ROUTES: [RegExp, unknown][] = [
  [/^\/api\/state/, STATE],
  [/^\/api\/plans\/[^/]+\/verify-preflight/, { warnings: [] }],
  [/^\/api\/plans\/[^/]+/, null],
  [/^\/api\/plans/, PLANS],
  [/^\/api\/stats/, PORTFOLIO],
  [/^\/api\/spend/, SPEND],
  [/^\/api\/inbox/, INBOX],
  [/^\/api\/approvals/, []],
  [/^\/api\/runs\/scopes/, { scopes: [] }],
  [/^\/api\/runs/, []],
  [/^\/api\/queue/, { max: 3, live: 0, queued: 0, throttledUntil: null, grants: [], entries: [] }],
  [/^\/api\/sessions/, { sessions: [], max: 8 }],
  [/^\/api\/terminal/, { sessions: [], max: 8 }],
  [/^\/api\/mcp\/catalog/, { entries: [] }],
  [/^\/api\/mcp/, { servers: [], allowMcp: false }],
  [/^\/api\/policy/, { profiles: [], allow: [], deny: [], ask: [] }],
  [/^\/api\/accounts/, { accounts: [], active: null }],
  [/^\/api\/push/, { publicKey: 'k', devices: [], categories: [] }],
  [
    /^\/api\/notifications/,
    {
      items: [],
      total: 0,
      unread: 0,
      more: false,
      categories: [],
      devices: 0,
      outOfBand: { configured: false },
    },
  ],
  [/^\/api\/tailscale/, { available: false }],
  [/^\/api\/hook/, { installed: false }],
  [/^\/api\/skills/, { skills: [] }],
  [/^\/api\/auth/, { loggedIn: true, checkedAt: '2026-08-22T00:00:00Z' }],
  [/^\/api\/search/, { query: '', total: 0, groups: [] }],
];

function body(path: string): unknown | undefined {
  for (const [pattern, value] of ROUTES) if (pattern.test(path)) return value;
  return undefined;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(
        typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url,
      );
      const value = body(path);
      if (value === undefined) {
        return new Response('not fixtured', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * The destinations
 * ------------------------------------------------------------------ */

/** Every destination, the route it renders at, and a string proving it painted. */
const DESTINATIONS: { id: string; route: string[]; query?: Record<string, string>; settled: RegExp }[] = [
  { id: 'now', route: ['now'], settled: /needs you|running now|next up|nothing/i },
  { id: 'plans', route: ['plans'], settled: /demo/i },
  { id: 'runs', route: ['runs'], settled: /run|nothing/i },
  { id: 'sessions', route: ['sessions'], settled: /session|nothing|new/i },
  { id: 'insights', route: ['insights'], settled: /how long is left/i },
  { id: 'settings', route: ['settings'], settled: /general/i },
];

/**
 * Settings is eight sections and each is its own screen — smoke them all, from
 * the same vocabulary the nav renders, so a ninth section cannot be added
 * without a smoke arriving with it.
 */
const { SETTINGS_SECTIONS } = await import('@/features/settings/nav');

async function mountAt(segments: string[], query: Record<string, string> = {}) {
  const head = segments[0];
  const { ROUTE_TABLE } = await import('@/app/router');
  const entry = ROUTE_TABLE[head];
  if (!entry || entry.kind !== 'page') throw new Error(`${head} is not a page`);
  const View = entry.lazy;
  const route = { segments, query, path: segments.join('/') };
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div>loading</div>}>
        <View route={route} />
      </Suspense>
    </QueryClientProvider>,
  );
}

/*
 * Two generous clocks, for two different reasons.
 *
 * `TIMEOUT` — axe over a whole page takes seconds in jsdom and this file runs
 * it fourteen times; the default 5 s turns a slow assertion into a timeout
 * that reads like a page that never painted.
 *
 * `WAIT` — every destination is behind a `lazy()`, and this file is the only
 * one that resolves six of those chunks. Under the full 95-file suite the
 * workers contend and the first import has been seen to take past 10 s, which
 * surfaced as `now` failing with the Suspense fallback still on screen while
 * the same test passed in isolation and alongside its neighbours. The ceiling
 * is deliberately far above the observed worst case rather than retried: a
 * chunk that genuinely never resolves must still fail, and a retry would hide
 * exactly that.
 */
const TIMEOUT = 40_000;
const WAIT = 30_000;

describe('axe — every destination', () => {
  for (const destination of DESTINATIONS) {
    it(
      `${destination.id} has no accessibility violations`,
      async () => {
        const { container } = await mountAt(destination.route, destination.query);
        // Wait for the real content, not the skeleton: a skeleton is a div, and a
        // page of divs passes every rule there is.
        await screen.findAllByText(destination.settled);
        await expectNoAxeViolations(container);
      },
      TIMEOUT,
    );
  }
});

describe('axe — every settings section', () => {
  for (const section of SETTINGS_SECTIONS) {
    it(
      `settings/${section.id} has no accessibility violations`,
      async () => {
        const { container } = await mountAt(['settings', section.id]);
        // BY NAME. A bare `{ level: 2 }` matches the section heading AND every
        // CardTitle, and `findBy*` retries on "found multiple" exactly as it
        // retries on "found none" — so an ambiguous query does not fail, it
        // times out, which reads as a page that never rendered.
        await screen.findByRole('heading', { name: section.title, level: 2 }, { timeout: WAIT });
        await expectNoAxeViolations(container);
      },
      TIMEOUT,
    );
  }
});
