/**
 * Live refresh.
 *
 * A recursive watch on the docs tree, debounced, so the console updates the
 * moment an agent session writes a handoff, records QA or claims a lock — the
 * board on screen is the board in the repo.
 */

import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export type WatchHandler = (paths: string[]) => void;

const DEBOUNCE_MS = 150;

export class DocsWatcher {
  private watchers: FSWatcher[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private readonly handler: WatchHandler;

  constructor(handler: WatchHandler) {
    this.handler = handler;
  }

  start(dirs: (string | undefined)[]): void {
    this.stop();
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const name = String(filename);
          // Editor scratch files and swap files are noise, not changes.
          if (/(^|\/)\.(?!locks)|~$|\.swp$|\.tmp$/.test(name)) return;
          this.pending.add(join(dir, name));
          this.schedule();
        });
        this.watchers.push(watcher);
      } catch {
        /* an unwatchable directory just means no live updates for it */
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.timer = null;
      if (paths.length) this.handler(paths);
    }, DEBOUNCE_MS);
  }

  stop(): void {
    for (const watcher of this.watchers) { try { watcher.close(); } catch { /* already gone */ } }
    this.watchers = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
  }
}
