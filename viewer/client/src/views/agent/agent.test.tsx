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

const { state, terminal, agentTicket, terminalClose, skills, pane } = vi.hoisted(() => ({
  state: vi.fn(),
  terminal: vi.fn(),
  agentTicket: vi.fn(),
  terminalClose: vi.fn(),
  skills: vi.fn(),
  pane: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state, terminal, agentTicket, terminalClose, skills,
      plans: vi.fn(async () => []),
      approvals: vi.fn(async () => []),
    },
  };
});

vi.mock('../terminal/pane', () => ({
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
    const ended = { ...CLAUDE, exited: { code: 0 } };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [ended] });
    await openPage({ segments: ['agent', 'c1'], query: {}, path: 'agent/c1' });

    expect(await screen.findByText(/its conversation is resumable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /resume here/i }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalledWith({
      resume: '00000000-0000-4000-8000-000000000000',
    }));
  });

  it('falls back to the launcher instead of stranding a dead link', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage({ segments: ['agent', 'long-gone'], query: {}, path: 'agent/long-gone' });

    await waitFor(() => expect(window.location.hash).toBe('#/agent'));
  });
});
