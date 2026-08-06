/**
 * Carrying a session's transcript from one account's config dir to another's.
 *
 * A Claude session transcript is an account-agnostic local file at
 * `<config dir>/projects/<escaped-cwd>/<session-id>.jsonl`. Resuming it under
 * a different credential works — the CLI reads the file, the new account pays
 * for the turns — but only if the file exists in the config dir the resumed
 * process is looking at. Token accounts and the machine login share the
 * default dir, so their hand-offs are free; a PROFILE keeps its own dir, and
 * this is the copy that makes `--resume` find the conversation there.
 *
 * The escaped-cwd directory name is deliberately never re-derived: every
 * runner spawn uses the same cwd (the run's root), so the source file is
 * FOUND by its session id — a scan over `projects/*` — and its parent's
 * basename is reused verbatim on the target side. Re-implementing the CLI's
 * escaping is how this breaks the day that escaping changes.
 *
 * Failure is an answer, not an error: the caller starts a fresh session and
 * the boot prompt plus the failure context carry the continuation. Losing a
 * transcript costs re-reading; guessing wrong about one would cost the phase.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { log } from '../log.ts';

/** `<config dir>/projects/<escaped-cwd>/<sid>.jsonl`, found by id — or null. */
export function findTranscript(configDir: string, sessionId: string): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projects, entry.name));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Copy the transcript (and, best-effort, its todos sidecars) into the target
 * config dir. True when the resumed session will find its conversation there.
 */
export function portTranscript(sessionId: string, fromDir: string, toDir: string): boolean {
  if (fromDir === toDir) return true;   // same config dir — nothing to carry
  const source = findTranscript(fromDir, sessionId);
  if (!source) {
    // Already where it is going counts as carried: a run switched A→B→A finds
    // the file it left, and answering false here would discard a good resume.
    if (findTranscript(toDir, sessionId)) return true;
    log.info('accounts.transcript.not-found', { sessionId, fromDir: basename(fromDir) });
    return false;
  }
  try {
    const targetDir = join(toDir, 'projects', basename(dirname(source)));
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, join(targetDir, `${sessionId}.jsonl`));
  } catch (error) {
    log.warn('accounts.transcript.copy-failed', { sessionId, error: (error as Error).message });
    return false;
  }

  // Todos are quality-of-life, not correctness — a resume without them loses
  // a task list, not a conversation. Copied when present, shrugged at when not.
  try {
    const todos = join(fromDir, 'todos');
    const targetTodos = join(toDir, 'todos');
    for (const entry of readdirSync(todos)) {
      if (!entry.startsWith(sessionId)) continue;
      mkdirSync(targetTodos, { recursive: true });
      copyFileSync(join(todos, entry), join(targetTodos, entry));
    }
  } catch { /* no todos dir, or nothing for this session */ }

  log.info('accounts.transcript.ported', { sessionId, to: basename(toDir) });
  return true;
}
