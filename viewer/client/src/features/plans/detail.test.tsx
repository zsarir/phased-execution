/**
 * The plan surface.
 *
 * Two properties are worth a test rather than a look:
 *
 * 1. **The tab strip is total over the frozen vocabulary.** `PLAN_TABS` lives in
 *    `shared/route-meta.js` because the *server* builds notification deep links
 *    from it. A tab added there and forgotten here is a push notification that
 *    opens a page saying nothing — so every id must have a label and a panel
 *    that is not the fallback.
 *
 * 2. **A repo change does not blank the page.** This is the defect the phase
 *    exists to fix, and it is invisible in a screenshot: the page looks right
 *    until something else in the repo moves, and then the plan you were reading
 *    is replaced by a spinner and your scroll position is gone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_TABS } from '@shared/route-meta.js';
import { queryClientConfig } from '@/lib/queries';
import type { PlanDetail } from '@/lib/api';
import PlanView from './detail';
import { DETAIL_TABS, TAB_IDS, resolveTab, tabLabel } from './tabs';

/* The api module is the only thing this view talks to. */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      plan: vi.fn(),
      planRaw: vi.fn(async () => '# raw plan body'),
      handoff: vi.fn(async () => ({
        slug: 'demo',
        phase: 1,
        file: 'phase-01-x.md',
        path: '/x',
        title: 'foundations',
        status: 'complete',
        completed: '2026-08-03',
        dependsOn: [],
        blocks: [2],
        parallelSafe: [],
        skillsUsed: ['phased-execution'],
        keyFiles: ['viewer/shared/routes.js'],
        outstanding: 'None.',
        prompts: 1,
        body: '## What this phase did\n\nScaffolded it.',
        bytes: 2048,
        mtime: 0,
      })),
      prompt: vi.fn(async () => '/phased-execution\n\nStart phase 2.'),
      nextPrompt: vi.fn(async () => 'board + prompts'),
      qaPrompt: vi.fn(async () => 'qa brief'),
      gate: vi.fn(async () => ({ kind: 'date', clear: true, detail: 'passed' })),
      // The run tab is a lazy child of this view, so its endpoints have to exist
      // here too. An idle console with no run is the case worth defaulting to:
      // it is what every plan looks like before anyone presses Start.
      state: vi.fn(async () => ({ allowRun: true, autopilot: true, allowWrites: false })),
      run: vi.fn(async () => ({ run: null, history: [], eta: null })),
      runTranscript: vi.fn(async () => []),
      approvals: vi.fn(async () => []),
      auth: vi.fn(async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' })),
      skills: vi.fn(async () => []),
    },
  };
});

const { api } = await import('@/lib/api');

