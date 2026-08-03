/**
 * A real shell, in the browser — off unless someone asked for it.
 *
 * The console already spawns `claude` sessions that edit repositories for
 * hours; a terminal is not a new class of power on this machine. What it *is*
 * is a new way in, so it gets its own flag (`--allow-terminal`), its own
 * handshake, and a gate that runs on the upgrade request itself.
 *
 * ## Why the token exists
 *
 * A WebSocket upgrade is not a fetch. **CORS does not apply to it**, and the
 * `Origin` header a browser sends on one is not enforced by anything — any
 * other page in the browser, and any local program, can open a socket to
 * 127.0.0.1 and send whatever Origin it likes. So the same-origin check that
 * protects every POST in `api/routes.ts` is worth exactly nothing here.
 *
 * The wall is instead:
 *
 *   1. `POST /api/terminal` — a normal mutation, so it carries the console
 *      header and the same-origin check, needs `--allow-terminal`, and passes
 *      the access gate. It mints a short-lived, single-use token.
 *   2. `GET /ws/terminal?token=…` — the access gate runs **again** on the
 *      upgrade request (so a tailscale identity is enforced on the socket, not
 *      merely on the page that opened it), and only then is the token consumed.
 *
 * A page that cannot make the POST cannot get a token, and a token is spent the
 * moment it is used. Origin is never consulted.
 *
 * ## Why node-pty is imported lazily
 *
 * `node-pty` is a native module. A clone on a machine with no toolchain, or an
 * `npm ci` that skipped optional builds, must still get a working console —
 * losing the terminal is acceptable, losing the board is not. So the import
 * happens on demand and its failure is a reported capability, never a crash.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { log } from './log.ts';

/** Where the browser opens its socket. One path, no versioning in the URL. */
export const TERMINAL_PATH = '/ws/terminal';

/**
 * Long enough to survive a slow page and a phone waking its radio, short
 * enough that a token found in a log or a screenshot is already dead.
 */
const TOKEN_TTL_MS = 60_000;

/** A detached session is kept this long, then reaped. */
const IDLE_MS = 30 * 60_000;

const SWEEP_MS = 30_000;

/**
 * Enough scrollback that reattaching feels like the same terminal, bounded so a
 * runaway `yes` cannot eat the console's memory. Counted in bytes, not lines,
 * because a line has no maximum length.
 */
const SCROLLBACK_BYTES = 200 * 1024;

/**
 * A person has one pair of hands. The cap is not about resources — it is so a
 * bug that mints a session per render cannot fork-bomb the machine.
 */
const MAX_SESSIONS = 8;

/**
 * Above this much unflushed output the pty is paused until the socket drains.
 * Without it, `cat` on a large file buffers the whole thing in this process
 * because the pty produces far faster than a phone on cellular consumes.
 */
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * The shapes we need from `node-pty` and `ws`
 * ------------------------------------------------------------------ */

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
}

export interface PtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

export type PtySpawn = (file: string, args: string[], options: PtyOptions) => PtyProcess;

/**
 * The socket, as this module uses it. Typing the real `ws` class here would
 * make a type-only import decide whether the module can be loaded at all; this
 * is the whole surface, and `ws`'s WebSocket satisfies it.
 */
export interface Wire {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/* ------------------------------------------------------------------ *
 * Scrollback
 * ------------------------------------------------------------------ */

/**
 * The last N bytes of output, so a reattach shows the terminal you left rather
 * than an empty screen with a live prompt.
 *
 * Whole chunks are evicted rather than bytes: cutting a chunk in half can cut
 * an escape sequence in half, and a terminal fed half a sequence renders the
 * rest of the session in the wrong colour.
 */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;
  private readonly limit: number;

  // Written out rather than as a parameter property: Node runs this file by
  // stripping types, and `constructor(private x)` is syntax, not a type.
  constructor(limit = SCROLLBACK_BYTES) {
    this.limit = limit;
  }

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += Buffer.byteLength(text);
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= Buffer.byteLength(this.chunks.shift() as string);
    }
  }

  text(): string {
    return this.chunks.join('');
  }

  get bytes(): number {
    return this.size;
  }
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string;
  label: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  pid: number;
  clients: number;
  createdAt: number;
  /** Set once the process is gone; the record survives briefly so the UI can say why. */
  exited?: { code: number; signal?: number };
}

interface Session extends SessionInfo {
  pty: PtyProcess;
  scrollback: Scrollback;
  wires: Set<Wire>;
  idleSince: number;
  paused: boolean;
}

interface Minted {
  token: string;
  sessionId: string;
  expiresAt: number;
}

