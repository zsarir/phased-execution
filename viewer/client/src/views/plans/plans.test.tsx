/**
 * The plan list.
 *
 * The properties worth pinning are the ones that are invisible until they are
 * wrong:
 *
 * - **Documents are not plans.** This source holds sixty-five plans and fifteen
 *   documents, and the old view mixed them in one scroll. `showDocuments` has
 *   been in `prefs` since the first phase and was read by nothing.
 * - **A filter says what it hid.** A silently shortened list is
 *   indistinguishable from missing data.
 * - **A title is markdown on disk.** `**Alpha**` sorted under `*` and rendered
 *   with its asterisks until every view started going through `plainText`; this
 *   one was the last that did not.
 * - **The orders differ.** Five sorts producing the same first row are one sort
 *   with five labels.
 * - **A ready chip links to the phase.** The old rows linked everything to the
 *   plan, which is the same defect the ready board had.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { PlanSummaryFull, RunState } from '@/lib/api';
import {
  CLOSED_ONLY, NO_FILTERS, OPEN_ONLY, applyFilters, concerns, groupRows, hiddenBreakdown,
  matches, repoOptions, rowTotals, sortRows, statusOptions, toRows,
} from './model';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull => ({
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  status: 'active',
  activity: Date.UTC(2026, 7, 3),
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 2,
  inProgress: [],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [], mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
  ...over,
});

const run = (over: Partial<RunState> = {}): RunState => ({
  id: 'r1',
  slug: 'alpha',
  status: 'running',
  activePhase: 2,
  updatedAt: '2026-08-03T01:00:00Z',
  createdAt: '2026-08-03T00:00:00Z',
  phases: {},
  ...over,
} as unknown as RunState);

const NOW = Date.UTC(2026, 7, 3, 12);

/* ------------------------------------------------------------------ *
 * Building a row
 * ------------------------------------------------------------------ */

