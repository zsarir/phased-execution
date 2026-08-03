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
 * - **The key bar sends real byte sequences** and does not steal focus.
 * - **The nav entry is gated but the route is not** — a deep link from a phone
 *   must explain itself, not resolve to the dashboard.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { visibleNav } from '@/shell/nav';
import type { ConsoleState, TerminalState } from '@/lib/api';
import { applyCtrl, KeyBar } from './keybar';

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
vi.mock('./pane', () => ({
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

  it('falls back instead of stranding a link to a session that has ended', async () => {
    await openPage({ segments: ['terminal', 'long-gone'], query: {}, path: 'terminal/long-gone' });
    // The common case is a phone that slept past the idle timeout; the useful
    // answer is the shell that IS open, not an error.
    await waitFor(() => expect(window.location.hash).toBe('#/terminal/abc123'));
  });

  it('refuses to go past the session cap', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...SESSION, id: `s${i}`, label: `Terminal ${i}` }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: many });
    await openPage({ segments: ['terminal', 's0'], query: {}, path: 'terminal/s0' });

    const button = await screen.findByRole('button', { name: /new/i });
    expect(button).toBeDisabled();
  });

  it('closes a session and moves off it', async () => {
    await openPage({ segments: ['terminal', 'abc123'], query: {}, path: 'terminal/abc123' });
    fireEvent.click(await screen.findByRole('button', { name: /close terminal 1/i }));
    await waitFor(() => expect(terminalClose).toHaveBeenCalledWith('abc123'));
    await waitFor(() => expect(window.location.hash).toBe('#/terminal'));
  });
});

/* ------------------------------------------------------------------ *
 * The key bar
 * ------------------------------------------------------------------ */

describe('the key bar', () => {
  it('sends the sequences a shell actually expects', async () => {
    const sent: string[] = [];
    render(<KeyBar onSend={(d) => sent.push(d)} ctrl={false} onCtrl={() => {}} onPaste={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /escape/i }));
    fireEvent.click(screen.getByRole('button', { name: /^tab/i }));
    fireEvent.click(screen.getByRole('button', { name: /interrupt/i }));
    fireEvent.click(screen.getByRole('button', { name: /up — previous command/i }));

    expect(sent).toEqual(['\x1b', '\t', '\x03', '\x1b[A']);
  });

  it('holds focus rather than dismissing the keyboard', () => {
    render(<KeyBar onSend={() => {}} ctrl={false} onCtrl={() => {}} onPaste={() => {}} />);
    const escape = screen.getByRole('button', { name: /escape/i });
    // A key that blurred the terminal would arrive at nothing.
    const prevented = !fireEvent.mouseDown(escape);
    expect(prevented).toBe(true);
  });

  it('registers touchstart natively, because React\'s root listener is passive', () => {
    // ⚠️ The whole reason this is asserted: `preventDefault()` inside an
    // `onTouchStart` prop does nothing but log — React attaches wheel/touch* to
    // its root as passive. Same trap as `useMapView` in components/dag.tsx.
    const listeners: { on: HTMLElement; type: string; options: unknown }[] = [];
    const original = HTMLDivElement.prototype.addEventListener;
    HTMLDivElement.prototype.addEventListener = function patched(
      this: HTMLElement, type: string, fn: never, options: never,
    ) {
      listeners.push({ on: this, type, options });
      return original.call(this, type, fn, options);
    } as typeof original;

    try {
      render(<KeyBar onSend={() => {}} ctrl={false} onCtrl={() => {}} onPaste={() => {}} />);
    } finally {
      HTMLDivElement.prototype.addEventListener = original;
    }

    // Filtered to the bar itself: React attaches its own passive `touchstart`
    // to the render container, which is a div too — and mistaking that one for
    // ours is exactly the confusion this test exists to prevent.
    const touch = listeners.find(
      (l) => l.type === 'touchstart' && l.on.getAttribute?.('role') === 'toolbar',
    );
    expect(touch, 'the key bar must attach touchstart itself').toBeTruthy();
    expect(touch?.options).toMatchObject({ passive: false });
  });

  it('shows Ctrl as armed so a sticky modifier is not invisible', () => {
    const { rerender } = render(
      <KeyBar onSend={() => {}} ctrl={false} onCtrl={() => {}} onPaste={() => {}} />,
    );
    // Exact: `/ctrl/i` also matches the `^C` key, whose label is "Interrupt (Ctrl-C)".
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<KeyBar onSend={() => {}} ctrl onCtrl={() => {}} onPaste={() => {}} />);
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('applyCtrl', () => {
  it('maps a letter to its control code', () => {
    expect(applyCtrl('c')).toBe('\x03');
    expect(applyCtrl('C')).toBe('\x03');
    expect(applyCtrl('d')).toBe('\x04');
    expect(applyCtrl('z')).toBe('\x1a');
  });

  it('passes an escape sequence through untouched', () => {
    // An arrow key arrives as three bytes. Transforming it would break the very
    // keys the bar exists to provide.
    expect(applyCtrl('\x1b[A')).toBe(null);
    expect(applyCtrl('')).toBe(null);
    expect(applyCtrl('1')).toBe(null);
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

  it('hides nothing else', () => {
    expect(visibleNav({ ...BASE_STATE, allowTerminal: false }).map((i) => i.id)).toEqual([
      'dashboard', 'ready', 'plans', 'runs', 'notifications', 'stats', 'search', 'guide', 'settings',
    ]);
  });
});