const DETAIL: PlanDetail = {
  summary: {
    slug: 'demo',
    title: 'demo plan',
    kind: 'plan',
    status: 'active',
    created: '2026-08-01',
    activity: 0,
    phases: 3,
    done: 1,
    ready: [2],
    waiting: 1,
    inProgress: [],
    stuck: [],
    percent: 33,
    remainingWeight: 130_000,
    remainingSessions: 1,
    criticalPath: [2, 3],
    criticalWeight: 130_000,
    minimumSessions: 1,
    bottleneck: { phase: 2, blocks: 1 },
    nextBest: { phase: 2, unblocks: 1 },
    budget: 200_000,
    targetModel: 'claude-opus-5',
    branch: 'main',
    skills: [],
    mcpServers: [],
    qaMode: 'off',
    qaFailures: [],
    locks: [],
    repos: ['skill'],
    handoffCount: 1,
    lastCompleted: '2026-08-02',
    spanDays: 1,
    medianGapDays: 1,
    issues: [],
    issueCounts: { error: 0, warning: 0, info: 0 },
    hasHandoffs: true,
  },
  plan: {
    slug: 'demo',
    title: 'demo plan',
    context: 'Why this exists.',
    architecture: 'How it hangs together.',
    endToEnd: '1. Everything green.',
    sessionBudget: {
      raw: '**Target model:** `claude-opus-5`',
      targetModel: 'claude-opus-5',
      branch: 'main',
      skills: [],
      mcpServers: [],
    },
    graph: [
      {
        phase: 1,
        title: 'Foundations',
        dependsOn: [],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'it builds',
      },
      {
        phase: 2,
        title: 'Surface',
        dependsOn: [1],
        parallelSafe: '3',
        repos: 'skill',
        exitCriteria: 'it renders',
      },
      {
        phase: 3,
        title: 'Cutover',
        dependsOn: [2],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'web/ gone',
      },
    ],
    callouts: ['**Blocking:** `1 → 2 → 3`'],
    sections: [],
  },
  phases: [
    {
      phase: 1,
      title: 'Foundations',
      state: 'done',
      size: 'M',
      weight: 40_000,
      gated: false,
      goal: 'Scaffold the thing.',
      exitCriteria: '1. It builds.',
      bullets: [],
      row: {
        phase: 1,
        title: 'Foundations',
        dependsOn: [],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'it builds',
      },
      analysis: {
        phase: 1,
        state: 'done',
        size: 'M',
        weight: 40_000,
        dependsOn: [],
        dependents: [2],
        transitiveDependents: [2, 3],
        unblocks: 2,
        onCriticalPath: false,
      },
      handoff: {
        file: 'phase-01-x.md',
        status: 'complete',
        completed: '2026-08-02',
        title: 'foundations',
        outstanding: 'None.',
        skillsUsed: ['phased-execution'],
        prompts: 1,
      },
    },
    {
      phase: 2,
      title: 'Surface',
      state: 'ready',
      size: 'L',
      weight: 90_000,
      gated: false,
      goal: 'Build the **surface**.',
      steps: '1. Do it.',
      exitCriteria: '1. It renders.',
      bullets: [],
      row: {
        phase: 2,
        title: 'Surface',
        dependsOn: [1],
        parallelSafe: '3',
        repos: 'skill',
        exitCriteria: 'it renders',
      },
      analysis: {
        phase: 2,
        state: 'ready',
        size: 'L',
        weight: 90_000,
        dependsOn: [1],
        dependents: [3],
        transitiveDependents: [3],
        unblocks: 1,
        onCriticalPath: true,
      },
    },
    {
      phase: 3,
      title: 'Cutover',
      state: 'waiting',
      size: 'S',
      weight: 15_000,
      gated: false,
      bullets: [],
      row: {
        phase: 3,
        title: 'Cutover',
        dependsOn: [2],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'web/ gone',
      },
      analysis: {
        phase: 3,
        state: 'waiting',
        size: 'S',
        weight: 15_000,
        dependsOn: [2],
        dependents: [],
        transitiveDependents: [],
        unblocks: 0,
        onCriticalPath: true,
      },
    },
  ],
  route: {
    nodes: [
      { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
      { phase: 2, layer: 1, row: 0, state: 'ready', size: 'L', gated: false, title: 'Surface' },
      { phase: 3, layer: 2, row: 0, state: 'waiting', size: 'S', gated: false, title: 'Cutover' },
    ],
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ],
    layers: 3,
    rows: 1,
  },
  batches: {
    groups: [{ index: 1, kind: 'batch', weight: '105K', phases: [2, 3], gated: false }],
    raw: '',
    budget: '200K/session',
  },
  boardText: 'Phase graph — demo   (1/3 done)',
  lint: { ok: true, issues: [], summary: 'LINT OK: demo — 3 phases', timedOut: false },
  handoffs: [
    {
      phase: 1,
      file: 'phase-01-x.md',
      title: 'foundations',
      status: 'complete',
      completed: '2026-08-02',
      bytes: 2048,
      mtime: 0,
      prompts: 1,
      skillsUsed: ['phased-execution'],
    },
  ],
  index: [{ phase: 1, title: 'foundations', status: 'complete', link: 'phase-01-x.md' }],
  qa: [],
  locks: [],
  git: { sha: 'abc1234', subject: 'x', relativeDate: '2 hours ago', dirty: false },
  memory: { key: 'project_demo', path: '/m.md', text: '**Status:** done 1.', indexLines: [] },
};

