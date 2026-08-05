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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
/* ------------------------------------------------------------------ *
 * Restarting on purpose
 * ------------------------------------------------------------------ */

/**
 * Is anything going to start this process again if it exits?
 *
 * The whole reason a Restart button can exist is that under launchd
 * `KeepAlive: true` a clean `exit(0)` is respawned within seconds. Under
 * `./run`, the desktop launcher, or `node server/index.ts` in a terminal there
 * is nothing watching — pressing Restart there would not restart the console,
 * it would *end* it, from a page that then has no server to tell you so.
 *
 * That asymmetry is the entire design constraint, so the answer is checked
 * rather than assumed, and it is checked in the only two ways that are actually
 * evidence:
 *
 *  - launchd stamps the job's label into `XPC_SERVICE_NAME`, and the plist that
 *    label names is readable — so `KeepAlive` is *read*, not hoped for. A job
 *    installed with `KeepAlive: false` is correctly reported as unsupervised.
 *  - systemd sets `INVOCATION_ID` for a unit it started; whether that unit has
 *    `Restart=` cannot be read from inside it, so it is reported as
 *    supervision this process cannot confirm, and the UI says so.
 *
 * `PHASE_CONSOLE_SUPERVISED=1|0` overrides both, for a supervisor nothing here
 * knows about (or a launchd job you want the button to refuse).
 */
export type Supervisor = {
  /** Whether a clean exit is expected to come back. */
  supervised: boolean;
  kind: 'launchd' | 'systemd' | 'declared' | 'none';
  /** One line, shown to a person about to press a button they cannot undo. */
  detail: string;
  /** True when supervision is inferred rather than read. */
  assumed?: boolean;
};

export function detectSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Supervisor {
  const declared = env.PHASE_CONSOLE_SUPERVISED;
  if (declared === '1') {
    return { supervised: true, kind: 'declared', detail: 'PHASE_CONSOLE_SUPERVISED=1 — you have said something will restart it' };
  }
  if (declared === '0') {
    return { supervised: false, kind: 'declared', detail: 'PHASE_CONSOLE_SUPERVISED=0 — restarting is disabled here' };
  }

  const label = env.XPC_SERVICE_NAME;
  if (platform === 'darwin' && label && label !== '0') {
    const keepAlive = readKeepAlive(label, env);
    if (keepAlive === true) {
      return { supervised: true, kind: 'launchd', detail: `launchd · ${label} · KeepAlive is on, so a clean exit comes straight back` };
    }
    if (keepAlive === false) {
      return {
        supervised: false,
        kind: 'launchd',
        detail: `launchd · ${label} · KeepAlive is off — exiting would stop the console, not restart it`,
      };
    }
    return {
      supervised: true,
      kind: 'launchd',
      assumed: true,
      detail: `launchd · ${label} · its plist could not be read, so KeepAlive is assumed rather than confirmed`,
    };
  }

  // `deploy/agent.sh` stamps the unit's own name into PHASE_CONSOLE_UNIT (via
  // %n) for exactly this: systemd's INVOCATION_ID proves *a* unit started us
  // but never says which, so without the stamp Restart= is unreadable.
  const unit = env.PHASE_CONSOLE_UNIT;
  if (env.INVOCATION_ID && unit) {
    const restart = readRestartPolicy(unit, env);
    if (restart === true) {
      return { supervised: true, kind: 'systemd', detail: `systemd · ${unit} · its Restart= brings a clean exit straight back` };
    }
    if (restart === false) {
      return {
        supervised: false,
        kind: 'systemd',
        detail: `systemd · ${unit} · its Restart= does not cover a clean exit — exiting would stop the console, not restart it`,
      };
    }
    return {
      supervised: true,
      kind: 'systemd',
      assumed: true,
      detail: `systemd · ${unit} · its unit file could not be read, so Restart= is assumed rather than confirmed`,
    };
  }

  if (env.INVOCATION_ID) {
    return {
      supervised: true,
      kind: 'systemd',
      assumed: true,
      detail: 'systemd started this unit; whether it has Restart= set cannot be read from inside it',
    };
  }

  return {
    supervised: false,
    kind: 'none',
    detail: 'nothing is supervising this process — it was started in a terminal or by the launcher, '
      + 'so exiting would leave no console running',
  };
}

/**
 * `true`/`false` when the unit file could be read, `null` when it could not.
 * Only `always` and `on-success` bring a *clean* exit back — which is the
 * question the Restart button is asking. Last assignment wins, as in systemd.
 */
function readRestartPolicy(unit: string, env: NodeJS.ProcessEnv): boolean | null {
  const home = env.HOME ?? homedir();
  const base = env.XDG_CONFIG_HOME ?? join(home, '.config');
  let text: string;
  try { text = readFileSync(join(base, 'systemd', 'user', unit), 'utf8'); } catch { return null; }
  const assignments = [...text.matchAll(/^\s*Restart\s*=\s*(\S*)/gm)];
  const value = assignments.at(-1)?.[1] ?? 'no';
  return value === 'always' || value === 'on-success';
}

