/**
 * The Terminal page.
 *
 * xterm is mocked out wholesale. It measures a real font in a real layout
 * engine, which jsdom does not have — and none of what is worth asserting here
 * is xterm's behaviour anyway. What is worth asserting is the part that is
 * *ours* and invisible until it is wrong:
 *
 * - **Both ways the terminal can be absent say which one it is.** "Restart with
 *   `--allow-terminal`" and "`node-pty` did not load" are different problems
 *   with different fixes, and a page that showed one message for both would
 *   send someone to the wrong one.
 * - **No shell opens as a side effect of navigating.** Under StrictMode a mount
 *   that spawned a pty would spawn two.
 * - **The strip is a tab list**, and the composer sends a line with its Enter
 *   (the key bar has its own file: `keybar.test.tsx`).
 * - **The nav entry is gated but the route is not** — a deep link from a phone
 *   must explain itself, not resolve to the dashboard.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { visibleNav } from '@/shell/nav';
import type { ConsoleState, TerminalState } from '@/lib/api';
import { Composer } from './composer';

/* ------------------------------------------------------------------ *
 * Mocks
 * ------------------------------------------------------------------ */

// `vi.hoisted`: a `vi.mock` factory runs above every top-level `const` in the
// file, so anything it closes over has to be created here or it is in its
// temporal dead zone when the factory fires.
const { state, terminal, terminalTicket, terminalClose, pane } = vi.hoisted(() => ({
  state: vi.fn(),
  terminal: vi.fn(),
  terminalTicket: vi.fn(),
  terminalClose: vi.fn(),
  pane: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state, terminal, terminalTicket, terminalClose,
      plans: vi.fn(async () => []),
      approvals: vi.fn(async () => []),
    },
  };
});

// The pane owns xterm and a live WebSocket. Both are the wrong thing to build
// in jsdom, and neither is what this file is about.
// Only the emulator is stubbed. The ended/gone panels are re-exported from
// `pane` (see the note there — it keeps the shared chunk to one facade), and
// they are under test here, so they come through for real from `./ended`, which
// pulls in no xterm.
vi.mock('./pane', async () => ({
  ...(await import('./ended')),
  // The real one — it renders from the session record alone here (no plan
  // linkage on a shell), and its own behaviour has its own test file.
  ...(await import('./vitals')),
  // Also real, for the same reason — and re-exported through the pane facade
  // in production, so the mock must carry it too.
  ...(await import('../agent/session-controls')),
  // The strip and its hints, likewise real: the tab list is under test here.
  ...(await import('./strip')),
  TerminalPane: (props: { sessionId: string }) => {
    pane(props.sessionId);
    return <div data-testid="pane">{props.sessionId}</div>;
  },
}));

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  allowTerminal: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  recentRoots: [],
  unread: 0,
};

const SESSION = {
  id: 'abc123', label: 'Terminal 1', cwd: '/repo', shell: '/bin/zsh',
  cols: 100, rows: 30, pid: 900, clients: 1, createdAt: 0,
};

const TERMINALS: TerminalState = { allowed: true, available: 'yes', limit: 8, sessions: [SESSION] };

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function openPage(route = { segments: ['terminal'], query: {}, path: 'terminal' }) {
  const { default: TerminalView } = await import('./index');
  return mount(<TerminalView route={route} />);
}

/**
 * The same page, but reading the route from the hash the way `App` does.
 *
 * `openPage` hands the view a frozen `route` prop, which is fine for the states
 * that do not navigate — but useless for asserting what the page does *after*
 * it changes the URL, because the prop never follows.
 */
async function openLive(hash: string) {
  window.location.hash = hash;
  const { default: TerminalView } = await import('./index');
  const { useRoute } = await import('@/router');
  const Harness = () => <TerminalView route={useRoute()} />;
  return mount(<Harness />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  state.mockResolvedValue(BASE_STATE);
  terminal.mockResolvedValue(TERMINALS);
  terminalTicket.mockResolvedValue({
    ok: true, sessionId: 'new1', token: 't', expiresAt: 0, path: '/ws/terminal',
    session: { ...SESSION, id: 'new1', label: 'Terminal 2' },
  });
  terminalClose.mockResolvedValue({ closed: true, state: { ...TERMINALS, sessions: [] } });
});

/* ------------------------------------------------------------------ *
 * The two ways there is no terminal
 * ------------------------------------------------------------------ */

