/**
 * The sessions card, and the off switch.
 *
 * Both are new surfaces for the same fact: a session now outlives the tab that
 * opened it, so something has to list what is alive and something has to be able
 * to stop it. The properties worth holding:
 *
 * - **Both kinds, one list.** The registry is shared; two pages each showing
 *   half of it is how a shell opened on a phone stayed invisible from a laptop.
 * - **Ended rows survive, and say what they are.** An agent session's resume id
 *   is the most valuable thing it leaves behind.
 * - **Close and dismiss are different verbs.** Killing a working session because
 *   its row sat in the wrong column is the worst outcome available here, so the
 *   live rows confirm and the dead rows do not.
 * - **The shutdown dialog is an inventory.** "Are you sure?" is not a question
 *   anyone can answer; "this stops 2 agent sessions and the alpha run" is.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { __resetShutdownForTests, getConsoleStopped } from '@/lib/shutdown';

const { terminal, terminalClose, sessionDismiss, shutdownReadiness, shutdown } = vi.hoisted(() => ({
  terminal: vi.fn(),
  terminalClose: vi.fn(),
  sessionDismiss: vi.fn(),
  shutdownReadiness: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, terminal, terminalClose, sessionDismiss, shutdownReadiness, shutdown },
  };
});

const { SessionsCard } = await import('./sessions');
const { ShutdownButton, stopList } = await import('../settings/shutdown');

const SHELL = {
  id: 's1',
  label: 'Terminal 1',
  kind: 'shell' as const,
  cwd: '/hub',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 100,
  clients: 1,
  createdAt: Date.now() - 60_000,
  lastOutputAt: Date.now(),
};

const CLAUDE = {
  ...SHELL,
  id: 'c1',
  label: 'Claude 1',
  kind: 'claude' as const,
  shell: 'claude',
  clients: 0,
  meta: { claudeSessionId: '00000000-0000-4000-8000-000000000000' },
};

const STATE = { allowTerminal: true, allowAgent: true };

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetShutdownForTests();
  terminal.mockResolvedValue({
    allowed: true,
    agentAllowed: true,
    available: 'yes',
    limit: 8,
    live: 2,
    sessions: [SHELL, CLAUDE],
  });
});

describe('the sessions card', () => {
  it('lists both kinds, live and ended, with what each is doing', async () => {
    const ended = {
      ...CLAUDE,
      id: 'c2',
      label: 'Claude 2',
      exited: { code: 1 },
      exitedAt: Date.now() - 5_000,
    };
    terminal.mockResolvedValue({
      allowed: true,
      agentAllowed: true,
      available: 'yes',
      limit: 8,
      live: 2,
      sessions: [SHELL, CLAUDE, ended],
    });
    mount(<SessionsCard state={STATE} />);

    // One registry, one list — this is what nothing on the console showed.
    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(screen.getByText('Claude 1')).toBeInTheDocument();
    expect(screen.getByText('Claude 2')).toBeInTheDocument();

    expect(screen.getByText('1 attached')).toBeInTheDocument();
    // The state that used to be indistinguishable from "gone".
    expect(screen.getByText('running, detached')).toBeInTheDocument();
    expect(screen.getByText('ended just now')).toBeInTheDocument();
    expect(screen.getByText('exit 1')).toBeInTheDocument();
    expect(screen.getByText(/2 running of 8/)).toBeInTheDocument();
  });

  it('renders nothing at all when there are no sessions', async () => {
    terminal.mockResolvedValue({ allowed: true, available: 'yes', limit: 8, live: 0, sessions: [] });
    const { container } = mount(<SessionsCard state={STATE} />);
    // A permanently empty card on every console that never opens a shell is
    // noise on the busiest page.
    await waitFor(() => expect(terminal).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('confirms before killing a live session, and dismisses a dead one outright', async () => {
    const ended = { ...SHELL, id: 's2', label: 'Terminal 2', exited: { code: 0 }, exitedAt: Date.now() };
    terminal.mockResolvedValue({
      allowed: true,
      agentAllowed: true,
      available: 'yes',
      limit: 8,
      live: 1,
      sessions: [SHELL, ended],
    });
    sessionDismiss.mockResolvedValue({
      ok: true,
      state: { allowed: true, available: 'yes', limit: 8, live: 1, sessions: [SHELL] },
    });
    mount(<SessionsCard state={STATE} />);

    // Dismiss is a list-tidying verb on a process that is already gone: no
    // dialog, and it never touches a live session.
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(sessionDismiss).toHaveBeenCalledWith('s2'));
    expect(terminalClose).not.toHaveBeenCalled();

    // Killing a working session is the irreversible one, so it asks.
    fireEvent.click(screen.getByRole('button', { name: /close terminal 1/i }));
    expect(await screen.findByText(/Close Terminal 1\?/)).toBeInTheDocument();
    expect(terminalClose).not.toHaveBeenCalled();
  });
});

describe('the off switch', () => {
  const READINESS = {
    supervisor: { kind: 'launchd', detail: 'launchd · com.example · KeepAlive is on' },
    stop: {
      via: 'launchctl' as const,
      label: 'com.example',
      detail: 'launchd · the job is unloaded, so it stays off',
    },
    busy: true,
    run: { slug: 'alpha', status: 'running' },
    sessions: { live: 3, agent: 2, terminal: 1, ended: 1, sessions: [] },
    restartHint: 'launchctl kickstart -k gui/$(id -u)/com.example',
  };

  it('names what it will stop, rather than asking if you are sure', async () => {
    shutdownReadiness.mockResolvedValue(READINESS);
    mount(<ShutdownButton />);

    fireEvent.click(await screen.findByRole('button', { name: /shut down/i }));

    expect(await screen.findByText(/2 agent sessions/)).toBeInTheDocument();
    expect(screen.getByText(/1 terminal/)).toBeInTheDocument();
    // A run is stopped too — checkpointed, not abandoned, and it says which.
    expect(screen.getByText(/alpha run \(running\)/)).toBeInTheDocument();
    expect(screen.getByText(/checkpointed first/)).toBeInTheDocument();
    // The way back, while there is still a page to read it on.
    expect(screen.getByText(/launchctl kickstart/)).toBeInTheDocument();
  });

  it('records that the console was stopped on purpose, so the shell stops promising a reconnect', async () => {
    shutdownReadiness.mockResolvedValue(READINESS);
    shutdown.mockResolvedValue({ ok: true });
    mount(<ShutdownButton />);

    fireEvent.click(await screen.findByRole('button', { name: /shut down/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^shut down$/i }));

    await waitFor(() => expect(shutdown).toHaveBeenCalled());
    // The one moment this is knowable: a dead stream afterwards looks exactly
    // like a restart, a sleep or a dropped wifi.
    await waitFor(() =>
      expect(getConsoleStopped()).toEqual({
        hint: 'launchctl kickstart -k gui/$(id -u)/com.example',
        via: 'launchctl',
      }),
    );
  });

  it('says plainly when there is nothing to stop', async () => {
    shutdownReadiness.mockResolvedValue({
      ...READINESS,
      busy: false,
      run: null,
      sessions: { live: 0, agent: 0, terminal: 0, ended: 0, sessions: [] },
    });
    mount(<ShutdownButton />);
    fireEvent.click(await screen.findByRole('button', { name: /shut down/i }));
    expect(await screen.findByText(/Nothing is running/)).toBeInTheDocument();
  });

  it('builds the same list for restart, which has always killed sessions silently', () => {
    expect(stopList({ live: 1, agent: 0, terminal: 1, ended: 0, sessions: [] }, null)).toEqual([
      '1 terminal',
    ]);
    expect(stopList(undefined, undefined)).toEqual([]);
    // Ended records are history, not something a shutdown stops.
    expect(stopList({ live: 0, agent: 0, terminal: 0, ended: 4, sessions: [] }, null)).toEqual([]);
  });
});