/** `true`/`false` when the plist could be read, `null` when it could not. */
function readKeepAlive(label: string, env: NodeJS.ProcessEnv): boolean | null {
  const home = env.HOME ?? homedir();
  for (const path of [
    join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    join('/Library', 'LaunchAgents', `${label}.plist`),
  ]) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    // KeepAlive may be <true/>, <false/>, or a dict of conditions — a dict is
    // still "something will bring it back", which is the question being asked.
    const at = text.indexOf('<key>KeepAlive</key>');
    if (at < 0) return false;
    const after = text.slice(at + '<key>KeepAlive</key>'.length, at + 200);
    if (/^\s*<false\s*\/>/.test(after)) return false;
    return true;
  }
  return null;
}

/**
 * How the API asks the process to go away and come back.
 *
 * `index.ts` owns `shutdown()` — it holds the server handle and the drain
 * budget — so it registers the verb here rather than exporting a function the
 * API would have to import from the entry point.
 */
let restarter: ((reason: string) => void) | null = null;

export function onRestartRequest(handler: (reason: string) => void): void {
  restarter = handler;
}

export function requestRestart(reason: string): boolean {
  if (!restarter) return false;
  try { restarter(reason); } catch (error) { log.error('restart.failed', { reason, error }); return false; }
  return true;
}

/** The state a restart is being asked for from, for the API and the UI alike. */
export function supervisor(): Supervisor {
  return detectSupervisor();
}

/* ------------------------------------------------------------------ *
 * Stopping on purpose
 * ------------------------------------------------------------------ */

/**
 * How this process is actually stopped — which is not the same question as how
 * it is restarted, and is the reason there was no off switch for so long.
 *
 * Under launchd `KeepAlive` an exit is a *restart*: the one mechanism the
 * Restart button depends on is the one that makes "stop" impossible to express
 * as an exit. Ending the job means telling launchd, and `launchctl bootout
 * gui/<uid>/<label>` is that sentence — the same one `deploy/agent.sh` uses to
 * uninstall. Under systemd `Restart=always` the same trap has the same shape,
 * and the sentence is `systemctl --user stop <unit>`. Anywhere else, exiting
 * IS stopping.
 *
 * Pure, so the decision can be asserted without spawning anything.
 */
export type StopPlan =
  | { via: 'launchctl' | 'systemctl'; file: string; args: string[]; label: string; detail: string }
  | { via: 'exit'; detail: string };

export function stopPlan(
  sup: Supervisor = detectSupervisor(),
  env: NodeJS.ProcessEnv = process.env,
  // `null` rather than `undefined` for "this platform has no uid": passing
  // `undefined` to a defaulted parameter re-triggers the default, so the
  // no-uid case would be untestable — and it is a real case (Windows).
  uid: number | null = process.getuid?.() ?? null,
): StopPlan {
  const label = env.XPC_SERVICE_NAME;
  if (sup.kind === 'launchd' && label && label !== '0' && uid != null) {
    return {
      via: 'launchctl',
      file: 'launchctl',
      // `bootout` on the service target, not `stop` — `stop` under KeepAlive is
      // a restart with extra steps, which is exactly the trap being avoided.
      args: ['bootout', `gui/${uid}/${label}`],
      label,
      detail: `launchd · ${label} · the job is unloaded, so it stays off until you install or start it again`,
    };
  }
  const unit = env.PHASE_CONSOLE_UNIT;
  if (sup.kind === 'systemd' && unit) {
    return {
      via: 'systemctl',
      file: 'systemctl',
      // `stop`, which under systemd really does mean stop — Restart= only
      // covers exits, not deliberate stops. The unit stays enabled, so it
      // returns at the next login unless disabled.
      args: ['--user', 'stop', unit],
      label: unit,
      detail: `systemd · ${unit} · the unit is stopped until you start it again (it still starts at login unless you disable it)`,
    };
  }
  return {
    via: 'exit',
    detail: sup.supervised
      ? `${sup.detail} — this console cannot unload that supervisor, so it exits and may be brought back`
      : 'nothing is supervising this process, so exiting stops it',
  };
}

/** The narrow slice of `child_process.spawn` this needs, so a test can pass a fake. */
export type Spawner = (
  file: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
) => { unref(): void };

/**
 * Hand the stop order to the supervisor and walk away.
 *
 * Detached with no stdio on purpose: the command outlives this process by
 * design — it is the thing that ends it — so it must not be a child whose
 * parent dying takes it with it.
 */
export function bootout(plan: StopPlan, spawn: Spawner): boolean {
  if (plan.via === 'exit') return false;
  try {
    spawn(plan.file, plan.args, { detached: true, stdio: 'ignore' }).unref();
    log.warn('shutdown.bootout', { label: plan.label, args: plan.args });
    return true;
  } catch (error) {
    log.error('shutdown.bootout.failed', { label: plan.label, error });
    return false;
  }
}

/**
 * The Shut-down button's other half, registered by `index.ts` for the same
 * reason `onRestartRequest` is: `shutdown()` closes over the server handle and
 * the drain budget.
 */
let stopper: ((reason: string) => void) | null = null;

export function onShutdownRequest(handler: (reason: string) => void): void {
  stopper = handler;
}

export function requestShutdown(reason: string): boolean {
  if (!stopper) return false;
  try { stopper(reason); } catch (error) { log.error('shutdown.failed', { reason, error }); return false; }
  return true;
}

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
