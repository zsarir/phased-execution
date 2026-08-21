/**
 * The browser half of the terminal: one socket, one session.
 *
 * Deliberately not a React hook and deliberately not in TanStack Query. A pty
 * is a stream, not a resource — there is no "current value" to cache, no
 * staleness to reason about, and re-running it on a re-render would open a
 * second shell. The view owns one of these in a ref and drives it.
 *
 * ## The wire
 *
 * Two frame types, distinguished by the WebSocket's own text/binary flag rather
 * than by a discriminator we would have to parse:
 *
 *   • **binary, server → client** — raw pty output. It arrives as bytes and is
 *     handed to xterm as bytes, so a UTF-8 sequence split across two frames is
 *     xterm's problem to reassemble (which it does) rather than ours to get
 *     wrong with a per-chunk `TextDecoder`.
 *   • **text, both ways** — small JSON envelopes: `{t:'i'}` input, `{t:'r'}`
 *     resize, `{t:'ping'}` heartbeat from the client; `{t:'hello'|'exit'|'pong'}`
 *     from the server.
 *
 * ## Size
 *
 * The pty is authoritative about its size and the browser is the only one who
 * knows it. Three rules keep them agreeing, and each one closed a real hole:
 *
 *   • **The last requested size is buffered and flushed on `open`.** A phone
 *     fits the terminal in a frame the socket has not opened yet; the old link
 *     dropped that resize (`if (!live) return`) and the pty lived at the 80×24
 *     it was minted with — a TUI laid out for 24 rows in a 46-row pane.
 *   • **Wire resizes are debounced, trailing edge, ~150 ms.** A keyboard
 *     animation fires `visualViewport.resize` a dozen times; each used to
 *     become an ioctl and a full TUI repaint. The visual fit stays per frame;
 *     the pty hears about it once.
 *   • `connect()` still mints with the size, so a NEW session spawns right.
 *
 * ## Staying connected
 *
 * A token is single-use, so a reconnect is a fresh `POST /api/terminal` naming
 * the same `sessionId` — which is also what makes a reload, a phone locking its
 * screen, or a killed tab all the same event. The server replays scrollback on
 * every attach, so nothing here has to remember what was on screen.
 *
 * With `autoReconnect` the link does that itself: a socket that closes under it
 * is reopened after 1 s, 2 s, then every 5 s, reported as `reconnecting` with
 * the attempt number so the pane can say so; a tab coming back to the
 * foreground or the network returning retries at once. A refusal from the
 * console — the session is gone, the flag is off — is permanent and stops the
 * loop with `error`; only transport failures retry.
 *
 * A socket can also die *silently* (a phone suspended in the background keeps
 * a socket object that nothing will ever deliver to). The link sends a
 * `{t:'ping'}` every 30 s while the page is visible. A server that answers
 * `pong` makes the link **pong-capable**, and from then on a missing answer
 * within 10 s means dead: drop and reconnect. A server that does not answer
 * (one that predates the frame) is never punished for silence — instead a tab
 * that was hidden longer than `hiddenReattachMs` reattaches when it returns,
 * because a replay is cheap and a dead pane is not.
 */

import { ApiError, api, type TerminalSession } from './api';

export type LinkStatus = 'connecting' | 'reconnecting' | 'live' | 'closed' | 'error';

export interface LinkHandlers {
  /** Raw pty bytes. Pass straight to `term.write` — do not decode. */
  onData(bytes: Uint8Array): void;
  /** `reconnecting` carries the attempt number as `detail`. */
  onStatus(status: LinkStatus, detail?: string): void;
  /** The `hello` of an attach. `reattach` is true for every attach but the first. */
  onSession(session: TerminalSession, info: { reattach: boolean }): void;
  onExit(exit: { code: number; signal?: number; closedByOperator?: boolean }): void;
  /** A size settled (the trailing edge of the debounce), whether or not it could be sent yet. */
  onSize?(size: { cols: number; rows: number }): void;
}

export interface LinkOptions {
  /** Reopen a dropped socket by itself (default true). */
  autoReconnect?: boolean;
  /** Trailing-edge debounce for wire resizes (default 150 ms). */
  resizeDebounceMs?: number;
  /** Heartbeat cadence while visible (default 30 s; 0 disables). */
  pingEveryMs?: number;
  /** How long a pong-capable server may stay silent after a ping (default 10 s). */
  pongTimeoutMs?: number;
  /** A tab hidden longer than this reattaches on return when the server cannot pong (default 60 s). */
  hiddenReattachMs?: number;
}

export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000];

function socketUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

