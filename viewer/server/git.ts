/**
 * Git context for the docs tree: who last touched a plan, and whether its
 * artefacts are committed and pushed. Read-only — nothing here writes to a
 * repository.
 */

import { execFile } from 'node:child_process';
import { relative } from 'node:path';

export type GitFileInfo = {
  sha?: string;
  subject?: string;
  author?: string;
  date?: string;
  relativeDate?: string;
};

export type GitRepoInfo = {
  available: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Paths under docs/ with uncommitted changes, relative to the repo root. */
  dirty: string[];
};

const SEP = '';

function git(cwd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });
}

export async function repoInfo(root: string, docsDir?: string): Promise<GitRepoInfo> {
  const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return { available: false, dirty: [] };

  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;

  const tracking = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim();
  const counts = tracking ? tracking.split(/\s+/).map(Number) : [];

  const scope = docsDir ? [relative(root, docsDir) || '.'] : [];
  const status = await git(root, ['status', '--porcelain', '--', ...scope]);
  const dirty = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

  return { available: true, branch, ahead: counts[0], behind: counts[1], dirty };
}

/** Last commit that touched `path`. */
export async function lastCommit(root: string, path: string): Promise<GitFileInfo> {
  const format = ['%h', '%s', '%an', '%aI', '%ar'].join(SEP);
  const out = await git(root, ['log', '-1', `--format=${format}`, '--', path]);
  const [sha, subject, author, date, relativeDate] = out.trim().split(SEP);
  return sha ? { sha, subject, author, date, relativeDate } : {};
}

/**
 * The commits that touched `path`, newest first.
 *
 * Used to give a QA session somewhere concrete to start reading. A phase's
 * handoff is the one file every phase certainly writes, so the commits that
 * touched it bracket where the phase landed — the reviewer widens from there,
 * because the code itself usually lands in commits that never went near docs/.
 */
export async function commitsTouching(
  root: string, path: string, limit = 5,
): Promise<{ sha: string; subject?: string; date?: string }[]> {
  const format = ['%h', '%s', '%ad'].join(SEP);
  const out = await git(root, ['log', `-${Math.max(1, Math.min(limit, 20))}`, `--format=${format}`,
    '--date=short', '--', path]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, date] = line.split(SEP);
    return { sha, ...(subject ? { subject } : {}), ...(date ? { date } : {}) };
  }).filter((entry) => entry.sha);
}

/** Which of these paths have uncommitted changes. */
export async function uncommitted(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const out = await git(root, ['status', '--porcelain', '--', ...paths]);
  return new Set(out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean));
}
