/**
 * The run journal: append-only, one NDJSON line per thing that happened.
 *
 * It serves two jobs that pull in the same direction. It is the audit trail —
 * what ran, what it cost, which gate opened, who approved it — and it is what a
 * restarted console reads to explain a run it did not start. The checkpoint in
 * `state.ts` says where a run *is*; the journal says how it got there, which is
 * the question anyone actually asks after something goes wrong.
 *
 * Appends are synchronous for the same reason the console log is: the entries
 * worth having are the ones written just before something dies.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from '../log.ts';
import { journalFile } from './state.ts';

export type JournalEntry = {
  seq: number;
  time: string;
  event: string;
  phase?: number;
  data?: Record<string, unknown>;
};

/** A single phase can emit a lot of tool traffic; keep one run's file sane. */
const MAX_BYTES = 32 * 1024 * 1024;

export class Journal {
  readonly path: string;
  private seq = 0;
  private overflowed = false;

  constructor(root: string, slug: string, id: string) {
    this.path = journalFile(root, slug, id);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Resuming an existing run continues its numbering rather than restarting
      // at 1, so the file stays readable as one sequence.
      this.seq = this.read().at(-1)?.seq ?? 0;
    } catch {
      /* a journal we cannot open costs the audit trail, never the run */
    }
  }

  append(event: string, data?: Record<string, unknown>, phase?: number): JournalEntry {
    const entry: JournalEntry = {
      seq: ++this.seq,
      time: new Date().toISOString(),
      event,
      ...(phase === undefined ? {} : { phase }),
      ...(data && Object.keys(data).length ? { data } : {}),
    };
    if (this.overflowed) return entry;
    try {
      if (statSync(this.path).size > MAX_BYTES) {
        this.overflowed = true;
        log.warn('journal.full', { path: this.path, note: 'run continues; journal stopped growing' });
        return entry;
      }
    } catch {
      /* no file yet — that is the normal first append */
    }
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      log.warn('journal.append', { path: this.path, error });
    }
    return entry;
  }

  /** Every entry, oldest first. A truncated final line is skipped, not fatal. */
  read(limit?: number): JournalEntry[] {
    let lines: string[];
    try {
      lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    if (limit && lines.length > limit) lines = lines.slice(-limit);
    const entries: JournalEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as JournalEntry); } catch { /* half-written tail */ }
    }
    return entries;
  }
}
