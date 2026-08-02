/**
 * Structured logging and the exit record.
 *
 * The console has to survive an unattended multi-hour run, and a supervisor
 * that dies silently is worse than no supervisor at all — so every exit writes
 * down why. Lines are NDJSON in `~/.local/state/phase-console/console.log`
 * (never inside a repo, the same rule preferences follow), rotated at 8 MB so
 * a long-lived process cannot fill a disk.
 *
 * Writes are synchronous on purpose: the records that matter most are the ones
 * emitted microseconds before the process dies, and an async write loses
 * exactly those. Every call is wrapped — logging must never be the thing that
 * takes the server down.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATE_DIR, defaultLogFile } from './config.ts';

export type Level = 'info' | 'warn' | 'error';

export type Entry = {
  time: string;
  level: Level;
  event: string;
  data?: Record<string, unknown>;
};

const MAX_BYTES = 8 * 1024 * 1024;
/** Enough recent history for the UI to explain a degraded state, not a second log. */
const RING_SIZE = 200;

let file: string | null = null;
let ready = false;
const ring: Entry[] = [];

/** Point the log at a file. Called once at startup; `null` disables file output. */
export function configureLog(target?: string | null): string | null {
  file = target === null ? null : (target ?? defaultLogFile());
  ready = false;
  if (file) open();
  return file;
}

function open(): void {
  if (!file || ready) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfLarge();
    ready = true;
  } catch {
    // An unwritable state directory costs us the file log, not the server.
    file = null;
  }
}

function rotateIfLarge(): void {
  if (!file) return;
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    /* no file yet, or a rotation race — either way, keep going */
  }
}

/** Errors do not survive JSON.stringify; unwrap them into something readable. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: (value as { code?: unknown }).code,
      stack: value.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return value;
}

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry: Entry = { time: new Date().toISOString(), level, event };
  if (data && Object.keys(data).length) {
    entry.data = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, plain(v)])) as Record<string, unknown>;
  }

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  // launchd captures stderr, so a problem is visible even without the file.
  if (level !== 'info') {
    try {
      process.stderr.write(`[phase-console] ${level} ${event}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}\n`);
    } catch { /* a closed stderr is not worth dying for */ }
  }

  if (!file) return;
  open();
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* disk full, permissions, a deleted directory — never propagate */
  }
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
};

const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECANCELED', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * Closing a tab, navigating away, or sleeping a laptop all abort an in-flight
 * response. These have to be *handled* — unhandled they end the process — but
 * they are not worth recording: a browser reload used to produce a dozen stack
 * traces, and a log that noisy is a log nobody reads.
 */
export function isClientDisconnect(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && DISCONNECT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === 'aborted' || message.includes('premature close');
}

/** The last few hundred entries, newest last — for `/api/state` and the UI. */
export function recent(limit = 50): Entry[] {
  return ring.slice(-Math.max(1, limit));
}

export function logFilePath(): string | null {
  return file;
}

/**
 * Did the previous run end without writing an exit record?
 *
 * `SIGKILL`, an OOM kill and a hard power loss all leave `start` as the last
 * entry — nothing can be logged from a process that is already gone. So two
 * consecutive `start` records with no `exit` between them *are* the crash
 * signature, and saying so at boot beats hoping someone notices the gap.
 * Returns null when there is no prior run to judge.
 */
export function previousRunEndedCleanly(): boolean | null {
  if (!file) return null;
  try {
    // The last few KB is plenty; the records we care about are one line each.
    const raw = readFileSync(file, 'utf8');
    const lines = raw.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      const event = (JSON.parse(lines[i]) as Entry).event;
      if (event === 'exit') return true;
      if (event === 'start') return false;
    }
  } catch {
    /* no log yet, or a truncated line — nothing to conclude */
  }
  return null;
}

export function stateDir(): string {
  return STATE_DIR;
}

/* ------------------------------------------------------------------ *
 * The exit record
 * ------------------------------------------------------------------ */

let exitReason: { reason: string; detail?: Record<string, unknown> } | null = null;
let exitInstalled = false;

/**
 * Declare why the process is about to end, so the exit record says something
 * better than "code 0". A deliberate shutdown calls this; anything that does
 * not is reported as `unknown`, which is precisely the case worth chasing.
 */
export function noteExit(reason: string, detail?: Record<string, unknown>): void {
  exitReason = { reason, detail };
}

/**
 * Record how this process ended.
 *
 * An exit with no declared reason is logged at `error` even when the code is 0,
 * because a silent clean exit is exactly the failure we are hunting: the
 * console "just stopped" and nothing said why. Disposition — which signals
 * actually end the process — belongs to `index.ts`; this only writes it down.
 */
export function installExitLogging(): void {
  if (exitInstalled) return;
  exitInstalled = true;

  const started = Date.now();

  process.on('exit', (code) => {
    write(exitReason ? 'info' : 'error', 'exit', {
      code,
      reason: exitReason?.reason ?? 'unknown — no shutdown path ran',
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      ...(exitReason?.detail ?? {}),
    });
  });
}