function route(...segments: string[]) {
  return { segments, query: {}, path: segments.join('/') };
}

function renderPlan(segments: string[], client = new QueryClient(queryClientConfig)) {
  const view = render(
    <QueryClientProvider client={client}>
      <PlanView route={route('plan', ...segments)} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.mocked(api.plan).mockReset().mockResolvedValue(DETAIL);
});

describe('the tab strip', () => {
  it('is a real tablist with one tab per frozen id', async () => {
    renderPlan(['demo']);
    const list = await screen.findByRole('tablist', { name: 'Plan sections' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(TAB_IDS.map(tabLabel));
  });

  it('gives every frozen tab id a label and a panel that is not the fallback', async () => {
    // The fallback is the Route tab; a tab that renders it is a tab nobody
    // built. `route` itself is excluded for the obvious reason.
    for (const id of TAB_IDS) {
      const { unmount } = renderPlan(['demo', id]);
      await screen.findByRole('tablist');
      expect(tabLabel(id), `${id} has no label`).not.toBe(id);
      const panel = screen.getByRole('tabpanel');
      if (id !== 'route') {
        expect(within(panel).queryByText('Departures'), `${id} fell through to Route`).toBeNull();
      }
      unmount();
    }
  });

  it('moves between tabs with the arrow keys, not just the mouse', async () => {
    renderPlan(['demo']);
    const list = await screen.findByRole('tablist', { name: 'Plan sections' });
    const tabs = within(list).getAllByRole('tab');

    tabs[0].focus();
    expect(tabs[0]).toHaveFocus();
    // Radix moves focus in a `setTimeout`, so this is genuinely asynchronous —
    // asserting synchronously passes only by accident of implementation.
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[1]).toHaveFocus());
    fireEvent.keyDown(tabs[1], { key: 'End' });
    await waitFor(() => expect(tabs.at(-1)).toHaveFocus());
  });

  it('costs one Tab press to reach, and lands on the tab you are on', async () => {
    // Radix puts the tab stop on the *list* and delegates inward, rather than
    // giving one item `tabindex=0`. Both are valid roving-tabindex; asserting
    // the wrong one would "fail" a strip that works. What matters is that the
    // strip is one stop, and that entering it lands on the selected tab —
    // the old client made all seven separate stops.
    renderPlan(['demo', 'analysis']);
    const list = await screen.findByRole('tablist', { name: 'Plan sections' });
    expect(list).toHaveAttribute('tabindex', '0');
    expect(
      within(list)
        .getAllByRole('tab')
        .every((t) => t.getAttribute('tabindex') === '-1'),
    ).toBe(true);

    fireEvent.focus(list);
    await waitFor(() => expect(screen.getByRole('tab', { selected: true })).toHaveFocus());
  });

  it('shows a detail sub-route under the list it was reached from', async () => {
    renderPlan(['demo', 'phase', '2']);
    const selected = await screen.findByRole('tab', { selected: true });
    expect(selected).toHaveTextContent(tabLabel(DETAIL_TABS.phase));
    expect(screen.getByRole('link', { name: /All phases/ })).toBeInTheDocument();
  });
});

describe('resolveTab', () => {
  it('defaults to the route map and maps the two detail sub-routes', () => {
    expect(resolveTab(undefined)).toBe('route');
    expect(resolveTab('phase')).toBe('phases');
    expect(resolveTab('handoff')).toBe('handoffs');
  });

  it('falls back rather than showing an empty strip for an unknown segment', () => {
    expect(resolveTab('not-a-tab')).toBe('route');
  });

  it('accepts every id the shared vocabulary declares', () => {
    for (const id of PLAN_TABS as readonly string[]) expect(resolveTab(id)).toBe(id);
  });
});

