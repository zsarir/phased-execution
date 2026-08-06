/**
 * The Agent page.
 *
 * The pane is mocked for the same reason the terminal's test mocks it: xterm
 * measures real fonts and owns a live socket, neither of which jsdom has, and
 * neither of which is what this page is responsible for. What IS asserted is
 * ours:
 *
 * - Both absence states name their own fix (`--allow-agent` vs `node-pty`).
 * - Visiting the page spawns nothing; the LAUNCHER is the empty state, and
 *   only its Start button mints — with exactly the enum body it collected.
 * - The launcher's navigation survives the refetch its own mint triggers
 *   (the isFetching bounce regression, inherited from the terminal page).
 * - Only claude-kind sessions appear here; the cap counts both kinds.
 * - An ended session offers `claude --resume <id>` — button and copyable.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState, TerminalState } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * Mocks
 * ------------------------------------------------------------------ */

const { state, terminal, agentTicket, terminalClose, skills, plansApi, pane } = vi.hoisted(() => ({
  state: vi.fn(),
  terminal: vi.fn(),
  agentTicket: vi.fn(),
  terminalClose: vi.fn(),
  skills: vi.fn(),
  plansApi: vi.fn(),
  pane: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state, terminal, agentTicket, terminalClose, skills,
      plans: plansApi,
      approvals: vi.fn(async () => []),
    },
  };
});

// Only the emulator is stubbed — the ended/gone panels are re-exported from
// `pane` (see the note there) and are under test, so they come through for real
// from `../terminal/ended`, which pulls in no xterm.
vi.mock('../terminal/pane', async () => ({
  ...(await import('../terminal/ended')),
  // The real one — its own behaviour has its own test file.
  ...(await import('../terminal/vitals')),
  // Also real, and re-exported through the pane facade in production, so the
  // mock must carry it too.
  ...(await import('./session-controls')),
  TerminalPane: (props: { sessionId: string }) => {
    pane(props.sessionId);
    return <div data-testid="pane">{props.sessionId}</div>;
  },
}));

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  allowTerminal: false,
  allowAgent: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  recentRoots: [],
  unread: 0,
};

const CLAUDE = {
  id: 'c1', label: 'Claude: hello', kind: 'claude' as const, cwd: '/repo', shell: 'claude',
  cols: 100, rows: 30, pid: 901, clients: 1, createdAt: 0,
  meta: { model: 'opus', claudeSessionId: '00000000-0000-4000-8000-000000000000' },
};

const SHELL = {
  id: 's1', label: 'Terminal 1', kind: 'shell' as const, cwd: '/repo', shell: '/bin/zsh',
  cols: 100, rows: 30, pid: 900, clients: 1, createdAt: 0,
};

const TERMINALS: TerminalState = {
  allowed: false, agentAllowed: true, available: 'yes', limit: 8, sessions: [CLAUDE, SHELL],
};

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function openPage(route = { segments: ['agent'], query: {}, path: 'agent' }) {
  const { default: AgentView } = await import('./index');
  return mount(<AgentView route={route} />);
}

/** The page reading the route live from the hash, the way `App` does. */
async function openLive(hash: string) {
  window.location.hash = hash;
  const { default: AgentView } = await import('./index');
  const { useRoute } = await import('@/router');
  const Harness = () => <AgentView route={useRoute()} />;
  return mount(<Harness />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  state.mockResolvedValue(BASE_STATE);
  terminal.mockResolvedValue(TERMINALS);
  skills.mockResolvedValue([]);
  plansApi.mockResolvedValue([]);
  agentTicket.mockResolvedValue({
    ok: true, sessionId: 'a1', token: 't', expiresAt: 0, path: '/ws/terminal',
    session: { ...CLAUDE, id: 'a1', label: 'Claude 1' },
  });
  terminalClose.mockResolvedValue({ closed: true, state: { ...TERMINALS, sessions: [] } });
});

/* ------------------------------------------------------------------ *
 * The two ways there is no agent
 * ------------------------------------------------------------------ */