describe('building a row', () => {
  it('reads ready as phase numbers, not objects', () => {
    // Same wire shape that made the old ready board unusable: `[2]` is a list
    // of numbers, and a row built from it must still know it is phase 2.
    const [row] = toRows([plan({ ready: [2, 3] })], [], NOW);
    expect(row.readyPhases).toEqual([2, 3]);
  });

  it('strips the markdown out of a title', () => {
    const [row] = toRows([plan({ title: '**Alpha** plan `v2`' })], [], NOW);
    expect(row.title).toBe('Alpha plan v2');
  });

  it('falls back to the slug rather than rendering an empty title', () => {
    const [row] = toRows([plan({ title: '' })], [], NOW);
    expect(row.title).toBe('alpha');
  });

  it('joins only the newest run of a plan', () => {
    const [row] = toRows([plan()], [
      run({ id: 'new', status: 'running' }),
      run({ id: 'old', status: 'finished' }),
    ], NOW);
    expect(row.run?.id).toBe('new');
    expect(row.run?.outcome).toBe('live');
  });

  it('counts an unreadable plan as an error even when the issue list is empty', () => {
    // A plan the engine could not parse reports zero ready and zero remaining —
    // numbers that read as "finished" and mean "unknown".
    const [row] = toRows([plan({ engineError: 'phase table did not parse' })], [], NOW);
    expect(row.errors).toBe(1);
    expect(row.firstIssue).toBe('phase table did not parse');
  });

  it('treats a fully done plan as complete even when the front matter did not say so', () => {
    const [row] = toRows([plan({ status: 'active', phases: 4, done: 4 })], [], NOW);
    expect(row.isComplete).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Concerns
 * ------------------------------------------------------------------ */

describe('what is wrong with a plan', () => {
  it('says nothing about a healthy plan', () => {
    const [row] = toRows([plan()], [], NOW);
    expect(concerns(row)).toEqual([]);
  });

  it('puts an error above a halted run above a stuck phase', () => {
    const [row] = toRows([plan({
      issueCounts: { error: 1, warning: 0, info: 0 },
      issues: [{ slug: 'alpha', severity: 'error', kind: 'engine', message: 'boom' }],
      stuck: [3],
    })], [run({ status: 'halted' })], NOW);
    expect(concerns(row).map((c) => c.key)).toEqual(['error', 'halted', 'stuck']);
    expect(concerns(row)[0].text).toBe('boom');
  });

  it('does not call a plan neglected when it has nothing anyone could start', () => {
    // Idle only counts against a plan that *could* be moving. Waiting on a
    // dependency is not the same as being ignored, and conflating them buries
    // the plans somebody genuinely stopped working on.
    const stale = Date.UTC(2026, 6, 1);
    const [waiting] = toRows([plan({ activity: stale, ready: [] })], [], NOW);
    const [rotting] = toRows([plan({ activity: stale, ready: [2] })], [], NOW);
    expect(concerns(waiting)).toEqual([]);
    expect(concerns(rotting).map((c) => c.key)).toEqual(['idle']);
  });

  // The client must not re-derive from `stuck`, `qaFailures` and `locks` the
  // warnings the SERVER deliberately silenced. Those three fields stay
  // populated on a closed plan on purpose — the plan's own board must still say
  // what never got done — so this is the gate that stops them coming back as
  // chips, band rows and an `attention` sort key.
  it('drops every progress concern on a closed plan', () => {
    const stale = Date.UTC(2026, 6, 1);
    const fixture = {
      activity: stale,
      ready: [2],
      stuck: [3],
      qaFailures: [1],
      locks: [{ phase: 4, owner: 'someone', expired: true }],
    };
    const [open] = toRows([plan(fixture)], [run({ status: 'halted' })], NOW);
    expect(concerns(open).map((c) => c.key)).toEqual(['halted', 'stuck', 'qa', 'lock', 'idle']);

    const [closed] = toRows([plan({ ...fixture, status: 'abandoned' })], [run({ status: 'halted' })], NOW);
    expect(concerns(closed)).toEqual([]);
  });

  // Demoted, not deleted — the server keeps a closed plan's structural issues
  // and marks them `info`. A plan nobody can parse must never become invisible;
  // it just stops outranking a live plan's real error.
  it('keeps a closed plan’s structural error, demoted to a warning', () => {
    const [row] = toRows([plan({
      status: 'superseded',
      engineError: 'the phase table did not parse',
    })], [], NOW);
    expect(concerns(row).map((c) => c.key)).toEqual(['error']);
    expect(concerns(row)[0].tone).toBe('warn');
    expect(concerns(row)[0].text).toBe('the phase table did not parse');
  });

  it('separates closure from completeness — they are different questions', () => {
    // All phases done but nobody has closed it: complete, not closed.
    const [finished] = toRows([plan({ phases: 4, done: 4, ready: [] })], [], NOW);
    expect(finished.isComplete).toBe(true);
    expect(finished.isClosed).toBe(false);

    // Given up on with work left: closed, not complete.
    const [walkedAway] = toRows([plan({ status: 'abandoned', phases: 4, done: 1 })], [], NOW);
    expect(walkedAway.isClosed).toBe(true);
    expect(walkedAway.isComplete).toBe(false);
  });

  it('reads the server’s own closed flag ahead of the status word', () => {
    // A console talking to a server that learns a new terminal word must not
    // disagree with it. The flag wins; the word is the fallback.
    const [row] = toRows([plan({ status: 'shelved', closed: true, closedReason: 'parked for Q4' })], [], NOW);
    expect(row.isClosed).toBe(true);
    expect(row.closedReason).toBe('parked for Q4');
  });
});

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

describe('the five orders', () => {
  const rows = toRows([
    plan({ slug: 'recent', title: 'Recent', activity: NOW, percent: 10, done: 1, phases: 10, ready: [2] }),
    plan({ slug: 'nearly', title: 'Nearly', activity: 1, percent: 90, done: 9, phases: 10, ready: [10] }),
    plan({
      slug: 'wide', title: 'Wide', activity: 2, percent: 20, done: 2, phases: 10, ready: [3, 4, 5],
    }),
    plan({
      slug: 'broken', title: 'Broken', activity: 3, percent: 50, done: 5, phases: 10, ready: [6],
      issueCounts: { error: 2, warning: 0, info: 0 },
      issues: [{ slug: 'broken', severity: 'error', kind: 'engine', message: 'unreadable' }],
    }),
  ], [], NOW);

  it('leads each order with a different plan', () => {
    const first = (by: Parameters<typeof sortRows>[1]) => sortRows(rows, by)[0].slug;
    expect(first('activity')).toBe('recent');
    expect(first('progress')).toBe('nearly');
    expect(first('ready')).toBe('wide');
    expect(first('attention')).toBe('broken');
    expect(first('name')).toBe('broken'); // alphabetical, not editorial
    // Four distinct answers from five orders — `name` and `attention` agreeing
    // here is a coincidence of this fixture, not a collapsed comparator.
    expect(new Set([first('activity'), first('progress'), first('ready'), first('attention')]).size).toBe(4);
  });

  it('sinks finished plans in the closest-to-done order', () => {
    // "Closest to done" asked for the ones you can still finish. A wall of
    // hundred-percent bars answers a question nobody had.
    const withDone = toRows([
      plan({ slug: 'done', title: 'Done', phases: 4, done: 4, percent: 100, ready: [] }),
      plan({ slug: 'nearly', title: 'Nearly', phases: 4, done: 3, percent: 75, ready: [4] }),
    ], [], NOW);
    expect(sortRows(withDone, 'progress').map((r) => r.slug)).toEqual(['nearly', 'done']);
  });

  // Sunk, not dropped: the filter decides what is on the list, a sort only
  // decides where. But "most ready" and "needs attention" both ask *where do I
  // go next*, and a closed plan is never the answer — so with `showClosed` on,
  // an abandoned plan holding five ready phases must not head either board.
  it('sinks closed plans in the work-shaped orders', () => {
    const mixed = toRows([
      plan({ slug: 'walked-away', title: 'Walked away', status: 'abandoned', ready: [1, 2, 3, 4, 5],
        issueCounts: { error: 1, warning: 0, info: 0 },
        issues: [{ slug: 'walked-away', severity: 'error', kind: 'engine', message: 'unreadable' }] }),
      plan({ slug: 'live', title: 'Live', ready: [2] }),
    ], [], NOW);
    expect(sortRows(mixed, 'ready').map((r) => r.slug)).toEqual(['live', 'walked-away']);
    expect(sortRows(mixed, 'attention').map((r) => r.slug)).toEqual(['live', 'walked-away']);
    // Untouched orders stay honest — closure is not a global demotion.
    expect(sortRows(mixed, 'name').map((r) => r.slug)).toEqual(['live', 'walked-away']);
  });

  it('does not mutate the list it was given', () => {
    const before = rows.map((r) => r.slug);
    sortRows(rows, 'name');
    expect(rows.map((r) => r.slug)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * Filtering and grouping
 * ------------------------------------------------------------------ */

describe('filtering', () => {
  const rows = toRows([
    plan({ slug: 'cart-api-endpoint', title: 'Cart API endpoint', repos: ['shop'] }),
    plan({ slug: 'notes', title: 'Notes', kind: 'document', phases: 0, ready: [] }),
    plan({ slug: 'shipped', title: 'Shipped', status: 'complete', phases: 3, done: 3, ready: [] }),
  ], [], NOW);

  it('hides documents by default and brings them back on request', () => {
    // `shipped` is absent for a second, independent reason — it is `complete`,
    // therefore closed, and closed is hidden by default. See below.
    expect(applyFilters(rows, NO_FILTERS).map((r) => r.slug)).toEqual(['cart-api-endpoint']);
    expect(applyFilters(rows, { ...NO_FILTERS, showDocuments: true }).map((r) => r.slug))
      .toEqual(['cart-api-endpoint', 'notes']);
    expect(applyFilters(rows, { ...NO_FILTERS, showDocuments: true, showClosed: true }))
      .toHaveLength(3);
  });

  // The DIVERGENCE from the toggle this replaces: `showComplete` defaulted to
  // true, so the list opened on every finished plan in the source. Closure is
  // the operator saying nobody is coming back — the list opens on the work.
  it('hides closed plans by default and brings them back on request', () => {
    expect(applyFilters(rows, NO_FILTERS).map((r) => r.slug)).toEqual(['cart-api-endpoint']);
    expect(applyFilters(rows, { ...NO_FILTERS, showClosed: true }).map((r) => r.slug))
      .toEqual(['cart-api-endpoint', 'shipped']);
  });

  it('hides abandoned and superseded plans too, not only complete ones', () => {
    const terminal = toRows([
      plan({ slug: 'live' }),
      plan({ slug: 'walked-away', status: 'abandoned', ready: [2, 3] }),
      plan({ slug: 'replaced', status: 'superseded' }),
    ], [], NOW);
    expect(applyFilters(terminal, NO_FILTERS).map((r) => r.slug)).toEqual(['live']);
    expect(applyFilters(terminal, { ...NO_FILTERS, showClosed: true })).toHaveLength(3);
  });

  // Otherwise picking `abandoned` from the status dropdown returns nothing,
  // which reads as a broken control rather than two filters disagreeing.
  it('lets an explicit status filter override the closed filter', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, status: 'complete' }).map((r) => r.slug))
      .toEqual(['shipped']);
  });

  // "Closed" is three statuses, so picking one of them from the dropdown
  // answers a third of the question. These two sentinels ask it properly.
  it('offers open-only and closed-only, which no single status can express', () => {
    const terminal = toRows([
      plan({ slug: 'live' }),
      plan({ slug: 'walked-away', status: 'abandoned' }),
      plan({ slug: 'replaced', status: 'superseded' }),
      plan({ slug: 'shipped', status: 'complete' }),
    ], [], NOW);

    expect(applyFilters(terminal, { ...NO_FILTERS, status: CLOSED_ONLY }).map((r) => r.slug))
      .toEqual(['walked-away', 'replaced', 'shipped']);
    // …and it works without `showClosed`, which is the whole point: asking for
    // closed plans must not also require finding the toggle that permits them.
    expect(applyFilters(terminal, { ...NO_FILTERS, status: OPEN_ONLY }).map((r) => r.slug))
      .toEqual(['live']);
    // A sentinel is not a status. Compared to one, every list would be empty.
    expect(applyFilters(terminal, { ...NO_FILTERS, status: CLOSED_ONLY, showClosed: true }))
      .toHaveLength(3);
  });

  // A single "86 hidden" is true and useless: the operator's reasonable
  // conclusion is that the page is broken, not that two toggles are doing what
  // they were asked. Which filter is doing it is the actionable half.
  it('says how many rows each filter is hiding, and whether the search is involved', () => {
    const mixed = toRows([
      plan({ slug: 'live' }),
      plan({ slug: 'shipped', status: 'complete' }),
      plan({ slug: 'gone', status: 'abandoned' }),
      plan({ slug: 'notes', kind: 'document', status: 'active' }),
    ], [], NOW);

    const shape = hiddenBreakdown(mixed, NO_FILTERS);
    expect(shape.total).toBe(3);
    expect(shape.closed).toBe(2);
    expect(shape.documents).toBe(1);
    expect(shape.search).toBe(0);
    expect(shape.shapeOnly).toBe(true);

    // With a query on top, the shape counts stay about the shape toggles and
    // the query is accounted for separately — never double-counted.
    const searched = hiddenBreakdown(mixed, { ...NO_FILTERS, query: 'live' });
    expect(searched.search).toBe(3);
    expect(searched.shapeOnly).toBe(false);
  });

  // The counts are MARGINAL, and that is deliberate: a row hidden by BOTH
  // toggles comes back for neither of them alone, so it belongs to `total` and
  // to neither `closed` nor `documents`. A `+1` on a button that then returns
  // nothing is worse than no number at all.
  it('does not credit a toggle with rows the other toggle is also hiding', () => {
    const both = toRows([
      plan({ slug: 'live' }),
      plan({ slug: 'old-notes', kind: 'document', status: 'complete' }),
    ], [], NOW);
    const counts = hiddenBreakdown(both, NO_FILTERS);
    expect(counts.total).toBe(1);
    expect(counts.closed).toBe(0);
    expect(counts.documents).toBe(0);
  });

  // The counts are what the toggles PROMISE. A number that does not match what
  // pressing the button actually returns is worse than no number.
  it('each hidden count equals what turning that toggle on brings back', () => {
    const mixed = toRows([
      plan({ slug: 'live' }),
      plan({ slug: 'shipped', status: 'complete' }),
      plan({ slug: 'notes', kind: 'document' }),
    ], [], NOW);
    const before = applyFilters(mixed, NO_FILTERS).length;
    const counts = hiddenBreakdown(mixed, NO_FILTERS);

    expect(applyFilters(mixed, { ...NO_FILTERS, showClosed: true }).length - before)
      .toBe(counts.closed);
    expect(applyFilters(mixed, { ...NO_FILTERS, showDocuments: true }).length - before)
      .toBe(counts.documents);
  });

  it('matches words in any order, across the slug and the title', () => {
    const [row] = rows;
    expect(matches(row, 'cart api')).toBe(true);       // hyphenated slug, split query
    expect(matches(row, 'endpoint cart')).toBe(true);
    expect(matches(row, 'Endpoint')).toBe(true);       // case-insensitive
    expect(matches(row, 'cart checkout')).toBe(false); // every word must match
    expect(matches(row, '   ')).toBe(true);            // blank is not a filter
  });

  it('offers only the repos and statuses the data actually has', () => {
    expect(repoOptions(rows)).toEqual(['hub', 'shop']);
    expect(statusOptions(rows)).toEqual(['active', 'complete']);
  });
});

describe('grouping', () => {
  const rows = toRows([
    plan({ slug: 'a', title: 'A', repos: ['hub', 'shop'] }),
    plan({ slug: 'b', title: 'B', repos: [] }),
  ], [], NOW);

  it('keeps a plan that names no repo rather than dropping it', () => {
    // Grouping must not make rows disappear; "never said" is its own group.
    const groups = groupRows(rows, 'repo');
    const slugs = groups.flatMap((g) => g.rows.map((r) => r.slug));
    expect(slugs).toContain('b');
    expect(groups.at(-1)!.label).toBe('No repo named');
  });

  it('lists a plan under every repo it names', () => {
    const groups = groupRows(rows, 'repo');
    expect(groups.filter((g) => g.rows.some((r) => r.slug === 'a'))).toHaveLength(2);
  });

  it('leaves the rows in the order the sort gave them', () => {
    // A group that re-sorted its contents would mean the sort control silently
    // stops applying the moment you press Group.
    const sorted = sortRows(rows, 'name').reverse();
    expect(groupRows(sorted, 'none')[0].rows.map((r) => r.slug)).toEqual(['b', 'a']);
  });
});

describe('a row that has to fit', () => {
  it('caps a long repo list and keeps the whole of it in the tooltip', async () => {
    // A monorepo-wide plan can name a dozen repos — 178 characters of them. As
    // one truncated line that reads `all · api · billing · doc…`, which says
    // nothing the first name did not, and it was wide enough to push the card
    // 700px past the viewport before the wrapper was allowed to shrink.
    const { repoLabel } = await import('./row');
    const many = ['all', 'api', 'billing', 'docs', 'mobile-app', 'web-admin'];
    expect(repoLabel(many).text).toBe('all · api +4');
    expect(repoLabel(many).title).toBe(many.join(' · '));
    // A short list is not worth abbreviating.
    expect(repoLabel(['hub', 'shop']).text).toBe('hub · shop');
    expect(repoLabel([]).text).toBe('');
  });
});

describe('the totals', () => {
  it('counts plans and documents apart', () => {
    const rows = toRows([
      plan({ slug: 'a', ready: [2], remainingSessions: 2 }),
      plan({ slug: 'n', kind: 'document', phases: 0, ready: [], remainingSessions: 0 }),
    ], [], NOW);
    const totals = rowTotals(rows);
    expect(totals).toMatchObject({ plans: 1, documents: 1, ready: 1, sessions: 2 });
  });

  // The same split the server makes in `portfolio()`: the census counts every
  // plan, the forward-looking numbers count only the open ones. A subtitle
  // reading "6 ready · 4 sessions of work left" that included an abandoned
  // plan's phases is an invitation to start work nobody wants.
  it('counts a closed plan in the census but not in the work left', () => {
    const rows = toRows([
      plan({ slug: 'live', phases: 4, done: 1, ready: [2], remainingSessions: 2 }),
      plan({
        slug: 'gone', status: 'abandoned', phases: 6, done: 2, ready: [3, 4], remainingSessions: 3,
        issueCounts: { error: 1, warning: 0, info: 0 },
      }),
    ], [], NOW);
    const totals = rowTotals(rows);
    expect(totals).toMatchObject({
      plans: 2, closed: 1,      // census: both counted
      phases: 10, done: 3,      // census: history is not deleted
      ready: 1, sessions: 2, errors: 0, // work: only the open plan
    });
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const { state, plans, runs } = vi.hoisted(() => ({
  state: vi.fn(),
  plans: vi.fn(),
  runs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, plans, runs } };
});

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The SHIPPED defaults, so the page tests exercise what an operator opens on.
  setPrefs({ sort: 'activity', showDocuments: false, showClosed: false, plansLayout: 'board', plansGroup: 'none' });
  state.mockResolvedValue({
    autopilot: true, allowRun: true, allowWrites: false, unread: 0,
    root: { label: 'hub', path: '/hub', ok: true, planCount: 3 },
    repo: { available: true, branch: 'main', dirty: [] },
  });
  plans.mockResolvedValue([
    plan({ slug: 'alpha', title: '**Alpha** plan', ready: [2] }),
    plan({ slug: 'notes', title: 'Notes', kind: 'document', phases: 0, ready: [] }),
  ]);
  runs.mockResolvedValue([]);
});

describe('the plans page', () => {
  it('renders a title as text, not as markdown source', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    expect(await screen.findByText('Alpha plan')).toBeTruthy();
    expect(screen.queryByText(/\*\*Alpha\*\*/)).toBeNull();
  });

  it('hides the documents and says how many it hid, and by which filter', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Alpha plan');
    expect(screen.queryByText('Notes')).toBeNull();
    // Not a bare "1 hidden": which filter is doing it is the part that tells
    // you which control to reach for.
    expect(screen.getByText(/1 document hidden/)).toBeTruthy();
  });

  it('puts the count of what would come back on the toggle itself', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Alpha plan');
    // In the accessible name, not only in the pixels — "how many come back" is
    // the whole reason to press it.
    expect(await screen.findByRole('button', { name: 'Documents — 1 more' })).toBeTruthy();
  });

  it('brings the documents back when the toggle is pressed', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Documents/ }));
    expect(await screen.findByText('Notes')).toBeTruthy();
  });

  it('leaves a closed plan out of the list, one toggle away', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'alpha', title: 'Alpha plan' }),
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned', ready: [2, 3] }),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Alpha plan');
    expect(screen.queryByText('Walked away')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Show closed/ }));
    expect(await screen.findByText('Walked away')).toBeTruthy();
  });

  // The reported symptom, as a test. On the source this was written against the
  // page rendered ONE row out of eighty-seven and explained itself only in a
  // grey line under the controls — which reads as data loss, and was reported
  // as data loss. The list still opens on the work (that default is the
  // operator's own decision); what was wrong was doing it quietly.
  it('says so, loudly, when the filters are hiding most of the source', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'live', title: 'Still going' }),
      ...Array.from({ length: 8 }, (_, i) => plan({
        slug: `done-${i}`, title: `Finished ${i}`, status: 'complete',
      })),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Still going');

    expect(screen.getByText(/8 closed plans are not listed/)).toBeTruthy();
    // The heading must not claim the source holds one plan.
    expect(screen.getByText(/1 of 9 rows/)).toBeTruthy();

    // And one press brings them back — the band is an action, not a caption.
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByText('Finished 0')).toBeTruthy();
  });

  it('can be dismissed, and the counts survive the dismissal', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'live', title: 'Still going' }),
      ...Array.from({ length: 8 }, (_, i) => plan({
        slug: `done-${i}`, title: `Finished ${i}`, status: 'complete',
      })),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Still going');

    fireEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
    await waitFor(() => expect(screen.queryByText(/are not listed/)).toBeNull());

    // The banner is the loud form of a fact that is still on screen. Closing it
    // must not be the same as being told nothing — otherwise dismissing it puts
    // the operator back where this whole report started.
    expect(screen.getByRole('button', { name: 'Show closed — 8 more' })).toBeTruthy();
    expect(screen.getByText(/8 closed hidden/)).toBeTruthy();
  });

  // The table showed NO closure marker at all. Every signal it does show is one
  // that closure suppresses — Ready reads `—`, Left reads `—`, Health is blank
  // — so a closed plan rendered as a live plan with nothing left to do, which
  // is a worse reading than either truth.
  it('marks a closed plan as closed in the table, not only on the card', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'live', title: 'Still going' }),
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned' }),
    ]);
    setPrefs({ plansLayout: 'table', showClosed: true });
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);

    // Asserted on the badge's own text, and on a fixture with no `closedOn` —
    // the six plans closed by hand before `close-plan.sh` existed carry no
    // date, and they are exactly the ones that must still read as closed.
    const closedRow = (await screen.findByText('Walked away')).closest('tr');
    expect(closedRow).toBeTruthy();
    expect(within(closedRow as HTMLElement).getByText('abandoned')).toBeTruthy();

    // The control: the open plan beside it must NOT be badged, so the assertion
    // above cannot pass by the badge rendering on every row. (The table has no
    // status column, so its status word appears nowhere else.)
    const openRow = screen.getByText('Still going').closest('tr');
    expect(within(openRow as HTMLElement).queryByText('active')).toBeNull();
  });

  it('keeps quiet when the filters are only trimming the edges', async () => {
    // Proportional, not a raw count: hiding two of nine is the toggle working,
    // and a banner every visit would be the boy who cried wolf.
    plans.mockResolvedValue([
      ...Array.from({ length: 7 }, (_, i) => plan({ slug: `live-${i}`, title: `Live ${i}` })),
      plan({ slug: 'done', title: 'Finished', status: 'complete' }),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Live 0');
    expect(screen.queryByText(/are not listed/)).toBeNull();
  });

  // The row-level half of the ready board's gate. `readyPhases` stays populated
  // on a closed plan, and every one of these chips is a link into a phase
  // captioned "ready" — so the card has to say what happened instead.
  it('offers no ready chip on a closed plan, and says what did happen', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned', phases: 4, done: 1, ready: [2, 3] }),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Show closed/ }));
    await screen.findByText('Walked away');

    expect(screen.queryByText('P2 ready')).toBeNull();
    expect(screen.queryByText('P3 ready')).toBeNull();
    expect(screen.getByText('abandoned — 3 of 4 phases never ran')).toBeTruthy();
  });

  it('does not name a closed plan in the attention band', async () => {
    // The band is an error-severity call to action, and the server demotes a
    // closed plan's structural issues to `info` for exactly this reason. The
    // paired open plan is the control: it proves the band renders at all here,
    // so "the closed one is absent" cannot pass by the band never appearing.
    plans.mockResolvedValue([
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned', engineError: 'closed plan will not parse' }),
      plan({ slug: 'broken', title: 'Broken', engineError: 'open plan will not parse' }),
    ]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Show closed/ }));
    await screen.findByText('Walked away');

    const band = await screen.findByRole('status');
    expect(within(band).getByText(/open plan will not parse/)).toBeTruthy();
    expect(within(band).queryByText(/closed plan will not parse/)).toBeNull();
    // Still visible on its own row — demoted, not deleted.
    expect(screen.getByText('closed plan will not parse')).toBeTruthy();
  });

  it('does not print the slug twice when a plan has no title of its own', async () => {
    // The server falls back to the slug when a plan has no `# heading`, so a
    // card that always prints both reads `sa-robot-types-parity` twice.
    plans.mockResolvedValue([plan({ slug: 'sa-robot-types-parity', title: 'sa-robot-types-parity' })]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('sa-robot-types-parity');
    expect(screen.getAllByText('sa-robot-types-parity')).toHaveLength(1);
  });

  it('links a ready phase to that phase, not to the plan', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    const link = await screen.findByRole('link', { name: /P2 ready/ });
    expect(link.getAttribute('href')).toBe('#/plan/alpha/phase/2');
  });

  it('narrows the list as you search, and says nothing matched rather than showing an empty page', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    const box = await screen.findByLabelText(/Find a plan/);

    fireEvent.change(box, { target: { value: 'alpha' } });
    await waitFor(() => expect(screen.getByText('Alpha plan')).toBeTruthy());

    fireEvent.change(box, { target: { value: 'zzzz' } });
    expect(await screen.findByText(/Every plan is filtered out/)).toBeTruthy();
  });

  it('names a plan the engine could not read, at the top', async () => {
    plans.mockResolvedValue([plan({ slug: 'broken', title: 'Broken', engineError: 'phase table did not parse' })]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    const band = await screen.findByRole('status');
    expect(within(band).getByText(/phase table did not parse/)).toBeTruthy();
  });

  it('shows the live autopilot on a plan, and links it to the run tab', async () => {
    runs.mockResolvedValue([run({ slug: 'alpha', status: 'running', activePhase: 2 })]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    const link = await screen.findByRole('link', { name: /running P2/ });
    expect(link.getAttribute('href')).toBe('#/plan/alpha/run');
  });

  it('does not ask a server that has no run endpoints', async () => {
    state.mockResolvedValue({ autopilot: false, root: { label: 'hub', ok: true } });
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Alpha plan');
    expect(runs).not.toHaveBeenCalled();
  });

  it('marks the sorted column so a screen reader hears the order, not just the header', async () => {
    setPrefs({ plansLayout: 'table' });
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    const activity = await screen.findByRole('columnheader', { name: /Activity/ });
    expect(activity.getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('columnheader', { name: /Ready/ }).getAttribute('aria-sort')).toBe('none');
  });

  it('lights no filter amber until one of them is narrowing the view', async () => {
    // `--action` is the console's one rationed colour and it means "act on
    // this". A control that is amber in its default position has spent it
    // saying nothing — which is why the closed toggle had to turn round with
    // its default: "Hide finished" when showing was the default, "Show closed"
    // now that hiding is. Pressed still means the same thing on every filter —
    // *you have changed the default view*.
    const { default: PlansView } = await import('./index');
    const { container } = mount(<PlansView />);
    await screen.findByText('Alpha plan');

    const amber = () => [...container.querySelectorAll('button')]
      .filter((b) => b.className.includes('bg-action/12'))
      .map((b) => b.textContent?.trim());
    // The segmented sort control is the exception: `ButtonGroup` lights its
    // own pressed member, and one order is always in force.
    expect(amber().filter((label) => label !== 'Recent')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /^Show closed/ }));
    expect(amber()).toContain('Show closed');
  });

  it('says the source is empty rather than rendering a blank list', async () => {
    plans.mockResolvedValue([]);
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    expect(await screen.findByText('No plans here')).toBeTruthy();
  });

  it('reports a failed read as a failure, not as an empty source', async () => {
    plans.mockRejectedValue(new Error('the source went away'));
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    // The real `queryClientConfig` retries once before giving up, so the error
    // branch is a second away rather than immediate. Using the production
    // config is the point — a test client that never retried would pass here
    // and tell us nothing about the page people actually load.
    expect(await screen.findByText(/the source went away/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('No plans here')).toBeNull();
  });
});
