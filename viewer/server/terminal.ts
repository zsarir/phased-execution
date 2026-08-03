/**
 * A real shell — or an interactive `claude` session — in the browser. Off
 * unless someone asked for it.
 *
 * The console already spawns `claude` sessions that edit repositories for
 * hours; a terminal is not a new class of power on this machine. What it *is*
 * is a new way in, so it gets its own flag (`--allow-terminal`), its own
 * handshake, and a gate that runs on the upgrade request itself.
 *
 * Sessions come in two kinds. A `shell` is exactly what it always was:
 * `$SHELL -l`, no policy but the person typing. A `claude` session runs the
 * interactive CLI from a `LaunchSpec` composed and validated in `agent.ts` —
 * this registry never builds claude argv itself, it only spawns what that
 * module resolved. The two kinds are gated separately (`--allow-terminal` vs
 * `--allow-agent`), and a reattach is gated by the kind of the session it
 * names, not by whichever flag let the caller in.
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

/**
 * How long an **ended** session's record is kept when nobody dismisses it.
 *
 * There used to be an idle rule instead, and it was the wrong rule: a detached
 * session — shell or claude — was killed 30 minutes after the last client went
 * away. Closing a laptop lid for lunch was enough to lose a session that was
 * running perfectly well, and the record of one that had finished vanished ~30
 * seconds after it exited, taking its `claude --resume` id with it. A session
 * now stops for exactly two reasons: someone killed it, or the console did.
 *
 * What is left for the sweeper is a ceiling on *records of dead processes*, so
 * a console left running for a month does not hold every shell it ever opened.
 * A day is long enough that "until you dismiss it" is true in every session a
 * person actually comes back to, and short enough to bound the memory.
 */
const EXITED_RETAIN_MS = 24 * 60 * 60_000;

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
 *
 * Counted over **live** processes only. An ended session that is still listed
 * so you can read what it said is not holding a pty, and letting it occupy a
 * slot would mean the console refused to open a shell because of eight
 * terminals that all exited yesterday.
 */
const MAX_SESSIONS = 8;

/**
 * How many ended-but-undismissed records are kept at once, oldest evicted
 * first. The retention window above bounds them in time; this bounds them in
 * count, because each carries up to `SCROLLBACK_BYTES` of text.
 */
const MAX_EXITED = 16;

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

/** What a session is running. The wire protocol is identical for both. */
export type SessionKind = 'shell' | 'claude';

/**
 * What a recovery session was launched to put right.
 *
 * Composed by the server (`agent.ts`) and never accepted from a browser, like
 * every other field on `SessionMeta` — this is what links a session back to the
 * thing on the board that needed it, so its exit can be checked against that
 * thing rather than merely reported.
 */
export type RecoveryLink = {
  /** The failure class the action was offered for — `runner/errors.ts` names these. */
  kind: string;
  slug?: string;
  phase?: number;
  runId?: string;
};

/** Facts about a claude session the UI needs back, none of them secret. */
export type SessionMeta = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** The uuid handed to `--session-id` — what `claude --resume <id>` takes later. */
  claudeSessionId?: string;
  /** `plan` marks a session booted by the New-plan wizard. */
  intent?: 'plan' | 'recovery';
  /** Set on a session minted by a recovery action; absent on every other session. */
  recovery?: RecoveryLink;
};

/**
 * A fully resolved thing to spawn. Composed outside this module (`agent.ts`
 * for claude sessions), so the registry stays what it was: a lifecycle for
 * ptys, never a place that decides argv.
 */
export type LaunchSpec = {
  kind: SessionKind;
  file: string;
  args: string[];
  label?: string;
  meta?: SessionMeta;
};

export interface SessionInfo {
  id: string;
  label: string;
  kind: SessionKind;
  cwd: string;
  /** The spawned file — `$SHELL` for shells, `claude` for agent sessions. */
  shell: string;
  cols: number;
  rows: number;
  pid: number;
  clients: number;
  createdAt: number;
  /**
   * When the pty last produced output. Now that nothing is reaped for being
   * quiet this is no longer a policy input — it is what a list of sessions
   * shows to tell "working" from "waiting at a prompt".
   */
  lastOutputAt: number;
  /** When the last client detached, while none is attached. */
  detachedSince?: number;
  meta?: SessionMeta;
  /**
   * Set once the process is gone. The record OUTLIVES the process until it is
   * dismissed, so the page can say what happened — and, for a claude session,
   * still offer the `--resume` id that is otherwise lost with it.
   */
  exited?: { code: number; signal?: number; closedByOperator?: boolean };
  /** When it ended, so the UI can age it and the sweeper can retire it. */
  exitedAt?: number;
}

