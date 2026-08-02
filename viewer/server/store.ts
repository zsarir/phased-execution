/**
 * The in-memory model of one source directory.
 *
 * Everything the console shows is derived from this store: plans, their
 * handoff folders, INDEX rows, QA rows and locks, each with the modification
 * time that drives the default "latest activity" sort. The watcher calls
 * `refresh()` with the paths that changed, which re-reads only those files and
 * bumps the plan's revision so cached engine answers for it drop.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { safeList, type RootCheck } from './config.ts';
import { parsePlan, type Plan } from './parse/plan.ts';
import { parseHandoff, parseHandoffFilename, type Handoff } from './parse/handoff.ts';
import { parseIndex, parseTestStatus, parseLock, type IndexRow, type QaRow, type Lock } from './parse/folder.ts';

export type PlanRecord = {
  slug: string;
  /** A plan has a phase graph; a document lives in the same folder without one. */
  kind: 'plan' | 'document' | 'orphan-handoffs';
  plan?: Plan;
  planPath?: string;
  planMtime: number;
  handoffDir?: string;
  handoffs: Handoff[];
  index: IndexRow[];
  qa: QaRow[];
  locks: Lock[];
  /** Newest mtime across the plan and every handoff artefact — the sort key. */
  activity: number;
  bytes: number;
  revision: number;
};

export class Store {
  readonly root: RootCheck;
  private records = new Map<string, PlanRecord>();
  private revisionSeed = 0;
  /** Bumped on every structural change, so clients can cheaply detect staleness. */
  generation = 0;

  constructor(root: RootCheck) {
    this.root = root;
  }

  list(): PlanRecord[] {
    return [...this.records.values()];
  }

  get(slug: string): PlanRecord | undefined {
    return this.records.get(slug);
  }

  scan(): void {
    this.records.clear();
    const { plansDir, handoffsDir } = this.root;

    for (const file of plansDir ? safeList(plansDir) : []) {
      if (!file.endsWith('.md') || file === 'README.md') continue;
      const slug = file.replace(/\.md$/, '');
      this.records.set(slug, this.readPlan(slug, join(plansDir!, file)));
    }

    for (const dir of handoffsDir ? safeList(handoffsDir) : []) {
      const full = join(handoffsDir!, dir);
      if (dir.startsWith('.') || !isDir(full)) continue;
      const existing = this.records.get(dir);
      if (existing) { this.attachHandoffs(existing, full); continue; }
      const record = this.emptyRecord(dir, 'orphan-handoffs');
      this.attachHandoffs(record, full);
      this.records.set(dir, record);
    }

    this.generation++;
  }

  /** Re-read the plans touched by these paths. Returns the affected slugs. */
  refresh(paths: string[]): string[] {
    const slugs = new Set<string>();
    for (const path of paths) {
      const slug = this.slugForPath(path);
      if (slug) slugs.add(slug);
    }

    // A new or deleted plan/folder changes the roster, so rescan wholesale.
    const structural = paths.some((p) => {
      const slug = this.slugForPath(p);
      return !slug || (!this.records.has(slug) && /\.md$/.test(p));
    });
    if (structural) { this.scan(); return [...this.records.keys()]; }

    for (const slug of slugs) {
      const previous = this.records.get(slug);
      const planPath = previous?.planPath ?? (this.root.plansDir ? join(this.root.plansDir, `${slug}.md`) : undefined);
      const record = planPath && existsSync(planPath)
        ? this.readPlan(slug, planPath)
        : this.emptyRecord(slug, 'orphan-handoffs');
      const dir = this.root.handoffsDir ? join(this.root.handoffsDir, slug) : undefined;
      if (dir && existsSync(dir)) this.attachHandoffs(record, dir);
      record.revision = ++this.revisionSeed;
      this.records.set(slug, record);
    }
    this.generation++;
    return [...slugs];
  }

  private slugForPath(path: string): string | undefined {
    const { plansDir, handoffsDir } = this.root;
    if (plansDir && path.startsWith(plansDir)) {
      const file = basename(path);
      return file.endsWith('.md') ? file.replace(/\.md$/, '') : undefined;
    }
    if (handoffsDir && path.startsWith(handoffsDir)) {
      const rest = path.slice(handoffsDir.length).replace(/^[/\\]/, '');
      const slug = rest.split(/[/\\]/)[0];
      return slug || undefined;
    }
    return undefined;
  }

  private emptyRecord(slug: string, kind: PlanRecord['kind']): PlanRecord {
    return {
      slug, kind, planMtime: 0, handoffs: [], index: [], qa: [], locks: [],
      activity: 0, bytes: 0, revision: ++this.revisionSeed,
    };
  }

  private readPlan(slug: string, path: string): PlanRecord {
    const record = this.emptyRecord(slug, 'document');
    try {
      const text = readFileSync(path, 'utf8');
      const stat = statSync(path);
      record.plan = parsePlan(text, slug, path);
      record.kind = record.plan.phased ? 'plan' : 'document';
      record.planPath = path;
      record.planMtime = stat.mtimeMs;
      record.activity = stat.mtimeMs;
      record.bytes = stat.size;
    } catch {
      record.kind = 'document';
    }
    return record;
  }

  private attachHandoffs(record: PlanRecord, dir: string): void {
    record.handoffDir = dir;
    record.handoffs = [];
    record.index = [];
    record.qa = [];
    record.locks = [];

    for (const file of safeList(dir)) {
      const full = join(dir, file);
      try {
        if (file === 'INDEX.md') {
          record.index = parseIndex(readFileSync(full, 'utf8'));
          record.activity = Math.max(record.activity, statSync(full).mtimeMs);
        } else if (file === 'test-status.md') {
          record.qa = parseTestStatus(readFileSync(full, 'utf8'));
          record.activity = Math.max(record.activity, statSync(full).mtimeMs);
        } else if (file === '.locks') {
          for (const lockFile of safeList(full)) {
            const lock = parseLock(readFileSync(join(full, lockFile), 'utf8'), lockFile);
            if (lock) record.locks.push(lock);
            record.activity = Math.max(record.activity, statSync(join(full, lockFile)).mtimeMs);
          }
        } else if (file.endsWith('.md') && parseHandoffFilename(file).phase !== undefined) {
          const stat = statSync(full);
          record.handoffs.push(parseHandoff(readFileSync(full, 'utf8'), record.slug, file, full, stat));
          record.activity = Math.max(record.activity, stat.mtimeMs);
          record.bytes += stat.size;
        }
      } catch {
        /* a half-written file during a live edit must not break the scan */
      }
    }

    record.handoffs.sort((a, b) => a.phase - b.phase);
    record.locks.sort((a, b) => a.phase - b.phase);
  }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Handoff for a phase, or undefined. */
export function handoffFor(record: PlanRecord, phase: number): Handoff | undefined {
  return record.handoffs.find((h) => h.phase === phase);
}

/** Live (non-expired) lock on a phase, or undefined. */
export function lockFor(record: PlanRecord, phase: number): Lock | undefined {
  return record.locks.find((l) => l.phase === phase && !l.expired) ?? record.locks.find((l) => l.phase === phase);
}

export function qaFor(record: PlanRecord, phase: number): QaRow | undefined {
  return record.qa.find((q) => q.phase === phase);
}