export type Availability = 'yes' | 'no' | 'unknown';

export interface TerminalOptions {
  allowed: boolean;
  /** Where a new shell starts — the open source directory, when there is one. */
  cwd?: () => string | undefined;
  /** Tests inject a fake; production takes the lazily-imported real one. */
  spawn?: PtySpawn;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Minted>();
  private counter = 0;
  private sweeper: NodeJS.Timeout | undefined;
  private ptyModule: Promise<PtySpawn | null> | undefined;
  private wsModule: Promise<WsServerLike | null> | undefined;
  private probed: Availability = 'unknown';
  private readonly options: TerminalOptions;

  constructor(options: TerminalOptions) {
    this.options = options;
    if (options.spawn) this.probed = 'yes';
  }

  get allowed(): boolean {
    return this.options.allowed;
  }

  /**
   * Whether a shell could actually be started, as a fact rather than a promise
   * of one. `unknown` until something has tried — the client shows the flag
   * state until then, which is the only honest thing to show.
   */
  availability(): Availability {
    return this.probed;
  }

  /** What `/api/terminal` reports. Never includes a token. */
  state(): { allowed: boolean; available: Availability; sessions: SessionInfo[]; limit: number } {
    return {
      allowed: this.options.allowed,
      available: this.probed,
      limit: MAX_SESSIONS,
      sessions: [...this.sessions.values()].map(describe),
    };
  }

  /* ---------------- the handshake ---------------- */

  /**
   * Mint a single-use ticket for a session, creating one if no id was given.
   *
   * The session is created here rather than on connect so that its output is
   * already buffering while the browser is still loading xterm — and so that a
   * client which never manages to connect leaves something the sweeper can
   * reap, instead of a token that quietly means nothing.
   */
  async mint(sessionId?: string, size?: { cols?: number; rows?: number }): Promise<
    { ok: true; sessionId: string; token: string; expiresAt: number; session: SessionInfo }
    | { ok: false; status: number; error: string }
  > {
    if (!this.options.allowed) {
      return { ok: false, status: 403, error: 'The terminal is disabled. Restart with --allow-terminal to enable it.' };
    }

    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      return { ok: false, status: 404, error: 'That terminal session has ended.' };
    }