interface Session extends SessionInfo {
  pty: PtyProcess;
  scrollback: Scrollback;
  wires: Set<Wire>;
  idleSince: number;
  /** Stamped on every pty chunk — "working" vs "parked", shown rather than acted on. */
  lastOutputAt: number;
  paused: boolean;
}

/** What just happened to a session. The service turns these into SSE + notifications. */
export type SessionEventType =
  | 'created' | 'attached' | 'detached' | 'exited' | 'killed' | 'dismissed';

export type SessionEvent = {
  type: SessionEventType;
  session: SessionInfo;
  /**
   * On `exited` only: whether the last client had already gone. An exit nobody
   * was watching is the one worth a notification; one you were looking at is
   * not news.
   */
  detached?: boolean;
};

interface Minted {
  token: string;
  sessionId: string;
  expiresAt: number;
}

export type Availability = 'yes' | 'no' | 'unknown';

export interface TerminalOptions {
  /** The shell gate — `--allow-terminal`. */
  allowed: boolean;
  /** The agent gate — `--allow-agent` (via `agentEnabled()`), for `claude` sessions. */
  agentAllowed?: boolean;
  /** Where a new session starts — the open source directory, when there is one. */
  cwd?: () => string | undefined;
  /** Tests inject a fake; production takes the lazily-imported real one. */
  spawn?: PtySpawn;
  /**
   * Every lifecycle moment, for the one subscriber that turns them into an SSE
   * event and — where they are worth waking someone for — a notification. A
   * callback rather than an import, so the registry still knows nothing about
   * the service.
   */
  onSession?: (event: SessionEvent) => void;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Minted>();
  private counter = 0;
  private claudeCounter = 0;
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
  state(): {
    allowed: boolean; agentAllowed: boolean; available: Availability;
    sessions: SessionInfo[]; limit: number; live: number;
  } {
    return {
      allowed: this.options.allowed,
      agentAllowed: this.options.agentAllowed === true,
      available: this.probed,
      limit: MAX_SESSIONS,
      // Reported beside the cap because the cap is now about live processes
      // only: `sessions.length` and "how many slots are taken" are different
      // numbers the moment anything has ended.
      live: this.live(),
      sessions: [...this.sessions.values()].map(describe),
    };
  }

  /** Processes still running — what `MAX_SESSIONS` is a cap on. */
  live(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (!session.exited) n++;
    return n;
  }

