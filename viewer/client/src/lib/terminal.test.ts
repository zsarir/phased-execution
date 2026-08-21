/**
 * The link's contracts, against a fake socket and a fake clock.
 *
 *  - **Size.** The mint carries the size; the LAST size requested before the
 *    socket opened is flushed exactly once on `open`; wire resizes are one
 *    per ~150 ms, trailing edge, and the settled size is reported from there.
 *  - **Staying connected.** A dropped socket comes back on 1 s / 2 s / 5 s; a
 *    tab returning to the foreground retries at once; a refusal the console
 *    meant is permanent; a pong-capable server that goes silent is a dead
 *    socket, a server that never answers is not.
 *  - **Teardown.** A link disposed mid-mint leaves no socket behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { terminalTicket } = vi.hoisted(() => ({ terminalTicket: vi.fn() }));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, terminalTicket } };
});

import { ApiError } from './api';
import {
  RECONNECT_BACKOFF_MS,
  TerminalLink,
  estimateTerminalSize,
  type LinkHandlers,
  type LinkStatus,
} from './terminal';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closedWith: [number?, string?] | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Our side closing — the browser fires `close` later, by itself. */
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = [code, reason];
  }
  /* ---- the test's hands ---- */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
  resizes() {
    return this.frames().filter((f) => f.t === 'r');
  }
}

const SESSION = {
  id: 's1',
  label: 'Terminal 1',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 1,
  clients: 1,
  createdAt: 0,
};
const TICKET = {
  ok: true,
  sessionId: 's1',
  token: 't',
  expiresAt: 0,
  path: '/ws/terminal',
  session: SESSION,
};

function harness(overrides: Partial<LinkHandlers> = {}) {
  const statuses: [LinkStatus, string | undefined][] = [];
  const sizes: { cols: number; rows: number }[] = [];
  const sessions: { reattach: boolean }[] = [];
  const handlers: LinkHandlers = {
    onData: vi.fn(),
    onStatus: (status, detail) => {
      statuses.push([status, detail]);
    },
    onSession: (_session, info) => {
      sessions.push(info);
    },
    onExit: vi.fn(),
    onSize: (size) => {
      sizes.push(size);
    },
    ...overrides,
  };
  return { handlers, statuses, sizes, sessions };
}

const socket = (n = 0) => FakeSocket.instances[n];
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const flush = () => vi.advanceTimersByTimeAsync(0);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  terminalTicket.mockReset();
  terminalTicket.mockResolvedValue(TICKET);
});

afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('size', () => {
  it('mints with the size it was given, then flushes exactly one {t:"r"} on open carrying the LAST requested size', async () => {
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    expect(terminalTicket).toHaveBeenCalledWith({ sessionId: 's1', cols: 80, rows: 24 });

    // The browser fitted twice while the socket was still opening.
    link.resize(100, 40);
    link.resize(120, 50);
    expect(socket().resizes()).toEqual([]);

    socket().open();
    expect(socket().resizes()).toEqual([{ t: 'r', cols: 120, rows: 50 }]);
    // The debounce that was pending does not send the same size again.
    await vi.advanceTimersByTimeAsync(200);
    expect(socket().resizes()).toEqual([{ t: 'r', cols: 120, rows: 50 }]);
    link.dispose();
  });

  it('debounces wire resizes to one per ~150 ms, trailing edge, and reports the settled size once', async () => {
    const { handlers, sizes } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket().open();
    const before = socket().resizes().length;

    // A keyboard animation: a dozen fits in ~120 ms.
    for (let i = 1; i <= 12; i += 1) {
      link.resize(80, 24 + i);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(socket().resizes().length).toBe(before);
    await vi.advanceTimersByTimeAsync(150);
    expect(socket().resizes().slice(before)).toEqual([{ t: 'r', cols: 80, rows: 36 }]);
    expect(sizes).toEqual([{ cols: 80, rows: 36 }]);
    link.dispose();
  });

  it('an unopened socket gets the size the moment it opens, even after a reconnect', async () => {
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    link.resize(132, 44);
    await vi.advanceTimersByTimeAsync(200);
    socket(0).drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[0]);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    socket(1).open();
    expect(socket(1).resizes()).toEqual([{ t: 'r', cols: 132, rows: 44 }]);
    link.dispose();
  });
});

