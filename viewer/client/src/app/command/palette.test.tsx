/**
 * The ⌘K palette.
 *
 * It absorbed a whole destination, so this file absorbed that destination's
 * tests: every case below except the last two was a `views/search.tsx` case
 * before 3.0. What changed is the shape of a result — a row in a command list
 * rather than an `<a>` on a page — so "goes to the right place for its kind" is
 * asserted against where the palette navigates rather than against an `href`.
 *
 * The properties that were worth a test on the search page are still exactly
 * the ones worth a test here: two characters before the server is asked, a hit
 * lands on the thing it matched, a snippet is never parsed as markup, and a
 * closed plan stays in the results *and says so* — search that hides history is
 * search you stop trusting, and a result with no marker reads as live work.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import { queryClientConfig, type ShellCounts as Counts } from '@/lib/queries';
import { Palette } from './palette';

const { state, search, plans, runs } = vi.hoisted(() => ({
  state: vi.fn(),
  search: vi.fn(),
  plans: vi.fn(),
  runs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, search, plans, runs } };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

const counts: Counts = {
  plans: 3,
  phases: 11,
  ready: 2,
  approvals: 0,
  needsYou: 0,
  sessions: 0,
  unread: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
};

const route = (hash: string): Route => parseHash(hash) as Route;

/**
 * One row, found by its label rather than by its accessible name.
 *
 * A row's name is its label AND its hint concatenated, so `/Settings/` also
 * matches "Shut this console down… · Settings" and `/The alpha plan/` also
 * matches every ready phase underneath it. The label is the unambiguous half.
 */
const rowNamed = async (label: string | RegExp): Promise<HTMLElement> => {
  const text = await screen.findByText(label, { selector: 'span' });
  return text.closest('[cmdk-item]') as HTMLElement;
};