  /** One place to raise a lifecycle event; a bad listener never reaches a pty. */
  private say(type: SessionEventType, session: Session, detached?: boolean): void {
    try {
      this.options.onSession?.({
        type,
        session: describe(session),
        ...(detached === undefined ? {} : { detached }),
      });
    } catch (error) {
      log.warn('terminal.listener', { id: session.id, type, error: message(error) });
    }
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
  async mint(sessionId?: string, size?: { cols?: number; rows?: number }, launch?: LaunchSpec): Promise<
    { ok: true; sessionId: string; token: string; expiresAt: number; session: SessionInfo }
    | { ok: false; status: number; error: string }
  > {
    // With both capabilities off, refuse before looking anything up — whether
    // a session id exists is not discoverable through a disabled feature.
    if (!this.options.allowed && this.options.agentAllowed !== true) {
      return { ok: false, status: 403, error: 'The terminal is disabled. Restart with --allow-terminal to enable it.' };
    }

    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      return { ok: false, status: 404, error: 'That terminal session has ended.' };
    }

    // A reattach is gated by what the SESSION is, not by which flag admitted
    // the caller: an agent-only console must not hand out a live shell.
    if (session) {
      const refusal = this.kindRefusal(session.kind);
      if (refusal) return refusal;
    }

    if (!session) {
      const kind: SessionKind = launch?.kind ?? 'shell';
      const refusal = this.kindRefusal(kind);
      if (refusal) return refusal;
      // Live processes only: an ended session listed for its exit status is not
      // occupying anything, and refusing a new shell because of it would be a
      // cap on the operator's memory rather than on this machine.
      if (this.live() >= MAX_SESSIONS) {
        return {
          ok: false,
          status: 409,
          error: `Too many live sessions (${MAX_SESSIONS} across shells and agents). Close one first.`,
        };
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
        session = this.create(spawn, size, launch);
      } catch (error) {
        log.error('terminal.spawn-failed', { error, kind });
        // node-pty's own words here are `posix_spawnp failed.`, which says
        // nothing — for a claude session the overwhelmingly likely cause is
        // worth naming.
        const hint = kind === 'claude'
          ? `Could not start claude — is the \`claude\` CLI on this console's PATH? (${message(error)})`
          : `Could not start a shell: ${message(error)}`;
        return { ok: false, status: 500, error: hint };
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

  /** The per-kind gate, phrased once so mint's two call sites cannot drift. */
  private kindRefusal(kind: SessionKind): { ok: false; status: number; error: string } | null {
    if (kind === 'claude') {
      return this.options.agentAllowed === true
        ? null
        : { ok: false, status: 403, error: 'Agent sessions are disabled. Restart with --allow-agent to enable them.' };
    }
    return this.options.allowed
      ? null
      : { ok: false, status: 403, error: 'The terminal is disabled. Restart with --allow-terminal to enable it.' };
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

    // Either capability makes the socket path exist; the per-kind decision was
    // already made when the ticket was minted, and a ticket names its session.
    if (!this.options.allowed && this.options.agentAllowed !== true) {
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
      this.say('detached', session);
    });

    this.say('attached', session);
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

  /**
   * Stop a session because someone said so — the tab strip's ✕, the dashboard's
   * Kill, or the console going down.
   *
   * The record goes with it. That is the difference between this and an exit
   * the operator did not ask for: a session you closed is not news, and leaving
   * its corpse in the list would mean every deliberate close needed a second
   * click to tidy up. `closedByOperator` is stamped before the kill so the
   * `onExit` that follows a moment later knows not to announce it.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.exited ??= { code: 0, closedByOperator: true };
    session.exited.closedByOperator = true;
    session.exitedAt ??= Date.now();
    try { session.pty.kill(); } catch { /* already gone */ }
    for (const wire of session.wires) {
      send(wire, JSON.stringify({ t: 'exit', code: 0, closedByOperator: true }));
      try { wire.close(1000, 'closed'); } catch { /* already closing */ }
    }
    this.sessions.delete(id);
    log.info('terminal.closed', { id });
    this.say('killed', session);
    return true;
  }

  /**
   * Drop the record of a session that has already ended.
   *
   * Refuses on a live one: "dismiss" is a UI verb for tidying a list, and a
   * button that quietly killed a working session because it was in the wrong
   * column would be the worst kind of surprise. Killing is `kill()`, and the
   * client asks for it by name.
   */
  dismiss(id: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'no such session' };
    if (!session.exited) return { ok: false, reason: 'that session is still running — close it instead' };
    this.sessions.delete(id);
    log.info('terminal.dismissed', { id });
    this.say('dismissed', session);
    return { ok: true };
  }

  /** Shutdown: every pty is a child process, and none may outlive the console. */
  close(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
    for (const id of [...this.sessions.keys()]) this.kill(id);
    this.tokens.clear();
  }

