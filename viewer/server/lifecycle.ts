/**
 * Process lifecycle and health.
 *
 * Two things the console needs once it supervises real work:
 *
 *  - **Degraded state.** An unhandled fault used to end the process. It now
 *    gets recorded here instead, so the server keeps serving and the UI can say
 *    "something broke" rather than the browser silently facing a dead port.
 *  - **Ordered shutdown.** A run in progress must be checkpointed before the
 *    process goes away. Subsystems register a handler; `index.ts` awaits them
 *    with a ceiling so a wedged handler can't block the exit forever.
 *
 * Kept apart from `log.ts` on purpose: that module must stay dependency-free
 * enough to be safe to call from inside a crash handler.
 */

import { log } from './log.ts';

/* ------------------------------------------------------------------ *
 * Degraded state
 * ------------------------------------------------------------------ */

export type Degradation = { at: string; kind: string; message: string };

const MAX_KEPT = 20;
const degradations: Degradation[] = [];
let notify: ((state: Degradation) => void) | null = null;

/** Let the service push degradations out over SSE without importing it here. */
export function onDegraded(listener: (state: Degradation) => void): void {
  notify = listener;
}

/** The same fault, over and over, is one fault. */
let last: { key: string; at: number; count: number } | null = null;
const REPEAT_WINDOW_MS = 2_000;

export function markDegraded(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  // A fault whose own reporting can re-trigger it — a write to a stderr that no
  // longer exists is the real example — otherwise recurses until something
  // gives. Collapsing repeats is what stops that being fatal rather than merely
  // noisy, so it is a guard and not a tidiness measure.
  const key = `${kind}:${message}`;
  const now = Date.now();
  if (last && last.key === key && now - last.at < REPEAT_WINDOW_MS) {
    last.count++;
    last.at = now;
    return;
  }
  const repeated = last?.key === key ? last.count : 0;
  last = { key, at: now, count: 1 };
  if (repeated > 1) log.warn('degraded.repeated', { kind, message, times: repeated });

  const entry: Degradation = { at: new Date().toISOString(), kind, message };
  degradations.push(entry);
  if (degradations.length > MAX_KEPT) degradations.shift();
  log.error('degraded', { kind, error });
  try { notify?.(entry); } catch { /* a listener must never re-enter the crash path */ }
}

export function degradedState(): { healthy: boolean; recent: Degradation[] } {
  return { healthy: degradations.length === 0, recent: [...degradations] };
}

/** Called once a subsystem has recovered — clears the badge. */
export function clearDegraded(kind: string): void {
  for (let i = degradations.length - 1; i >= 0; i--) {
    if (degradations[i].kind === kind) degradations.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ *
 * Ordered shutdown
 * ------------------------------------------------------------------ */

export type ShutdownHandler = () => Promise<void> | void;

const handlers = new Map<string, ShutdownHandler>();

/** Register cleanup that must finish before the process exits. Idempotent by name. */
export function onShutdown(name: string, handler: ShutdownHandler): void {
  handlers.set(name, handler);
}

export function offShutdown(name: string): void {
  handlers.delete(name);
}

export function hasShutdownWork(): boolean {
  return handlers.size > 0;
}

/**
 * Run every handler, each with its own deadline so one slow subsystem does not
 * eat the whole budget. Resolves once all have settled or timed out; never
 * rejects — a failed cleanup is logged, not thrown, because the alternative is
 * an unhandled rejection during shutdown.
 */
export async function runShutdownHandlers(perHandlerMs: number): Promise<void> {
  const pending = [...handlers.entries()];
  handlers.clear();

  await Promise.all(pending.map(async ([name, handler]) => {
    const started = Date.now();
    try {
      await Promise.race([
        Promise.resolve(handler()),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`shutdown handler "${name}" exceeded ${perHandlerMs}ms`)), perHandlerMs).unref()),
      ]);
      log.info('shutdown.handler', { name, ms: Date.now() - started });
    } catch (error) {
      log.error('shutdown.handler.failed', { name, ms: Date.now() - started, error });
    }
  }));
}