describe('when there is no agent', () => {
  it('says the flag is off, and names the flag', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: false });
    await openPage();

    expect(await screen.findByText(/agent sessions are off/i)).toBeInTheDocument();
    expect(screen.getByText('--allow-agent')).toBeInTheDocument();
    expect(terminal).not.toHaveBeenCalled();
    expect(agentTicket).not.toHaveBeenCalled();
  });

  it('distinguishes "node-pty did not load" from "the flag is off"', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, available: 'no', sessions: [] });
    await openPage();

    expect(await screen.findByText(/no terminal available/i)).toBeInTheDocument();
    expect(screen.getByText('node-pty')).toBeInTheDocument();
    expect(screen.queryByText(/agent sessions are off/i)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The launcher
 * ------------------------------------------------------------------ */

describe('the launcher', () => {
  it('is the empty state, and visiting it spawns nothing', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage();

    expect(await screen.findByText(/new claude session/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start session/i })).toBeInTheDocument();
    // Under StrictMode a mount that minted would mint twice.
    expect(agentTicket).not.toHaveBeenCalled();
  });

  it('sends exactly the enum body it collected, and stays on the new session', async () => {
    const opened = { ...CLAUDE, id: 'a1', label: 'Claude: say hello' };
    let live: (typeof CLAUDE)[] = [];
    terminal.mockImplementation(async () => ({ ...TERMINALS, sessions: live }));
    agentTicket.mockImplementation(async () => {
      live = [...live, opened];
      return { ok: true, sessionId: 'a1', token: 't', expiresAt: 0, path: '/ws/terminal', session: opened };
    });

    await openLive('#/agent');
    fireEvent.change(await screen.findByPlaceholderText(/sent as your first message/i), {
      target: { value: 'say hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    await waitFor(() => expect(agentTicket).toHaveBeenCalledWith({
      model: 'opus', effort: 'max', permissionMode: '', prompt: 'say hello',
    }));
    await waitFor(() => expect(window.location.hash).toBe('#/agent/a1'));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('a1'));

    // ⚠️ The bounce regression: the mint invalidates the very list the
    // fallback effect reads; without the isFetching gate the page navigates
    // straight back off the session it just opened.
    await waitFor(() => expect(terminal).toHaveBeenCalledTimes(2));
    expect(window.location.hash).toBe('#/agent/a1');
    expect(screen.getByTestId('pane')).toHaveTextContent('a1');
  });

  it('hides the skills picker when no source directory is open', async () => {
    state.mockResolvedValue({ ...BASE_STATE, root: undefined });
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage();

    expect(await screen.findByText(/open a source directory to pick skills/i)).toBeInTheDocument();
    // `/api/skills` sits behind the open-root wall server-side — a disabled
    // picker must not turn into a 409 toast.
    expect(skills).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

describe('sessions', () => {
  it('shows only claude sessions, and attaches to the routed one', async () => {
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    expect(await screen.findByTestId('pane')).toHaveTextContent('c1');
    expect(pane).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Claude: hello')).toBeInTheDocument();
    expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument();
  });

  it('says which mode the open session was LAUNCHED in, both ways', async () => {
    // No mode on the record is the CLI's own default, which is an omission
    // rather than a value — the chip still has to name it.
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });
    expect(await screen.findByText(/launched in default/i)).toBeInTheDocument();

    const planned = { ...CLAUDE, meta: { ...CLAUDE.meta, permissionMode: 'plan' } };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [planned] });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });
    expect(await screen.findByText(/launched in plan/i)).toBeInTheDocument();
  });

  it('the mode chip admits it is a launch record, and offers the shortcut', async () => {
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    // The honesty is the point: ⇧Tab changes the mode inside the session and
    // tells nothing out here, so a label read as live would be wrong within a
    // keystroke.
    const chip = await screen.findByText(/launched in default/i);
    expect(chip).toHaveAttribute('title', expect.stringMatching(/does not update this label/i));
    expect(screen.getByText('⇧Tab')).toBeInTheDocument();
    expect(screen.getByText(/cycles permission modes/i)).toBeInTheDocument();
  });

  it('no session open, no launch record to report', async () => {
    await openPage();
    // The launcher, not a session — a chip here would be about nothing.
    expect(await screen.findByRole('button', { name: /start session/i })).toBeInTheDocument();
    expect(screen.queryByText(/launched in/i)).not.toBeInTheDocument();
  });

  it('counts the cap across BOTH kinds', async () => {
    const shells = Array.from({ length: 7 }, (_, i) => ({ ...SHELL, id: `s${i}` }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [CLAUDE, ...shells] });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    expect(await screen.findByRole('button', { name: /^new$/i })).toBeDisabled();
  });

  it('New goes to the launcher, never straight to a pty', async () => {
    await openLive('#/agent/c1');
    fireEvent.click(await screen.findByRole('button', { name: /^new$/i }));

    await waitFor(() => expect(window.location.hash).toBe('#/agent'));
    expect(agentTicket).not.toHaveBeenCalled();
  });

  it('an ended session offers resume, as a button and as a copyable command', async () => {
    const ended = { ...CLAUDE, exited: { code: 0 }, exitedAt: Date.now() - 60_000 };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [ended], live: 0 });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    // The record outlives the CLI now, so this is a state the page renders
    // rather than a moment it had ~30 seconds to catch.
    expect(await screen.findByText(/exited cleanly/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /resume here/i }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalledWith({
      resume: '00000000-0000-4000-8000-000000000000',
    }));
  });

  it('reports a failed session as failed, and offers to clear the record', async () => {
    const failed = { ...CLAUDE, exited: { code: 1, signal: 9 }, exitedAt: Date.now() - 1_000 };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [failed], live: 0 });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    // A signal is the case a bare exit code loses: killed by 9 with code 1 is
    // not "exited cleanly", and the panel must not say it was.
    expect(await screen.findByText(/killed by signal 9/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('says a session is gone instead of stranding a dead link', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage({ segments: ['agent', 'long-gone'], query: {}, path: 'agent/long-gone' });

    expect(await screen.findByText(/not here any more/i)).toBeInTheDocument();
    // The harness renders a route object without touching the URL, so any
    // `navigate()` shows up here as a hash — which is exactly how the old test
    // detected the bounce. Staying empty is the assertion that it is gone.
    await waitFor(() => expect(window.location.hash).toBe(''));
  });
});