  private create(spawn: PtySpawn, size?: { cols?: number; rows?: number }, launch?: LaunchSpec): Session {
    const kind: SessionKind = launch?.kind ?? 'shell';
    const file = launch?.file ?? (process.env.SHELL || '/bin/sh');
    const args = launch?.args ?? ['-l'];
    const cwd = firstDir([this.options.cwd?.(), process.env.HOME, homedir()]);
    const cols = clampSize(size?.cols, 20, 500) ?? 80;
    const rows = clampSize(size?.rows, 5, 200) ?? 24;

    const pty = spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // A login shell that does not know it is on a terminal prints a
      // different prompt and disables colour, so TERM is set here rather than
      // inherited from whatever launchd handed the console. The claude TUI
      // needs the same answer for the same reason. `CLAUDE_CONFIG_DIR` rides
      // along in process.env — the child runs in the home this console did,
      // which is also the home `/api/skills` enumerated.
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    const id = randomBytes(6).toString('hex');
    const session: Session = {
      id,
      label: launch?.label ?? (kind === 'claude' ? `Claude ${++this.claudeCounter}` : `Terminal ${++this.counter}`),
      kind,
      ...(launch?.meta ? { meta: launch.meta } : {}),
      cwd,
      shell: file,
      cols,
      rows,
      pid: pty.pid,
      clients: 0,
      createdAt: Date.now(),
      pty,
      scrollback: new Scrollback(),
      wires: new Set(),
      idleSince: Date.now(),
      lastOutputAt: Date.now(),
      paused: false,
    };

    pty.onData((data) => {
      session.lastOutputAt = Date.now();
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
      // A kill() already stamped this and removed the record; the pty telling
      // us a moment later is not a second event, and must not re-announce a
      // session the operator closed on purpose.
      const closedByOperator = session.exited?.closedByOperator === true;
      session.exited = { code: exitCode, signal, ...(closedByOperator ? { closedByOperator } : {}) };
      session.exitedAt ??= Date.now();
      for (const wire of session.wires) {
        send(wire, JSON.stringify({ t: 'exit', code: exitCode, signal }));
      }
      if (closedByOperator) return;
      // The record now OUTLIVES the process — until it is dismissed, the
      // retention window closes, or the ceiling evicts it. That is what keeps
      // `claude --resume <uuid>` reachable after the CLI has gone.
      this.retire();
      this.say('exited', session, session.wires.size === 0);
    });

    this.sessions.set(id, session);
    log.info('terminal.opened', { id, kind, shell: file, cwd, pid: pty.pid });
    this.say('created', session);
    return session;
  }

  /** Keep at most `MAX_EXITED` dead records, oldest first out. */
  private retire(): void {
    const dead = [...this.sessions.values()]
      .filter((session) => session.exited)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    for (const session of dead.slice(0, Math.max(0, dead.length - MAX_EXITED))) {
      this.sessions.delete(session.id);
      log.info('terminal.evicted', { id: session.id, kept: MAX_EXITED });
      this.say('dismissed', session);
    }
  }

  private start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (!shouldReap({ wires: session.wires.size, exited: session.exited, exitedAt: session.exitedAt }, now)) continue;
        this.sessions.delete(session.id);
        log.info('terminal.retired', { id: session.id });
        this.say('dismissed', session);
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
    kind: session.kind,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    pid: session.pid,
    clients: session.wires.size,
    createdAt: session.createdAt,
    lastOutputAt: session.lastOutputAt,
    ...(!session.wires.size && session.idleSince ? { detachedSince: session.idleSince } : {}),
    ...(session.meta ? { meta: session.meta } : {}),
    ...(session.exited ? { exited: session.exited } : {}),
    ...(session.exitedAt ? { exitedAt: session.exitedAt } : {}),
  };
}

/**
 * Whether the sweeper may drop a session record — pure, so the rule is
 * testable without timers.
 *
 * **A living process is never reaped.** Not a shell, not a claude session, not
 * one nobody is attached to. The old rule killed a detached session after 30
 * idle minutes with a special case that spared a claude which had printed
 * recently, and both halves were wrong for the same reason: whether anyone is
 * *watching* a session says nothing about whether it is still wanted. A phone
 * that went to sleep, a laptop lid closed over lunch, a tab closed on purpose
 * because the thing takes an hour — every one of those looked identical to
 * abandonment, and the session died for it. Sessions now end when someone kills
 * them or when the console goes down, and nothing else.
 *
 * What remains is retention of the DEAD: a record kept so the page can say what
 * happened and hand back a `--resume` id. It is kept until dismissed, and this
 * is the backstop for the ones nobody ever dismisses — with no one attached and
 * the window long past.
 */
export function shouldReap(
  session: { wires: number; exited?: unknown; exitedAt?: number },
  now: number,
  retainMs: number = EXITED_RETAIN_MS,
): boolean {
  if (!session.exited) return false;
  // Someone is reading the ended session's scrollback — the one case where a
  // dead record is actively in use.
  if (session.wires) return false;
  return now - (session.exitedAt ?? now) > retainMs;
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
