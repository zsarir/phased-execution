/**
 * The third artefact of the trio: the durable `project_<slug>` memory entry.
 *
 * Memory lives outside the source directory, under the Claude home(s), and the
 * plan's `memory:` key may point at a pre-existing entry whose name differs
 * from the slug. Both spellings are searched — `project_<slug>.md` and
 * `project-<slug>.md` — because both exist in the wild.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { safeList } from './config.ts';

export type MemoryEntry = {
  key: string;
  path: string;
  text: string;
  mtime: number;
};

/** Every `<claude-home>/projects/<project>/memory` directory on this machine. */
export function memoryDirs(): string[] {
  const home = homedir();
  const homes = safeList(home).filter((name) => /^\.claude(-[a-z0-9]+)?$/.test(name)).map((n) => join(home, n));
  const dirs: string[] = [];
  for (const claudeHome of homes) {
    const projects = join(claudeHome, 'projects');
    for (const project of safeList(projects)) {
      const dir = join(projects, project, 'memory');
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function candidates(key: string): string[] {
  const bare = key.replace(/^project[_-]/, '');
  return [`${key}.md`, `project_${bare}.md`, `project-${bare}.md`, `${bare}.md`];
}

export function findMemory(key: string, dirs = memoryDirs()): MemoryEntry | undefined {
  for (const dir of dirs) {
    for (const name of candidates(key)) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        return { key, path, text: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs };
      } catch { /* unreadable memory is simply absent */ }
    }
  }
  return undefined;
}

/** The `MEMORY.md` index line(s) mentioning this key, for the "linked from" note. */
export function memoryIndexLines(key: string, dirs = memoryDirs()): string[] {
  const bare = key.replace(/^project[_-]/, '');
  const out: string[] = [];
  for (const dir of dirs) {
    const path = join(dir, 'MEMORY.md');
    if (!existsSync(path)) continue;
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.includes(bare) && line.trim().startsWith('-')) out.push(line.trim());
      }
    } catch { /* ignore */ }
  }
  return out;
}