describe('staying connected', () => {
  it('a socket that closes under it reconnects on 1 s, 2 s, then 5 s, and says which attempt', async () => {
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    expect(statuses.at(-1)).toEqual(['live', undefined]);

    socket(0).drop();
    expect(statuses.slice(-2)).toEqual([
      ['closed', undefined],
      ['reconnecting', '1'],
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(terminalTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);

    last().drop();
    expect(statuses.at(-1)).toEqual(['reconnecting', '2']);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(3);

    last().drop();
    expect(statuses.at(-1)).toEqual(['reconnecting', '3']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(terminalTicket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(4);

    // Once it is back, the counter is forgotten: the next drop is attempt 1.
    last().open();
    expect(statuses.at(-1)).toEqual(['live', undefined]);
    last().drop();
    expect(statuses.at(-1)).toEqual(['reconnecting', '1']);
    link.dispose();
  });

  it('a reattach says so, so the pane can reset before the replay', async () => {
    const { handlers, sessions } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    socket(0).receive(JSON.stringify({ t: 'hello', session: SESSION }));
    socket(0).drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    socket(1).open();
    socket(1).receive(JSON.stringify({ t: 'hello', session: SESSION }));
    expect(sessions).toEqual([{ reattach: false }, { reattach: true }]);
    link.dispose();
  });

  it('a tab coming back to the foreground on a closed link reconnects at once, from the top of the backoff', async () => {
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();

    setVisibility('hidden');
    socket(0).drop();
    // Hidden: the scheduled retry defers itself rather than burning attempts.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminalTicket).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    // …and no stale timer fires a third attempt behind it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    link.dispose();
  });

  it('the network returning reconnects a closed link', async () => {
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    socket(0).drop();
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    link.dispose();
  });

  it('a refusal the console meant is permanent: error, and no retry', async () => {
    terminalTicket.mockRejectedValueOnce(new ApiError('no such session', 404, '/api/terminal'));
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    expect(statuses.at(-1)).toEqual(['error', 'no such session']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(terminalTicket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(0);
    link.dispose();
  });

  it('a transport failure at the mint retries with the same backoff', async () => {
    terminalTicket.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    expect(statuses.at(-1)).toEqual(['reconnecting', '1']);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(1);
    link.dispose();
  });

  it('after the session exits, a closing socket is left closed', async () => {
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    socket(0).receive(JSON.stringify({ t: 'exit', code: 0 }));
    socket(0).drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminalTicket).toHaveBeenCalledTimes(1);
    link.dispose();
  });
});

describe('the heartbeat', () => {
  it('pings every 30 s while live; a pong-capable server that goes silent is a dead socket', async () => {
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      socket(0)
        .frames()
        .filter((f) => f.t === 'ping'),
    ).toHaveLength(1);
    socket(0).receive(JSON.stringify({ t: 'pong' }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      socket(0)
        .frames()
        .filter((f) => f.t === 'ping'),
    ).toHaveLength(2);
    // No answer this time. Ten seconds later the socket is declared dead —
    // closed with a reason, the pane told why, a reconnect scheduled.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(statuses.at(-1)).toEqual(['live', undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket(0).closedWith).toEqual([4000, 'no heartbeat']);
    expect(statuses.slice(-2)).toEqual([
      ['closed', 'no heartbeat'],
      ['reconnecting', '1'],
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    link.dispose();
  });

  it('a server that never answers is not punished for silence', async () => {
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(
      socket(0)
        .frames()
        .filter((f) => f.t === 'ping').length,
    ).toBeGreaterThanOrEqual(3);
    expect(statuses.at(-1)).toEqual(['live', undefined]);
    expect(FakeSocket.instances).toHaveLength(1);
    link.dispose();
  });

  it('a tab back from a long background reattaches when the server cannot pong, and asks first when it can', async () => {
    // Cannot pong: a socket that slept a minute is a guess — replay instead.
    const a = new TerminalLink(harness().handlers, { hiddenReattachMs: 60_000 });
    await a.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(61_000);
    setVisibility('visible');
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    a.dispose();

    // Can pong: ask, and reconnect only if the answer does not come.
    FakeSocket.instances = [];
    terminalTicket.mockClear();
    const b = new TerminalLink(harness().handlers);
    await b.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    await vi.advanceTimersByTimeAsync(30_000);
    socket(0).receive(JSON.stringify({ t: 'pong' }));
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    setVisibility('visible');
    const pings = socket(0)
      .frames()
      .filter((f) => f.t === 'ping').length;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(terminalTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(terminalTicket).toHaveBeenCalledTimes(2);
    b.dispose();
  });
});

describe('teardown', () => {
  it('a link disposed mid-mint opens no socket (StrictMode: mount, unmount, mount)', async () => {
    let resolveTicket: (value: typeof TICKET) => void = () => {};
    terminalTicket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    const { handlers } = harness();
    const link = new TerminalLink(handlers);
    const connecting = link.connect('s1', { cols: 80, rows: 24 });
    link.dispose();
    resolveTicket(TICKET);
    await connecting;
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('close() is ours: no reconnect follows it', async () => {
    const { handlers, statuses } = harness();
    const link = new TerminalLink(handlers);
    await link.connect('s1', { cols: 80, rows: 24 });
    socket(0).open();
    link.close();
    socket(0).drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminalTicket).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toEqual(['live', undefined]);
    link.dispose();
  });
});

describe('estimateTerminalSize', () => {
  it('floors a phone at 80 columns and keeps every estimate inside the server clamps', () => {
    const phone = estimateTerminalSize(true, { width: 390, height: 844 });
    expect(phone.cols).toBe(80);
    expect(phone.rows).toBeGreaterThanOrEqual(20);
    expect(phone.rows).toBeLessThanOrEqual(200);
    const desktop = estimateTerminalSize(false, { width: 1440, height: 900 });
    expect(desktop.cols).toBeGreaterThan(100);
    expect(desktop.cols).toBeLessThanOrEqual(500);
    expect(desktop.rows).toBeGreaterThan(30);
    const tiny = estimateTerminalSize(false, { width: 10, height: 10 });
    expect(tiny).toEqual({ cols: 2, rows: 2 });
  });
});