/** A refusal the console meant: do not retry it. 408/429 are transport-shaped. */
function permanent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export class TerminalLink {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  /** The session this link is bound to; set by the first ticket, reused on reconnect. */
  sessionId: string | undefined;

  private readonly options: Required<LinkOptions>;
  /** The last size the browser settled on — what `open` flushes. */
  private size: { cols: number; rows: number } | undefined;
  /** What the CURRENT socket was last told — a flush of the same size is skipped. */
  private sent: { cols: number; rows: number } | undefined;
  private sizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the current socket has sent anything the server would act on. */
  private attaches = 0;
  private ended = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pingSentAt = 0;
  private pongCapable = false;
  private hiddenAt = 0;
  private listening = false;
  private disposed = false;

  constructor(
    private readonly handlers: LinkHandlers,
    options: LinkOptions = {},
  ) {
    this.options = {
      autoReconnect: options.autoReconnect ?? true,
      resizeDebounceMs: options.resizeDebounceMs ?? 150,
      pingEveryMs: options.pingEveryMs ?? 30_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      hiddenReattachMs: options.hiddenReattachMs ?? 60_000,
    };
  }

  /**
   * Open (or reopen) the socket for `sessionId`, minting a fresh ticket first.
   *
   * `size` is passed to the mint so a *new* session starts at the size the
   * browser already knows, instead of spawning at 80×24 and reflowing the
   * prompt the moment the first resize lands — and it is remembered, so the
   * same size is flushed the moment the socket opens.
   */
  async connect(sessionId: string | undefined, size: { cols: number; rows: number }): Promise<void> {
    if (size.cols > 0 && size.rows > 0) this.size = { cols: size.cols, rows: size.rows };
    this.ended = false;
    this.attempt = 0;
    this.clearRetry();
    await this.open(sessionId, 'connecting');
  }

  private async open(sessionId: string | undefined, status: 'connecting' | 'reconnecting'): Promise<void> {
    this.close();
    this.closedByUs = false;
    this.listen();
    this.handlers.onStatus(status, status === 'reconnecting' ? String(this.attempt) : undefined);

    let ticket;
    try {
      ticket = await api.terminalTicket({
        sessionId,
        ...(this.size ? { cols: this.size.cols, rows: this.size.rows } : {}),
      });
    } catch (error) {
      if (this.closedByUs) return;
      if (permanent(error) || !this.options.autoReconnect) {
        this.handlers.onStatus('error', (error as Error).message);
        return;
      }
      this.handlers.onStatus('error', (error as Error).message);
      this.scheduleRetry();
      return;
    }

    /**
     * ⚠️ Minting is a network round trip, and the link can be closed during it.
     *
     * Without this the socket opens *after* the teardown that was supposed to
     * prevent it, and nothing is left holding a reference to close it. React's
     * StrictMode makes it reproducible — mount, unmount, mount — and it shows up
     * as a session with two clients where one person is looking, each echoing
     * the other's keystrokes.
     */
    if (this.closedByUs) return;

    this.sessionId = ticket.sessionId;
    const socket = new WebSocket(socketUrl(ticket.path, ticket.token));
    // Without this the browser hands us Blobs and every frame costs an async
    // read — on a stream that can arrive hundreds of times a second.
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.sent = undefined;
      this.handlers.onStatus('live');
      // The size the browser settled on while the socket was still opening —
      // exactly once, the latest one. The server no-ops an unchanged size.
      this.flushSize();
      this.startPings();
    };

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      // Anything arriving is proof of life, whatever the server's vintage.
      this.pingSentAt = 0;
      if (typeof event.data !== 'string') {
        this.handlers.onData(new Uint8Array(event.data));
        return;
      }
      let parsed: {
        t?: string;
        session?: TerminalSession;
        code?: number;
        signal?: number;
        closedByOperator?: boolean;
      };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.t === 'hello' && parsed.session) {
        const reattach = this.attaches > 0;
        this.attaches += 1;
        this.handlers.onSession(parsed.session, { reattach });
      }
      if (parsed.t === 'pong') this.pongCapable = true;
      if (parsed.t === 'exit') {
        this.ended = true;
        this.handlers.onExit({
          code: parsed.code ?? 0,
          signal: parsed.signal,
          closedByOperator: parsed.closedByOperator,
        });
      }
    };

    socket.onerror = () => {
      // `onerror` on a WebSocket carries no detail by design (it would leak
      // cross-origin information), so there is nothing useful to report but
      // the fact. `onclose` always follows and says whether it was clean.
      if (!this.closedByUs) this.handlers.onStatus('error');
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.stopPings();
      if (this.closedByUs) return;
      this.handlers.onStatus('closed');
      if (this.options.autoReconnect && !this.ended) this.scheduleRetry();
    };
  }

  get live(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    if (!this.live) return;
    this.socket?.send(JSON.stringify({ t: 'i', d: data }));
  }

  /**
   * Remember the size and tell the pty — once the debounce settles, and only
   * while the socket is open (an unopened socket gets it from `onopen`).
   */
  resize(cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return;
    this.size = { cols, rows };
    if (this.sizeTimer) clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(() => {
      this.sizeTimer = null;
      this.flushSize();
      if (this.size) this.handlers.onSize?.(this.size);
    }, this.options.resizeDebounceMs);
  }

  /** Send the buffered size now, if there is one and the socket is open. */
  flushSize(): void {
    if (!this.size || !this.live) return;
    if (this.sent && this.sent.cols === this.size.cols && this.sent.rows === this.size.rows) return;
    this.sent = { ...this.size };
    this.socket?.send(JSON.stringify({ t: 'r', cols: this.size.cols, rows: this.size.rows }));
  }

  /** Drop the socket. Auto-reconnect stays armed for a later `connect()`. */
  close(): void {
    this.closedByUs = true;
    this.clearRetry();
    this.stopPings();
    const socket = this.socket;
    this.socket = null;
    // 1000 = normal closure. Anything else shows up in a browser console as an
    // error for something that is just a page navigating away.
    try {
      socket?.close(1000, 'bye');
    } catch {
      /* already gone */
    }
  }

  /** Close, and stop listening to the page — the pane's unmount. */
  dispose(): void {
    this.disposed = true;
    this.close();
    if (this.sizeTimer) {
      clearTimeout(this.sizeTimer);
      this.sizeTimer = null;
    }
    this.unlisten();
  }

  /* ---------------- reconnecting ---------------- */

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    this.attempt += 1;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length) - 1];
    this.handlers.onStatus('reconnecting', String(this.attempt));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A hidden tab waits for its turn in the foreground rather than burning
      // attempts nobody will see; `visibilitychange` picks it up.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.attempt -= 1;
        return;
      }
      void this.open(this.sessionId, 'reconnecting');
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Reconnect now, from the top of the backoff — the tab came back, the network returned. */
  private retryNow(): void {
    if (this.disposed || this.ended || (this.closedByUs && !this.options.autoReconnect)) return;
    if (!this.sessionId) return;
    this.clearRetry();
    this.attempt = 0;
    void this.open(this.sessionId, 'reconnecting');
  }

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      this.stopPings();
      return;
    }
    const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (!this.options.autoReconnect || this.ended || !this.sessionId) return;
    if (!this.live) {
      // Closed while we were away (or a retry that deferred itself).
      this.retryNow();
      return;
    }
    if (this.pongCapable) {
      // The server can answer: ask, and let the heartbeat check decide.
      this.ping();
      this.startPings();
      return;
    }
    if (hiddenFor >= this.options.hiddenReattachMs) {
      // A socket that slept that long on a phone is a guess, and a replay is
      // cheaper than a dead pane that looks live.
      this.retryNow();
      return;
    }
    this.startPings();
  };

  private onOnline = (): void => {
    if (!this.live) this.retryNow();
  };

  private listen(): void {
    if (this.listening || typeof document === 'undefined') return;
    this.listening = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
  }

  /* ---------------- the heartbeat ---------------- */

  /** Ask once, and arm the one-shot check that decides what silence means. */
  private ping(): void {
    if (!this.live) return;
    if (!this.pingSentAt) this.pingSentAt = Date.now();
    this.socket?.send(JSON.stringify({ t: 'ping' }));
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // Answered (anything arriving clears `pingSentAt`), or a server that
      // has never answered — silence from THAT one is not evidence.
      if (!this.pingSentAt || !this.pongCapable || !this.live) return;
      // Asked, not answered, by a server that does answer: the socket is a
      // corpse the browser has not noticed yet.
      const socket = this.socket;
      this.socket = null;
      this.stopPings();
      try {
        socket?.close(4000, 'no heartbeat');
      } catch {
        /* gone */
      }
      this.handlers.onStatus('closed', 'no heartbeat');
      if (this.options.autoReconnect && !this.ended) this.scheduleRetry();
    }, this.options.pongTimeoutMs);
  }

  private startPings(): void {
    // Only the cadence restarts: a pong check armed a moment ago (the resume
    // probe) must keep running, or restarting the interval would forgive the
    // very silence it was sent to detect.
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (!this.options.pingEveryMs) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.pingTimer = setInterval(() => {
      if (!this.live) {
        this.stopPings();
        return;
      }
      this.ping();
    }, this.options.pingEveryMs);
  }

  private stopPings(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.pingSentAt = 0;
  }
}