describe('a repo change does not blank the page', () => {
  it('keeps the plan on screen while a `changed` refetch is in flight', async () => {
    const client = new QueryClient(queryClientConfig);
    renderPlan(['demo'], client);
    await screen.findByText('demo plan');
    expect(screen.getByText('Departures')).toBeInTheDocument();

    // What the SSE bridge does for a `changed` event naming this slug — with a
    // refetch that has not answered yet.
    let release: (value: PlanDetail) => void = () => {};
    vi.mocked(api.plan).mockReturnValueOnce(
      new Promise<PlanDetail>((resolve) => {
        release = resolve;
      }),
    );
    // NOT awaited: `invalidateQueries` resolves only once the refetch settles,
    // and the refetch is the thing being held open — awaiting it here deadlocks
    // the test rather than testing the in-flight state.
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['plan', 'demo'] });
    });

    // The old view set its state to null here and rendered a spinner.
    expect(screen.getByText('demo plan')).toBeInTheDocument();
    expect(screen.getByText('Departures')).toBeInTheDocument();

    await act(async () => {
      release(DETAIL);
    });
    await waitFor(() => expect(screen.getByText('demo plan')).toBeInTheDocument());
  });

  it('does show a skeleton for a *different* plan, rather than the previous one', async () => {
    const client = new QueryClient(queryClientConfig);
    const { rerender } = renderPlan(['demo'], client);
    await screen.findByText('demo plan');

    vi.mocked(api.plan).mockReturnValueOnce(new Promise<PlanDetail>(() => {}));
    rerender(
      <QueryClientProvider client={client}>
        <PlanView route={route('plan', 'other')} />
      </QueryClientProvider>,
    );

    // Holding `demo plan` under the name `other` would be a lie about the data.
    await waitFor(() => expect(screen.queryByText('demo plan')).toBeNull());
  });
});

