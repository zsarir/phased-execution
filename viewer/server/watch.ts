/**
 * Live refresh.
 *
 * A recursive watch on the docs tree, debounced, so the console updates the
 * moment an agent session writes a handoff, records QA or claims a lock — the
 * board on screen is the board in the repo.
 *
 * Two failure modes this has to survive, because the console now supervises
 * runs that last hours:
 *
 *  - **A hard failure.** `FSWatcher` is an EventEmitter, and an `error` event
 *    with no listener is an uncaught exception — which used to end the process.
 *    Every watcher now has a listener, and a failed directory is re-armed with
 *    backoff instead of taken personally.
 *  - **A silent one.** On macOS a recursive watch can simply stop delivering
 *    without ever emitting an error. The process stays up and the board quietly
 *    freezes, which looks exactly like a hang. A heartbeat fingerprints the
 *    watched tree; if it moved while the watch said nothing, the watch is dead
 *    and gets rebuilt.
 */

import { watch, statSync, readdirSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { log } from './log.ts';
import { markDegraded, clearDegraded } from './lifecycle.ts';

export type WatchHandler = (paths: string[]) => void;

const DEBOUNCE_MS = 150;
/** How often to check that a quiet watch is quiet because nothing happened. */
const HEARTBEAT_MS = Number(process.env.PHASE_CONSOLE_HEARTBEAT_MS ?? 60_000);
/** Re-arm delay after a watcher error, doubling up to the ceiling. */
const REARM_MIN_MS = 1_000;
const REARM_MAX_MS = 60_000;

/**
 * A cheap stand-in for "has anything changed": the newest mtime across each
 * watched directory and its immediate children. One level is enough — a
 * handoff written to `handoffs/<slug>/phase-07.md` moves `<slug>`'s mtime, and
 * `<slug>` is an immediate child of the directory we watch.
 */
function fingerprint(dirs: string[]): string {
  let newest = 0;
  let count = 0;
  for (const dir of dirs) {
    try {
      newest = Math.max(newest, statSync(dir).mtimeMs);
      for (const name of readdirSync(dir)) {
        count++;
        try { newest = Math.max(newest, statSync(join(dir, name)).mtimeMs); } catch { /* vanished mid-scan */ }
      }
    } catch { /* an unreadable directory contributes nothing */ }
  }
  return `${Math.round(newest)}:${count}`;
}

export class DocsWatcher {
  /**
   * Watchers are held with their directory so a single failure can be removed
   * and re-armed on its own. Keeping a dead watcher in the list would make
   * `healthy()` report a watch that is no longer delivering anything.
   */
  private watchers: { dir: string; watcher: FSWatcher }[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private dirs: string[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private rearm: NodeJS.Timeout | null = null;
  private rearmDelay = REARM_MIN_MS;
  private mark = '';
  private sawEvent = false;
  private failures = 0;

  private readonly handler: WatchHandler;

  constructor(handler: WatchHandler) {
    this.handler = handler;
  }

  /** False once a watch has failed or gone deaf — the UI shows this as stale. */
  healthy(): boolean {
    return this.dirs.length > 0 && this.watchers.length === this.dirs.length;
  }

  status(): { healthy: boolean; watching: number; expected: number; failures: number } {
    return {
      healthy: this.healthy(),
      watching: this.watchers.length,
      expected: this.dirs.length,
      failures: this.failures,
    };
  }

  start(dirs: (string | undefined)[]): void {
    this.stop();
    this.dirs = dirs.filter((d): d is string => Boolean(d));
    this.arm();
    this.mark = fingerprint(this.dirs);
    this.heartbeat = setInterval(() => this.check(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Arm any directory that is not currently watched. Safe to call repeatedly. */
  private arm(): void {
    for (const dir of this.dirs) {
      if (this.watchers.some((w) => w.dir === dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          this.sawEvent = true;
          if (!filename) return;
          const name = String(filename);
          // Editor scratch files and swap files are noise, not changes.
          if (/(^|\/)\.(?!locks)|~$|\.swp$|\.tmp$/.test(name)) return;
          this.pending.add(join(dir, name));
          this.schedule();
        });
        // The listener that turns a recoverable fault into a survivable one.
        watcher.on('error', (error) => this.onWatcherError(dir, error));
        this.watchers.push({ dir, watcher });
      } catch (error) {
        this.onWatcherError(dir, error);
      }
    }
    if (this.healthy()) {
      this.rearmDelay = REARM_MIN_MS;
      clearDegraded('watcher');
    }
  }

  /**
   * Drop the failed watcher before scheduling a rebuild — leaving it in place
   * would keep `healthy()` reporting true for a watch that is delivering
   * nothing, which is the exact lie this class exists to prevent.
   */
  private onWatcherError(dir: string, error: unknown): void {
    this.failures++;
    const index = this.watchers.findIndex((w) => w.dir === dir);
    if (index >= 0) {
      try { this.watchers[index].watcher.close(); } catch { /* already gone */ }
      this.watchers.splice(index, 1);
    }
    log.warn('watcher.error', { dir, error, failures: this.failures });
    markDegraded('watcher', error);
    this.scheduleRearm();
  }

  /** Rebuild every watcher after a failure, backing off so a broken path cannot spin. */
  private scheduleRearm(): void {
    if (this.rearm) return;
    const delay = this.rearmDelay;
    this.rearmDelay = Math.min(this.rearmDelay * 2, REARM_MAX_MS);
    this.rearm = setTimeout(() => {
      this.rearm = null;
      if (!this.dirs.length) return;
      this.arm();
      log.info('watcher.rearmed', { ...this.status(), afterMs: delay });
      // Anything that changed while we were deaf still has to reach the UI.
      this.flushFromDisk();
      // Still short of the full set? Keep backing off and trying.
      if (!this.healthy()) this.scheduleRearm();
    }, delay);
    this.rearm.unref();
  }

  /**
   * The heartbeat. If the tree moved but no event arrived since the last check,
   * the watch is delivering nothing and has to be rebuilt.
   */
  private check(): void {
    if (!this.dirs.length) return;
    const now = fingerprint(this.dirs);
    const moved = now !== this.mark;
    this.mark = now;

    if (moved && !this.sawEvent) {
      log.warn('watcher.deaf', { note: 'tree changed with no watch event; rebuilding', ...this.status() });
      markDegraded('watcher', new Error('file watch stopped delivering events'));
      this.closeWatchers();
      this.arm();
      this.flushFromDisk();
    }
    this.sawEvent = false;
  }

  /** Force a full re-read: we know something changed but not what. */
  private flushFromDisk(): void {
    try { this.handler([...this.dirs]); } catch (error) { log.error('watcher.handler', { error }); }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.timer = null;
      if (!paths.length) return;
      try { this.handler(paths); } catch (error) { log.error('watcher.handler', { error }); }
    }, DEBOUNCE_MS);
  }

  private closeWatchers(): void {
    for (const { watcher } of this.watchers) { try { watcher.close(); } catch { /* already gone */ } }
    this.watchers = [];
  }

  stop(): void {
    this.closeWatchers();
    this.dirs = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.rearm) { clearTimeout(this.rearm); this.rearm = null; }
    this.pending.clear();
    this.sawEvent = false;
  }
}