/**
 * A plausible terminal size for a pty that has to exist before xterm does —
 * the agent launcher, a recovery or QA mint. The pane refits the moment it
 * mounts and flushes the real size on open; this only stops the process from
 * being BORN at 80×24 and laying its first screen out for a window it is not
 * in. Same floors the pane applies: 80 columns on a phone, 2 either way.
 */
export function estimateTerminalSize(
  phone: boolean,
  viewport: { width: number; height: number } = {
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  },
): { cols: number; rows: number } {
  const fontSize = phone ? 16 : 14;
  // Measured: JetBrains Mono's cell at 16px is ~21px tall before the 1.15
  // line height — ~24px a row on a phone, ~21px on a desktop.
  const cell = { w: fontSize * 0.6, h: fontSize * 1.5 };
  // Chrome around the pane: top bar/strip, key bar + composer and the tab bar
  // on a phone; the rail column and the strip on a desktop.
  const chromeH = phone ? 48 + 104 + 60 + 48 : 48 + 16;
  const chromeW = phone ? 8 : 236 + 16;
  const cols = Math.floor(Math.max(0, viewport.width - chromeW) / cell.w);
  const rows = Math.floor(Math.max(0, viewport.height - chromeH) / cell.h);
  return {
    cols: Math.max(phone ? 80 : 2, Math.min(500, cols)),
    rows: Math.max(2, Math.min(200, rows)),
  };
}