/** The palette, open at `?k=<term>` on Now. `onNavigate` is where a pick lands. */
function open(term: string, over: Partial<ConsoleState> = {}) {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/now" onNavigate={onNavigate}>
        <Palette
          route={route(`#/now?k=${encodeURIComponent(term)}`)}
          state={{ ...BASE_STATE, ...over }}
          counts={counts}
        />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

const hit = (over: Record<string, unknown> = {}) => ({
  slug: 'demo',
  kind: 'plan',
  section: 'Context',
  title: 't',
  score: 1,
  snippet: 'the cart api',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(BASE_STATE);
  plans.mockResolvedValue([]);
  runs.mockResolvedValue([]);
  search.mockResolvedValue({ query: '', total: 0, groups: [] });
});

describe('the full-text leg', () => {
  it('does not ask the server for one character', async () => {
    open('a');
    // The palette still renders — the navigation and the verbs are always there.
    expect(await rowNamed('Plans')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it('sends every hit to the right place for its kind', async () => {
    search.mockResolvedValue({
      query: 'cart',
      total: 3,
      groups: [
        {
          slug: 'demo',
          title: 'demo plan',
          hits: [
            hit({ kind: 'phase', phase: 3, section: 'Phase 3' }),
            hit({ kind: 'handoff', phase: 2, section: 'State now', snippet: 'cart done' }),
            hit({ kind: 'plan', snippet: 'cart everywhere' }),
          ],
        },
      ],
    });
    const { onNavigate } = open('cart');

    // Wait for the ROWS, not for the group heading: the heading is also what
    // the "Searching…" state renders, so finding it proves nothing landed.
    const rows = await waitFor(() => {
      const found = screen.getAllByRole('option').filter((row) => row.textContent?.includes('demo'));
      expect(found.length).toBeGreaterThanOrEqual(3);
      return found;
    });

    for (const [i, expected] of [
      '#/plan/demo/phase/3',
      '#/plan/demo/handoff/2',
      '#/plan/demo/source',
    ].entries()) {
      fireEvent.click(rows[i]!);
      expect(onNavigate, expected).toHaveBeenCalledWith(expected);
    }
  });

  it('marks the matched terms without letting the snippet be parsed as markup', async () => {
    search.mockResolvedValue({
      query: 'cart',
      total: 1,
      groups: [
        {
          slug: 'demo',
          title: 'demo plan',
          hits: [hit({ snippet: 'the cart <script>alert(1)</script> api' })],
        },
      ],
    });
    const { container } = open('cart');

    await waitFor(() => {
      const marks = screen.getAllByText('cart');
      expect(marks.some((el) => el.tagName === 'MARK')).toBe(true);
    });
    // The snippet is React text, so the tag is inert regardless of the sanitizer.
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>/)).toBeTruthy();
  });

  it('says nothing matched rather than showing an empty list', async () => {
    const { onNavigate } = open('zzzz');
    await waitFor(() => expect(search).toHaveBeenCalled());
    // No documents matched AND no action matched, so the whole list is empty —
    // which is when cmdk shows the empty state.
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('keeps a closed plan in the results, and says that it is closed', async () => {
    plans.mockResolvedValue([
      { slug: 'gone', kind: 'plan', phases: 4, ready: [], status: 'abandoned', closed: true },
      { slug: 'demo', kind: 'plan', phases: 4, ready: [2], status: 'active', closed: false },
    ]);
    search.mockResolvedValue({
      query: 'cart',
      total: 2,
      groups: [
        { slug: 'gone', title: 'walked away', hits: [hit({ slug: 'gone', score: 2 })] },
        { slug: 'demo', title: 'demo plan', hits: [hit()] },
      ],
    });
    open('cart');

    // Present, both of them — relevance is the only ranking a search has.
    await waitFor(() => expect(screen.getByText('gone')).toBeTruthy());
    expect(screen.getByText('demo')).toBeTruthy();
    // Marked exactly once: the closed one.
    expect(screen.getAllByText('closed')).toHaveLength(1);
  });
});

describe('the commands', () => {
  it('offers every destination this console has, and none it has not', async () => {
    open('');
    for (const label of ['Now', 'Plans', 'Runs', 'Insights', 'Help']) {
      expect(await rowNamed(label), label).toBeTruthy();
    }
    // "Settings" is both a destination and the hint on "Shut this console
    // down…", so it is asked for by the group it belongs to.
    const go = screen.getByRole('group', { name: 'Go to' });
    expect(within(go).getByText('Settings')).toBeTruthy();
    // Sessions is gated on a flag this console does not have.
    expect(within(go).queryByText('Sessions')).toBeNull();
  });

  it('offers a verb only where the flag that governs it is on', async () => {
    open('', { allowTerminal: true, allowAgent: true, allowWrites: true });
    expect(await rowNamed('Open a terminal')).toBeTruthy();
    expect(await rowNamed('Open an agent session')).toBeTruthy();
    expect(await rowNamed('New plan…')).toBeTruthy();
    expect(await rowNamed('Sessions')).toBeTruthy();
  });

  it('names every plan and every phase that could start', async () => {
    plans.mockResolvedValue([
      { slug: 'alpha', kind: 'plan', title: 'The alpha plan', phases: 9, ready: [4, 5] },
      { slug: 'docs', kind: 'document', phases: 0, ready: [] },
    ]);
    const { onNavigate } = open('');

    fireEvent.click(await rowNamed('The alpha plan'));
    expect(onNavigate).toHaveBeenCalledWith('#/plan/alpha/route');

    // `/api/plans` sends the queue as bare numbers, so a ready phase is
    // addressable by number under its plan's name — the fastest route to the
    // thing that can actually start.
    fireEvent.click(await rowNamed('Phase 4'));
    expect(onNavigate).toHaveBeenCalledWith('#/plan/alpha/phase/4');
    expect(await rowNamed('Phase 5')).toBeTruthy();
    // A document is not a plan.
    expect(screen.queryByText('docs', { selector: 'span' })).toBeNull();
  });

  it('is closed by going anywhere, because the URL it left has no ?k=', async () => {
    const { onNavigate } = open('');
    fireEvent.click(await rowNamed('Plans'));
    expect(onNavigate).toHaveBeenCalledWith('#/plans');
    // Nothing had to remember to close it: the destination simply does not
    // carry the query that opens it.
    expect(onNavigate.mock.calls.flat().some((path) => String(path).includes('k='))).toBe(false);
  });
});

describe('the way in', () => {
  it('opens on ⌘K from a page that is not Now, keeping that page underneath', () => {
    const onNavigate = vi.fn();
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial="#/runs" onNavigate={onNavigate}>
          <Palette route={route('#/runs')} state={BASE_STATE} counts={counts} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    // `?k=` ON the Runs page — ⌘K is not a navigation.
    expect(onNavigate).toHaveBeenCalledWith('#/runs?k=');
  });

  it('opens on `/` — but never while something is being typed into', () => {
    const onNavigate = vi.fn();
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial="#/now" onNavigate={onNavigate}>
          <Palette route={route('#/now')} state={BASE_STATE} counts={counts} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '/' });
    expect(onNavigate).not.toHaveBeenCalled();
    input.remove();

    fireEvent.keyDown(window, { key: '/' });
    expect(onNavigate).toHaveBeenCalledWith('#/now?k=');
  });

  it('closes on a second ⌘K', () => {
    const { onNavigate } = open('');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(onNavigate).toHaveBeenCalledWith('#/now');
  });
});