describe('when there is no terminal', () => {
  it('says the flag is off, and names the flag', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowTerminal: false });
    await openPage();

    expect(await screen.findByText(/terminal is off/i)).toBeInTheDocument();
    expect(screen.getByText('--allow-terminal')).toBeInTheDocument();
    // Nothing is asked of a server that has said no.
    expect(terminal).not.toHaveBeenCalled();
    expect(terminalTicket).not.toHaveBeenCalled();
  });

  it('distinguishes "node-pty did not load" from "the flag is off"', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, available: 'no', sessions: [] });
    await openPage();

    expect(await screen.findByText(/no shell available/i)).toBeInTheDocument();
    expect(screen.getByText('node-pty')).toBeInTheDocument();
    // The distinction is the point: the same words for both would send someone
    // to restart with a flag they already have.
    expect(screen.queryByText(/terminal is off/i)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

describe('sessions', () => {
  it('does not open a shell just because the page was visited', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage();

    expect(await screen.findByText(/no shell open/i)).toBeInTheDocument();
    // Under StrictMode a mount that spawned a pty would spawn two.
    expect(terminalTicket).not.toHaveBeenCalled();
  });

  it('opens one when asked, and stays on it', async () => {
    // A stateful stand-in for the server: creating a session has to show up in
    // the next listing, or this test cannot see the bug it exists for.
    const opened = { ...SESSION, id: 'new1', label: 'Terminal 2' };
    let live: typeof SESSION[] = [];
    terminal.mockImplementation(async () => ({ ...TERMINALS, sessions: live }));
    terminalTicket.mockImplementation(async () => {
      live = [...live, opened];
      return { ok: true, sessionId: 'new1', token: 't', expiresAt: 0, path: '/ws/terminal', session: opened };
    });

    await openLive('#/terminal');
    fireEvent.click(await screen.findByRole('button', { name: /open a shell/i }));

    // The URL is what makes a reload — or a phone killing the tab — come back
    // to the same shell rather than a new one.
    await waitFor(() => expect(window.location.hash).toBe('#/terminal/new1'));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));

    // ⚠️ The regression this guards: the click invalidates the very list the
    // fallback reads, so a fallback that ran mid-refetch decided the new
    // session did not exist and navigated straight back off it. The symptom
    // was a tab that appeared and a terminal that never did.
    await waitFor(() => expect(terminal).toHaveBeenCalledTimes(2));
    expect(window.location.hash).toBe('#/terminal/new1');
    expect(screen.getByTestId('pane')).toHaveTextContent('new1');
  });

  it('attaches to the session the route names', async () => {
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });
    expect(await screen.findByTestId('pane')).toHaveTextContent('abc123');
    expect(pane).toHaveBeenCalledWith('abc123');
  });

  it('says a session is gone instead of bouncing off its own URL', async () => {
    await openPage({ segments: ['terminal', 'long-gone'], query: {}, path: 'terminal/long-gone' });
    // This used to navigate away silently, which was defensible while sessions
    // timed out on their own. They do not any more: a URL naming nothing means
    // the record was dismissed or retired, and on a phone a redirect reads as a
    // tap that did nothing.
    expect(await screen.findByText(/not here any more/i)).toBeInTheDocument();
    // The harness renders a route object without touching the URL, so a stray
    // `navigate()` would show up here as a hash. Staying empty is the assertion.
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('keeps an ended shell open, with its scrollback and a way to clear it', async () => {
    const ended = { ...SESSION, exited: { code: 130 }, exitedAt: Date.now() - 5_000 };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [ended], live: 0 });
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });

    // The record outlives the process, so the page reports the exit rather than
    // sending you somewhere else.
    expect(await screen.findByText(/exited with code 130/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    // …and its slot is free, so New is still offered.
    expect(screen.getByRole('button', { name: /new/i })).not.toBeDisabled();
  });

  it('refuses to go past the session cap', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...SESSION, id: `s${i}`, label: `Terminal ${i}` }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: many });
    await openPage({ segments: ['terminal', 's0'], query: {}, path: 'terminal/s0' });

    const button = await screen.findByRole('button', { name: /new/i });
    expect(button).toBeDisabled();
  });

  it('shows shells only — claude sessions live on the agent page', async () => {
    const claude = {
      ...SESSION, id: 'c1', label: 'Claude: hello', kind: 'claude' as const, shell: 'claude',
    };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, claude] });
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(screen.queryByText('Claude: hello')).not.toBeInTheDocument();
  });

  it('counts the cap across BOTH kinds, not just the tabs it shows', async () => {
    // Seven claude sessions and one shell: one visible tab, but the registry
    // is full — a New button that read only its own tabs would offer a shell
    // the server must refuse.
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...SESSION, id: `c${i}`, label: `Claude ${i}`, kind: 'claude' as const,
    }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, ...many] });
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });

    expect(await screen.findByRole('button', { name: /new/i })).toBeDisabled();
  });

  it('closes a session and moves off it', async () => {
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });
    fireEvent.click(await screen.findByRole('button', { name: /close terminal 1/i }));
    await waitFor(() => expect(terminalClose).toHaveBeenCalledWith('abc123'));
    await waitFor(() => expect(window.location.hash).toBe('#/terminal'));
  });
});

