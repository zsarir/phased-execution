/**
 * Sessions — the browser terminal, claude-kind agent sessions, the
 * session-presence registry and the hook that feeds it.
 */

import { request, post, q } from './client';
import type { RecoveryClass } from '../recovery';
import type { QaProfile } from '../qa';

/* ---------------- the terminal ---------------- */

export interface TerminalSession {
  id: string;
  label: string;
  /** What the session runs. Absent (an older server) means a shell. */
  kind?: 'shell' | 'claude';
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  pid: number;
  clients: number;
  createdAt: number;
  /** When the pty last printed — how a list tells "working" from "waiting". */
  lastOutputAt?: number;
  /** When the last client detached, while none is attached. */
  detachedSince?: number;
  /** Claude-session facts the UI shows back — never secret. */
  meta?: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** What `claude --resume <id>` takes after this pty is gone. */
    claudeSessionId?: string;
    intent?: 'plan' | 'recovery' | 'qa';
    /** Set by the server on a recovery session — what it was launched to fix. */
    recovery?: { kind: string; slug?: string; phase?: number; runId?: string };
    /**
     * Set by the server on a QA session — which phase it reviews, and what
     * `test-status.md` said when it started. The snapshot is how the exit check
     * tells "recorded a verdict" from "ended next to one that was already there".
     */
    qa?: { slug: string; phase: number; before?: string; beforeReport?: string };
  };
  /**
   * Present once the process has gone. The record now OUTLIVES it until it is
   * dismissed, so this is a state the page renders rather than a moment it
   * catches.
   */
  exited?: { code: number; signal?: number; closedByOperator?: boolean };
  /** When it ended. */
  exitedAt?: number;
  /** Set while the process group sits under SIGSTOP — who asked, since when. */
  frozen?: { at: number; by: string };
  /** A graceful stop is in flight: SIGTERM sent, SIGKILL armed on a grace. */
  stopping?: { at: number; by: string };
}

export interface TerminalState {
  /** `--allow-terminal` was given. */
  allowed: boolean;
  /** `--allow-agent` was given — claude sessions may be minted. */
  agentAllowed?: boolean;
  /** Whether `node-pty` actually loaded — `unknown` until something has tried. */
  available: 'yes' | 'no' | 'unknown';
  limit: number;
  /** Live processes — what `limit` caps. `sessions` also carries ended records. */
  live?: number;
  sessions: TerminalSession[];
}

/**
 * A Claude session the session-presence hook reported for this instance — a
 * person's own `claude`, a console agent, an autopilot lane (here or in
 * another console) — with the registry's three-valued presence and, when a
 * lock's `session=` says so (strong) or the owner and the clock suggest it
 * (weak), the plan and phase it works.
 */
export interface ForeignSession {
  sessionId: string;
  kind: 'autopilot' | 'agent' | 'foreign';
  cwd: string;
  root?: string;
  transcript?: string;
  owner?: string;
  scope?: string;
  user?: string;
  host?: string;
  pid?: number;
  startedAt: string;
  lastSeen: string;
  endedAt?: string;
  reason?: string;
  source?: string;
  turns: number;
  presence: 'live' | 'ended' | 'unknown';
  plan?: { slug: string; phase: number; strong: boolean };
}

export interface SessionRegistryView {
  sessions: ForeignSession[];
}

/** The session-presence hook, as `~/.claude/settings.json` has it. */
export interface HooksStatusView {
  path: string;
  exists: boolean;
  installed: boolean;
  partial: boolean;
  events: Record<'SessionStart' | 'SessionEnd' | 'Stop', boolean>;
  command: string;
  stale: boolean;
  parseError?: string;
}

export interface HooksWriteView {
  ok: true;
  path: string;
  changed: boolean;
  status: HooksStatusView;
}

/** What a shutdown or a restart is about to stop. Both dialogs render it. */
export interface SessionInventory {
  live: number;
  agent: number;
  terminal: number;
  ended: number;
  sessions: { id: string; label: string; kind: 'shell' | 'claude' }[];
}

/** A single-use ticket for one WebSocket upgrade. Never logged, never stored. */
export interface TerminalTicket {
  ok: true;
  sessionId: string;
  token: string;
  expiresAt: number;
  path: string;
  /** The session as it now is — so the caller never races its own creation. */
  session: TerminalSession;
}

/** The session fetchers — merged into `api` by `./index`. */
export const sessionsApi = {
  /* ---- the terminal ----
     `terminalTicket` is the handshake: a POST, so it carries the console header
     and the same-origin check that the WebSocket upgrade that follows cannot.
     See `server/terminal.ts` for why the socket alone is not defensible. */
  terminal: () => request<TerminalState>('/api/terminal'),
  terminalTicket: (body: { sessionId?: string; cols?: number; rows?: number }) =>
    post<TerminalTicket>('/api/terminal', body),
  /**
   * Mint a claude-kind session. The server composes and validates the argv —
   * this body is enum choices, a bounded prompt, and nothing executable.
   */
  agentTicket: (body: {
    cols?: number; rows?: number;
    model?: string; effort?: string; permissionMode?: string;
    prompt?: string; skills?: string[]; resume?: string;
    intent?: 'plan' | 'recovery' | 'qa'; brief?: string;
    /* A recovery names its TARGET and nothing else — the server reads the
       board, the run and the diagnosis and composes the prompt itself. */
    recoveryClass?: RecoveryClass; slug?: string; phase?: number; runId?: string;
    /* A review names its target the same way. `activate` turns QA on for the
       plan first; `permissionProfile` is the one place bypass is offered, and
       the server refuses it on any other kind of session. */
    activate?: boolean; permissionProfile?: QaProfile;
    /* Which account the session runs as — a registered id, validated server-side. */
    accountId?: string;
  }) => post<TerminalTicket>('/api/terminal', { kind: 'claude', ...body }),
  terminalClose: (id: string) =>
    request<{ closed: boolean; state: TerminalState }>(`/api/terminal?id=${q(id)}`, { method: 'DELETE' }),
  /** Drop the record of a session that has already ended. Refused on a live one. */
  sessionDismiss: (id: string) =>
    request<{ ok: boolean; reason?: string; state: TerminalState }>(
      `/api/terminal?id=${q(id)}&action=dismiss`, { method: 'DELETE' },
    ),
  /** SIGSTOP the session's process group — the lane-freeze verb at session size. */
  sessionFreeze: (id: string) =>
    post<{ ok: boolean; reason?: string; state: TerminalState }>(`/api/terminal/${q(id)}/freeze`),
  /** SIGCONT — the session picks up exactly where it stopped. */
  sessionThaw: (id: string) =>
    post<{ ok: boolean; reason?: string; state: TerminalState }>(`/api/terminal/${q(id)}/thaw`),
  /**
   * End a session politely: SIGTERM, SIGKILL only after a grace it ignored.
   * Unlike `terminalClose`, the record stays — outcome checks and the
   * `--resume` id survive the stop.
   */
  sessionStop: (id: string) =>
    post<{ ok: boolean; reason?: string; state: TerminalState }>(`/api/terminal/${q(id)}/stop`),

  /* ---- session presence: the registry the hook feeds, and the hook installer ---- */
  sessionRegistry: () => request<SessionRegistryView>('/api/sessions/registry'),
  hooksStatus: () => request<HooksStatusView>('/api/hooks-install'),
  hooksInstall: (action: 'install' | 'uninstall') => post<HooksWriteView>('/api/hooks-install', { action }),
};