    if (!session) {
      if (this.sessions.size >= MAX_SESSIONS) {
        return { ok: false, status: 409, error: `Too many terminal sessions (${MAX_SESSIONS}). Close one first.` };
      }
      const spawn = await this.loadPty();
      if (!spawn) {
        return {
          ok: false,
          status: 503,
          error: 'node-pty is not installed, so this console cannot open a shell. '
            + 'Run `npm install` in the viewer directory and restart.',
        };
      }
      try {
        session = this.create(spawn, size);
      } catch (error) {
        log.error('terminal.spawn-failed', { error });
        return { ok: false, status: 500, error: `Could not start a shell: ${message(error)}` };
      }
    }

    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { token, sessionId: session.id, expiresAt: Date.now() + TOKEN_TTL_MS });
    this.start();
    // The session record travels with the ticket so the caller never has to
    // race its own creation: a client that navigated to the new session and
    // then re-read a not-yet-refetched list would find nothing there and
    // bounce straight back off the page it just opened.
    return {
      ok: true,
      sessionId: session.id,
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      session: describe(session),
    };
  }

  /**
   * Spend a ticket. Single-use and constant-time: the map lookup alone would
   * leak nothing useful, but the comparison is the part an attacker controls,
   * so it is the part that is done properly.
   */
  consume(token: string | null | undefined): Session | null {
    if (!token) return null;
    const now = Date.now();
    for (const [key, minted] of this.tokens) {
      if (minted.expiresAt <= now) { this.tokens.delete(key); continue; }
    }
    for (const [key, minted] of this.tokens) {
      if (!equalSecret(key, token)) continue;
      this.tokens.delete(key);
      const session = this.sessions.get(minted.sessionId);
      return session ?? null;
    }
    return null;
  }

  /* ---------------- the socket ---------------- */

  /**
   * Take over an upgrade this console owns.
   *
   * Returns false for a path that is not ours, so the caller can refuse it as a
   * 404 rather than leaving the socket hanging. **The access gate has already
   * run in `server/index.ts` by the time this is called** — this function's job
   * is the flag and the token, in that order, because "the terminal is off"
   * must not be discoverable by guessing tokens.
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> {
    if (url.pathname !== TERMINAL_PATH) return false;

    if (!this.options.allowed) {
      refuse(socket, 403, 'terminal disabled');
      log.warn('terminal.upgrade-refused', { reason: 'disabled' });
      return true;
    }

    const session = this.consume(url.searchParams.get('token'));
    if (!session) {
      refuse(socket, 401, 'bad or expired terminal token');
      // Deliberately without the token itself: a refused handshake is worth
      // recording, a credential in a log file is not.
      log.warn('terminal.upgrade-refused', { reason: 'bad-token', host: req.headers.host });
      return true;
    }

    const server = await this.loadWs();
    if (!server) {
      refuse(socket, 503, 'ws is not installed');
      return true;
    }

    server.handleUpgrade(req, socket, head, (wire: Wire) => { this.attach(session, wire); });
    return true;
  }

  /** Wire a live socket to a session: replay, then pipe both ways. */
  attach(session: Session, wire: Wire): void {
    session.wires.add(wire);
    session.idleSince = 0;

    send(wire, JSON.stringify({
      t: 'hello',
      session: describe(session),
      scrollbackBytes: session.scrollback.bytes,
    }));
    const replay = session.scrollback.text();
    if (replay) send(wire, Buffer.from(replay, 'utf8'));
    if (session.exited) send(wire, JSON.stringify({ t: 'exit', ...session.exited }));

    wire.on('message', (data: unknown, isBinary: boolean) => {
      // Everything the client says is a small JSON envelope. A binary frame
      // from a browser is not something this protocol produces, so it is
      // ignored rather than interpreted as keystrokes.
      if (isBinary) return;
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      this.onClientMessage(session, parsed);
    });

    wire.on('error', (error: Error) => { log.warn('terminal.socket', { id: session.id, error }); });

    wire.on('close', () => {
      session.wires.delete(wire);
      if (!session.wires.size) session.idleSince = Date.now();
      if (session.paused && !session.wires.size) { session.paused = false; session.pty.resume?.(); }
    });
  }

  private onClientMessage(session: Session, parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return;
    const message_ = parsed as { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };

    if (message_.t === 'i' && typeof message_.d === 'string') {
      if (session.exited) return;
      session.pty.write(message_.d);
      return;
    }

    if (message_.t === 'r') {
      const cols = clampSize(message_.cols, 20, 500);
      const rows = clampSize(message_.rows, 5, 200);
      if (!cols || !rows) return;
      if (cols === session.cols && rows === session.rows) return;
      session.cols = cols;
      session.rows = rows;
      if (session.exited) return;
      // A pty that has already gone rejects a resize; that is not an error
      // worth taking the console down for.
      try { session.pty.resize(cols, rows); } catch (error) { log.warn('terminal.resize', { id: session.id, error }); }
    }
  }

  /* ---------------- lifecycle ---------------- */

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try { session.pty.kill(); } catch { /* already gone */ }
    for (const wire of session.wires) {
      send(wire, JSON.stringify({ t: 'exit', code: 0, closedByOperator: true }));
      try { wire.close(1000, 'closed'); } catch { /* already closing */ }
    }
    this.sessions.delete(id);
    log.info('terminal.closed', { id });
    return true;
  }

  /** Shutdown: every pty is a child process, and none may outlive the console. */
  close(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
    for (const id of [...this.sessions.keys()]) this.kill(id);
    this.tokens.clear();
  }

  private create(spawn: PtySpawn, size?: { cols?: number; rows?: number }): Session {
    const shell = process.env.SHELL || '/bin/sh';
    const cwd = firstDir([this.options.cwd?.(), process.env.HOME, homedir()]);
    const cols = clampSize(size?.cols, 20, 500) ?? 80;
    const rows = clampSize(size?.rows, 5, 200) ?? 24;

    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // A login shell that does not know it is on a terminal prints a
      // different prompt and disables colour, so TERM is set here rather than
      // inherited from whatever launchd handed the console.
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    const id = randomBytes(6).toString('hex');
    const session: Session = {
      id,
      label: `Terminal ${++this.counter}`,
      cwd,
      shell,
      cols,
      rows,
      pid: pty.pid,
      clients: 0,
      createdAt: Date.now(),
      pty,
      scrollback: new Scrollback(),
      wires: new Set(),
      idleSince: Date.now(),
      paused: false,
    };

    pty.onData((data) => {
      session.scrollback.push(data);
      const frame = Buffer.from(data, 'utf8');
      let queued = 0;
      for (const wire of session.wires) {
        send(wire, frame);
        queued = Math.max(queued, wire.bufferedAmount ?? 0);
      }
      // Only worth pausing while someone is actually reading: a detached
      // session's output goes straight to the ring, which is already bounded.
      if (session.wires.size && !session.paused && queued > BACKPRESSURE_BYTES) {
        session.paused = true;
        session.pty.pause?.();
        setTimeout(() => { session.paused = false; session.pty.resume?.(); }, 250).unref();
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      session.exited = { code: exitCode, signal };
      for (const wire of session.wires) {
        send(wire, JSON.stringify({ t: 'exit', code: exitCode, signal }));
      }
      // The record outlives the process for a moment so the page can say "the
      // shell exited" instead of "the connection dropped", then the sweeper
      // takes it: `idleSince` in the past means the next sweep collects it.
      session.idleSince = Date.now() - IDLE_MS + 30_000;
    });

    this.sessions.set(id, session);
    log.info('terminal.opened', { id, shell, cwd, pid: pty.pid });
    return session;
  }

  private start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (session.wires.size) continue;
        if (session.idleSince && now - session.idleSince > IDLE_MS) this.kill(session.id);
      }
      for (const [key, minted] of this.tokens) {
        if (minted.expiresAt <= now) this.tokens.delete(key);
      }
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  /* ---------------- the lazy natives ---------------- */

  private loadPty(): Promise<PtySpawn | null> {
    if (this.options.spawn) return Promise.resolve(this.options.spawn);
    this.ptyModule ??= import('node-pty')
      .then((module_) => {
        const spawn = (module_ as unknown as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } }).spawn
          ?? (module_ as unknown as { default?: { spawn?: PtySpawn } }).default?.spawn
          ?? null;
        if (spawn) { healSpawnHelper(); this.probed = 'yes'; } else { this.probed = 'no'; }
        return spawn;
      })
      .catch((error) => {
        this.probed = 'no';
        log.warn('terminal.no-pty', { error: message(error) });
        return null;
      });
    return this.ptyModule;
  }

  private loadWs(): Promise<WsServerLike | null> {
    this.wsModule ??= import('ws')
      .then((module_) => {
        const ctor = (module_ as unknown as { WebSocketServer?: WsServerCtor }).WebSocketServer
          ?? (module_ as unknown as { default?: { WebSocketServer?: WsServerCtor } }).default?.WebSocketServer;
        if (!ctor) return null;
        // `noServer` because the console owns the HTTP server and the access
        // gate must run before anything WebSocket-shaped touches the socket.
        return new ctor({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
      })
      .catch((error) => {
        log.warn('terminal.no-ws', { error: message(error) });
        return null;
      });
    return this.wsModule;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface WsServerLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (wire: Wire) => void): void;
}

type WsServerCtor = new (options: {
  noServer: boolean;
  maxPayload: number;
  perMessageDeflate: boolean;
}) => WsServerLike;

function describe(session: Session): SessionInfo {
  return {
    id: session.id,
    label: session.label,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    pid: session.pid,
    clients: session.wires.size,
    createdAt: session.createdAt,
    ...(session.exited ? { exited: session.exited } : {}),
  };
}

function send(wire: Wire, data: string | Uint8Array): void {
  // A socket that closed between the check and the write throws synchronously;
  // one dead client must not stop the others being served.
  try { wire.send(data); } catch { /* the close handler will clean it up */ }
}

/** A refusal a browser can actually see, rather than a socket that just dies. */
export function refuse(socket: Duplex, status: number, reason: string): void {
  const text = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\n`
    + 'content-type: text/plain; charset=utf-8\r\n'
    + `content-length: ${Buffer.byteLength(text)}\r\n`
    + 'connection: close\r\n\r\n'
    + text,
  );
  socket.destroy();
}

function equalSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function clampSize(value: unknown, min: number, max: number): number | null {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function firstDir(candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* try the next */ }
  }
  return homedir();
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * node-pty ships its `spawn-helper` prebuild **without the executable bit**
 * (1.1.0, at least through npm on macOS). The failure it produces is
 * `Error: posix_spawnp failed.` from deep inside the addon — nothing about it
 * says "chmod", and every reasonable next move (rebuild, reinstall, another
 * Node) reproduces it exactly.
 *
 * Fixing it here rather than in a `postinstall` keeps it true after any
 * `npm ci`, and the whole operation is one stat and one chmod on a file we are
 * about to execute anyway. A read-only `node_modules` just falls through to the
 * original error, which is no worse than before.
 */
export function healSpawnHelper(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const root = dirname(dirname(require_.resolve('node-pty')));
    const candidates = [
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      const mode = statSync(path).mode;
      if (mode & 0o111) continue;
      chmodSync(path, mode | 0o755);
      log.info('terminal.healed-spawn-helper', { path });
      return path;
    }
  } catch (error) {
    log.warn('terminal.heal-failed', { error: message(error) });
  }
  return null;
}