describe('the plan surface renders its parts', () => {
  it('puts the ready phase on the header as a real link', async () => {
    renderPlan(['demo']);
    const link = await screen.findByRole('link', { name: 'P2 ready' });
    expect(link).toHaveAttribute('href', '#/plan/demo/phase/2');
  });

  /* ---------------- a closed plan reads as closed ----------------
   * `summary.ready` stays populated on a closed plan — the engine reports what
   * never got done so this page can say so — and everything below turns that
   * array into an invitation. The page has to keep the record and drop the
   * invitations. */

  const closedDetail = (over: Record<string, unknown> = {}) =>
    ({
      ...DETAIL,
      summary: {
        ...DETAIL.summary,
        status: 'abandoned',
        closed: true,
        closedOn: '2026-08-05',
        closedReason: 'the approach did not survive contact',
        ...over,
      },
      batches: { groups: [], raw: '🔒 CLOSED [abandoned]\n\nNo sessions to plan.\n', budget: '200K/session' },
    }) as PlanDetail;

  // Reported: a closed plan did not read as closed. It carried the padlock on
  // its status chip, which is correct and, at chip size beside a heading and
  // next to the `document` chip, was read as one more piece of metadata.
  // Closure is not metadata — it changes how everything below it should be read.
  it('badges a closed plan in the header, saying both CLOSED and the status word', async () => {
    vi.mocked(api.plan).mockResolvedValue(closedDetail());
    renderPlan(['demo']);
    const badge = await screen.findByTitle(/Closed/);
    expect(badge.textContent).toContain('Closed');
    // Both words: `CLOSED` is the fact, `abandoned` is the one that says more.
    expect(badge.textContent).toContain('abandoned');
  });

  it('leaves an open plan its plain status chip — no badge, no padlock', async () => {
    vi.mocked(api.plan).mockResolvedValue(DETAIL);
    renderPlan(['demo']);
    await screen.findByText(DETAIL.summary.title);
    expect(screen.queryByTitle(/Closed/)).toBeNull();
  });

  it('leads a closed plan with why it is closed, not with what could start', async () => {
    vi.mocked(api.plan).mockResolvedValue(closedDetail());
    renderPlan(['demo']);
    // `getAllByText`: the reason sits in a text node whose parent and
    // grandparent both match. What matters is that it is on the page once, in
    // the banner, beside the status word and the date.
    expect(await screen.findByText('Closed — abandoned on 2026-08-05')).toBeTruthy();
    expect(screen.getAllByText(/the approach did not survive contact/).length).toBeGreaterThan(0);
    // The chips and the boot-prompt card are the invitations. All gone.
    expect(screen.queryByRole('link', { name: 'P2 ready' })).toBeNull();
    expect(screen.queryByText('Boot prompt — phase 2')).toBeNull();
    // The record is not: the phase is still reachable from the departures table.
    expect(screen.getByRole('link', { name: '02' })).toHaveAttribute('href', '#/plan/demo/phase/2');
  });

  it('says why there are no suggested sessions rather than dropping the card', async () => {
    // `--session-plan` answers a closed plan with its banner and no groups, so
    // the card would simply vanish — which reads as a console that failed to
    // compute one, on a plan still showing unfinished phases.
    vi.mocked(api.plan).mockResolvedValue(closedDetail());
    renderPlan(['demo']);
    expect(await screen.findByText('No sessions to plan')).toBeTruthy();
    // The batching lives in the health panel's "What is left" card, which a
    // closed plan does not get at all.
    expect(screen.queryByText('What is left')).toBeNull();
  });

  it('still offers the boot prompt and the batches on an OPEN plan', async () => {
    // The control for the two above: they must be asserting closure, not a
    // fixture that never had these in the first place.
    renderPlan(['demo']);
    expect(await screen.findByRole('link', { name: 'P2 ready' })).toBeTruthy();
    expect(screen.getByText('What is left')).toBeTruthy();
    // The batch itself, not just the card around it.
    expect(screen.getByText('P2 + P3')).toBeTruthy();
  });

  it('makes every departures row reachable by keyboard', async () => {
    renderPlan(['demo']);
    await screen.findByText('Departures');
    // One link per phase, each carrying the phase deep link — not a `tr onClick`.
    for (const phase of [1, 2, 3]) {
      expect(screen.getByRole('link', { name: String(phase).padStart(2, '0') })).toHaveAttribute(
        'href',
        `#/plan/demo/phase/${phase}`,
      );
    }
  });

  it('renders a phase panel through the markdown pipeline', async () => {
    renderPlan(['demo', 'phase', '2']);
    await screen.findByRole('tabpanel');
    expect(screen.getByText('Goal')).toBeInTheDocument();
    // `**surface**` came through the sanitizer as real emphasis, not asterisks.
    const strong = document.querySelector('.md strong');
    expect(strong?.textContent).toBe('surface');
  });

  it('mounts the real run view on the run tab', async () => {
    // It arrives through a `lazy()` boundary, so this also proves the Suspense
    // fallback resolves rather than leaving the tab on a spinner for ever.
    renderPlan(['demo', 'run']);
    expect(await screen.findByText('Start a run')).toBeInTheDocument();
  });

  it('reports a missing phase instead of rendering an empty panel', async () => {
    renderPlan(['demo', 'phase', '99']);
    expect(await screen.findByText(/No phase 99 in this plan/)).toBeInTheDocument();
  });

  /* The boot prompt used to exist only on `ready` and `in-progress`, which sent
     anyone with a legitimate reason to read the others — re-running a phase,
     seeing what a finished session was told — to the CLI to print it by hand.
     It is on every state now; what changes with the state is the warning above
     it and whether it starts open. */
  describe('the boot prompt', () => {
    it('is open with no caution on the one phase that can actually start', async () => {
      renderPlan(['demo', 'phase', '2']);
      expect(await screen.findByText('Boot prompt — phase 2')).toBeInTheDocument();
      // Open: the engine's text is already on screen, no Show button.
      expect(await screen.findByText(/Start phase 2\./)).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('a departed phase keeps its prompt, collapsed, and says so', async () => {
      renderPlan(['demo', 'phase', '1']);
      expect(await screen.findByText('Boot prompt — phase 1')).toBeInTheDocument();
      // The caution's own words, not the bare state: "Departed" is also the
      // board word on the state chip beside it.
      expect(screen.getByText(/kept for reference/i)).toBeInTheDocument();
      // Collapsed costs nothing: the card does not fetch until it is opened.
      // (Scoped to THIS phase — the engine mock is shared across the file, so
      // "never called" would be an assertion about the other tests.)
      expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
      expect(vi.mocked(api.prompt)).not.toHaveBeenCalledWith('demo', 1);

      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(await screen.findByText(/Start phase 2\./)).toBeInTheDocument();
      expect(vi.mocked(api.prompt)).toHaveBeenCalledWith('demo', 1);
    });

    it('a waiting phase warns that a session booted now stops at the checks', async () => {
      renderPlan(['demo', 'phase', '3']);
      expect(await screen.findByText('Boot prompt — phase 3')).toBeInTheDocument();
      expect(screen.getByText(/stops at the lock and board checks/i)).toBeInTheDocument();
      // The caution is OUTSIDE the collapse — hidden behind the same toggle it
      // would reach only someone who had already decided to look.
      expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
    });

    it('names the lock for a phase somebody else is already on', async () => {
      const inProgress = DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, state: 'in-progress' } : p));
      vi.mocked(api.plan).mockResolvedValue({ ...DETAIL, phases: inProgress });
      renderPlan(['demo', 'phase', '2']);

      expect(await screen.findByText(/phase-lock will refuse a second one/i)).toBeInTheDocument();
    });

    it('a gate outranks the state — it is what actually holds the phase', async () => {
      const gated = DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, gated: true } : p));
      vi.mocked(api.plan).mockResolvedValue({ ...DETAIL, phases: gated });
      renderPlan(['demo', 'phase', '2']);

      // `ready` on the board, but the gate is the wall a booted session hits.
      expect(await screen.findByText(/stops at the gate check/i)).toBeInTheDocument();
    });

    it('the Gate card names the category and, with writes off, says how to approve', async () => {
      const gated = DETAIL.phases.map((p) =>
        p.phase === 2
          ? { ...p, gated: true, gateKind: 'human' as const, gates: '1. mint the keys\n2. export them' }
          : p,
      );
      vi.mocked(api.plan).mockResolvedValue({ ...DETAIL, phases: gated });
      renderPlan(['demo', 'phase', '2']);

      expect(await screen.findByText('human gate')).toBeInTheDocument();
      expect(await screen.findByText(/gate-approve\.sh/)).toBeInTheDocument();
      // Writes are off in this console's state mock — no button, an honest hint.
      expect(screen.queryByText('Approve gate')).toBeNull();
    });

    it('an ai gate says booting IS the way through', async () => {
      const gated = DETAIL.phases.map((p) =>
        p.phase === 2 ? { ...p, gated: true, gateKind: 'ai' as const, gates: 'staging deployed' } : p,
      );
      vi.mocked(api.plan).mockResolvedValue({ ...DETAIL, phases: gated });
      renderPlan(['demo', 'phase', '2']);

      expect(await screen.findByText('ai gate')).toBeInTheDocument();
      expect(await screen.findByText(/booting IS the way through/i)).toBeInTheDocument();
    });
  });

  it('renders a handoff body as markdown', async () => {
    renderPlan(['demo', 'handoff', '1']);
    expect(await screen.findByText('Scaffolded it.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What this phase did' })).toBeInTheDocument();
  });
});