/* ------------------------------------------------------------------ *
 * The plan wizard
 * ------------------------------------------------------------------ */

describe('the plan wizard', () => {
  it('gates on the agent capability, not on writes', async () => {
    const { NewPlanWizardButton } = await import('./wizard');
    const { container } = mount(<NewPlanWizardButton allowAgent={false} />);
    expect(container).toBeEmptyDOMElement();

    mount(<NewPlanWizardButton allowAgent />);
    expect(screen.getByRole('button', { name: /new plan with ai/i })).toBeInTheDocument();
  });

  it('sends the brief as a plan intent and lands on the session', async () => {
    const { NewPlanWizard } = await import('./wizard');
    const onClose = vi.fn();
    mount(<NewPlanWizard onClose={onClose} />);

    const start = await screen.findByRole('button', { name: /start authoring/i });
    // An empty brief cannot start a session that would have nothing to author.
    expect(start).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'Ship a cart API.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start authoring/i }));

    // NO `permissionMode` in the ticket: the omission is the choice. The
    // server defaults a plan intent to plan mode, and the select this form
    // used to offer was the one hole left in that rule — `auto` here launched
    // an authoring session that could write a plan nobody approved.
    await waitFor(() => expect(agentTicket).toHaveBeenCalledWith({
      intent: 'plan', brief: 'Ship a cart API.', model: 'opus', effort: 'max',
    }));
    await waitFor(() => expect(window.location.hash).toBe('#/agent/a1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('permissions are fixed to plan mode — shown, not selectable', async () => {
    const { NewPlanWizard } = await import('./wizard');
    mount(<NewPlanWizard onClose={() => {}} />);

    // The fact is stated where the select used to be…
    expect(await screen.findByText(/plan mode — fixed for authoring/i)).toBeInTheDocument();
    // …and there is genuinely nothing to change: no permissions control exists.
    expect(screen.queryByLabelText(/permissions/i)).toBeNull();
  });

  it('needs an open source directory before it can author anywhere', async () => {
    state.mockResolvedValue({ ...BASE_STATE, root: undefined });
    const { NewPlanWizard } = await import('./wizard');
    mount(<NewPlanWizard onClose={() => {}} />);

    expect(await screen.findByText(/open a source directory first/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'Ship it.' },
    });
    expect(screen.getByRole('button', { name: /start authoring/i })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ *
 * The plan-created banner
 * ------------------------------------------------------------------ */

describe('the plan-created banner', () => {
  it('appears when a NEW slug enters the plans list, and links to it', async () => {
    const planning = {
      ...CLAUDE,
      meta: { ...CLAUDE.meta, intent: 'plan' as const },
    };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [planning] });
    plansApi.mockResolvedValue([{ slug: 'existing', phases: 1, ready: [] }]);

    const client = new QueryClient(queryClientConfig);
    const { default: AgentView } = await import('./index');
    render(
      <QueryClientProvider client={client}>
        <AgentView route={{ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' }} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('pane');
    // The baseline must exist before the "new" list arrives — flipping the
    // mock while the FIRST fetch is still in flight lets the query cache
    // dedupe the refetch and the diff never sees a second list.
    await waitFor(() => expect(client.getQueryData(['plans'])).toBeTruthy());
    expect(screen.queryByText(/was created/i)).not.toBeInTheDocument();

    // `new-plan.sh` writes the file → watcher emits `changed` → EVENT_EFFECTS
    // invalidates keys.plans() → the refetch is what the watcher diffs.
    plansApi.mockResolvedValue([
      { slug: 'existing', phases: 1, ready: [] },
      { slug: 'cart-api-endpoint', phases: 4, ready: [] },
    ]);
    await client.invalidateQueries({ queryKey: ['plans'] });
    await waitFor(() => expect(plansApi).toHaveBeenCalledTimes(2));

    expect(await screen.findByText(/was created/i)).toBeInTheDocument();
    expect(screen.getByText('cart-api-endpoint')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open it/i });
    expect(link).toHaveAttribute('href', '#/plan/cart-api-endpoint/route');

    // Dismiss is a choice, not a timeout.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/was created/i)).not.toBeInTheDocument();
  });

  it('does not watch plain claude sessions', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [CLAUDE] });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });
    await screen.findByTestId('pane');
    expect(plansApi).not.toHaveBeenCalled();
  });
});
