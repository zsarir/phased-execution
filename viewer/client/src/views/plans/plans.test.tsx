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
  NO_FILTERS, applyFilters, concerns, groupRows, matches, repoOptions, rowTotals,
  sortRows, statusOptions, toRows,
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
  skills: [],
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
    expect(applyFilters(rows, NO_FILTERS).map((r) => r.slug)).toEqual(['cart-api-endpoint', 'shipped']);
    expect(applyFilters(rows, { ...NO_FILTERS, showDocuments: true })).toHaveLength(3);
  });

  it('drops finished plans when asked', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, showComplete: false }).map((r) => r.slug))
      .toEqual(['cart-api-endpoint']);
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
  setPrefs({ sort: 'activity', showDocuments: false, showComplete: true, plansLayout: 'board', plansGroup: 'none' });
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

  it('hides the documents and says how many it hid', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    await screen.findByText('Alpha plan');
    expect(screen.queryByText('Notes')).toBeNull();
    expect(screen.getByText(/1 hidden by filters/)).toBeTruthy();
  });

  it('brings the documents back when the toggle is pressed', async () => {
    const { default: PlansView } = await import('./index');
    mount(<PlansView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('Notes')).toBeTruthy();
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
    // saying nothing — which is why the finished toggle is worded "Hide
    // finished" rather than "Finished".
    const { default: PlansView } = await import('./index');
    const { container } = mount(<PlansView />);
    await screen.findByText('Alpha plan');

    const amber = () => [...container.querySelectorAll('button')]
      .filter((b) => b.className.includes('bg-action/12'))
      .map((b) => b.textContent?.trim());
    // The segmented sort control is the exception: `ButtonGroup` lights its
    // own pressed member, and one order is always in force.
    expect(amber().filter((label) => label !== 'Recent')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Hide finished' }));
    expect(amber()).toContain('Hide finished');
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
