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
 *     resize, `{t:'hello'|'exit'}` from the server.
 *
 * ## Reconnecting
 *
 * A token is single-use, so a reconnect is a fresh `POST /api/terminal` naming
 * the same `sessionId` — which is also what makes a reload, a phone locking its
 * screen, or a killed tab all the same event. The server replays scrollback on
 * every attach, so nothing here has to remember what was on screen.
 */

import { api, type TerminalSession } from './api';

export type LinkStatus = 'connecting' | 'live' | 'closed' | 'error';

export interface LinkHandlers {
  /** Raw pty bytes. Pass straight to `term.write` — do not decode. */
  onData(bytes: Uint8Array): void;
  onStatus(status: LinkStatus, detail?: string): void;
  onSession(session: TerminalSession): void;
  onExit(exit: { code: number; signal?: number; closedByOperator?: boolean }): void;
}

function socketUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export class TerminalLink {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  /** The session this link is bound to; set by the first ticket, reused on reconnect. */
  sessionId: string | undefined;

  constructor(private readonly handlers: LinkHandlers) {}

  /**
   * Open (or reopen) the socket for `sessionId`, minting a fresh ticket first.
   *
   * `size` is passed to the mint so a *new* session starts at the size the
   * browser already knows, instead of spawning at 80×24 and reflowing the
   * prompt the moment the first resize lands.
   */
  async connect(sessionId: string | undefined, size: { cols: number; rows: number }): Promise<void> {
    this.close();
    this.closedByUs = false;
    this.handlers.onStatus('connecting');

    let ticket;
    try {
      ticket = await api.terminalTicket({ sessionId, cols: size.cols, rows: size.rows });
    } catch (error) {
      if (this.closedByUs) return;
      this.handlers.onStatus('error', (error as Error).message);
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

    socket.onopen = () => { this.handlers.onStatus('live'); };

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') {
        this.handlers.onData(new Uint8Array(event.data));
        return;
      }
      let parsed: { t?: string; session?: TerminalSession; code?: number; signal?: number; closedByOperator?: boolean };
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (parsed.t === 'hello' && parsed.session) this.handlers.onSession(parsed.session);
      if (parsed.t === 'exit') {
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
      if (!this.closedByUs) this.handlers.onStatus('closed');
    };
  }

  get live(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    if (!this.live) return;
    this.socket?.send(JSON.stringify({ t: 'i', d: data }));
  }

  resize(cols: number, rows: number): void {
    if (!this.live) return;
    this.socket?.send(JSON.stringify({ t: 'r', cols, rows }));
  }

  close(): void {
    this.closedByUs = true;
    const socket = this.socket;
    this.socket = null;
    // 1000 = normal closure. Anything else shows up in a browser console as an
    // error for something that is just a page navigating away.
    try { socket?.close(1000, 'bye'); } catch { /* already gone */ }
  }
}