/* ------------------------------------------------------------------ *
 * The strip and the composer
 * ------------------------------------------------------------------ */

describe('the strip', () => {
  it('is a tab list — Radix owns the roving focus, ui/tabs the scroll-into-view', async () => {
    const second = { ...SESSION, id: 'def456', label: 'Terminal 2' };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, second] });
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });

    const list = await screen.findByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(tabs[0]).toHaveAttribute('data-state', 'active');
    // Every tab is thumb-sized, and the strip is the ui/tabs strip (hidden
    // scrollbar, fade) — not a hand-rolled overflow row.
    for (const tab of tabs) expect(tab.className).toMatch(/min-h-\(--tap-min\)/);
    expect(list.className).toMatch(/scrollbar-width:none/);
  });

  it('switching tabs navigates to the session', async () => {
    const second = { ...SESSION, id: 'def456', label: 'Terminal 2' };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, second] });
    await openLive('#/terminal/abc123');
    await screen.findByRole('tablist');
    // Radix activates on mousedown (automatic activation), then click follows.
    const tab = screen.getByRole('tab', { name: 'Terminal 2' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(window.location.hash).toBe('#/terminal/def456'));
  });
});

describe('the composer', () => {
  it('sends the line WITH its Enter — text + \\r — and clears for the next one', () => {
    const sent: string[] = [];
    render(<Composer onSend={(data) => sent.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    // A command line, not prose: nothing may rewrite it on the way in.
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('enterkeyhint', 'send');

    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: 'run the tests' } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(sent).toEqual(['run the tests\r']);
    expect(input).toHaveValue('');
  });

  it('Enter in the field submits, and a blank line sends nothing', () => {
    const sent: string[] = [];
    render(<Composer onSend={(data) => sent.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(sent).toEqual([]);
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.submit(input.closest('form')!);
    expect(sent).toEqual(['y\r']);
  });
});

/* ------------------------------------------------------------------ *
 * The nav gate
 * ------------------------------------------------------------------ */

describe('the nav entry', () => {
  it('appears only where the server has a terminal', () => {
    const ids = (state?: ConsoleState) => visibleNav(state).map((item) => item.id);
    expect(ids({ ...BASE_STATE, allowTerminal: true })).toContain('terminal');
    expect(ids({ ...BASE_STATE, allowTerminal: false })).not.toContain('terminal');
    // An older server does not report the field at all; absent is off.
    expect(ids({ ...BASE_STATE, allowTerminal: undefined })).not.toContain('terminal');
    expect(ids(undefined)).not.toContain('terminal');
  });

  it('gates the agent entry on its own capability, independently', () => {
    const ids = (state?: ConsoleState) => visibleNav(state).map((item) => item.id);
    expect(ids({ ...BASE_STATE, allowAgent: true })).toContain('agent');
    expect(ids({ ...BASE_STATE, allowAgent: false })).not.toContain('agent');
    expect(ids({ ...BASE_STATE, allowAgent: undefined })).not.toContain('agent');
    // Each flag opens only its own door.
    expect(ids({ ...BASE_STATE, allowTerminal: false, allowAgent: true })).toEqual(
      expect.arrayContaining(['agent']),
    );
    expect(ids({ ...BASE_STATE, allowTerminal: false, allowAgent: true })).not.toContain('terminal');
    expect(ids({ ...BASE_STATE, allowTerminal: true, allowAgent: false })).not.toContain('agent');
  });

  it('hides nothing else', () => {
    expect(visibleNav({ ...BASE_STATE, allowTerminal: false }).map((i) => i.id)).toEqual([
      'dashboard', 'ready', 'plans', 'runs', 'pulse', 'notifications', 'stats', 'search', 'mcp',
      'guide', 'settings',
    ]);
    // With both capabilities on, the two gated entries appear in NAV order —
    // Agent, then Terminal — and everything else stays put.
    expect(visibleNav({ ...BASE_STATE, allowTerminal: true, allowAgent: true }).map((i) => i.id)).toEqual([
      'dashboard', 'ready', 'plans', 'runs', 'pulse', 'notifications', 'stats', 'search',
      'agent', 'terminal', 'mcp', 'guide', 'settings',
    ]);
  });
});
