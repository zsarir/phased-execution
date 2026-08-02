/**
 * What the session did, kept where a reload can find it again.
 *
 * The live console was streaming-only: events arrived over SSE and were held in
 * one React hook. Refresh the page and the window went blank; open it after a
 * phase finished and there was nothing to see at all, because the only copy of
 * a session's output had been in a browser tab that no longer existed. For a
 * page whose job is answering "what is it doing?", showing nothing is the one
 * unacceptable answer — and "it already happened" is not a reason to have
 * thrown it away.
 *
 * So the same events are appended here as they are broadcast, and the console
 * hydrates from this before subscribing. This is the server-side ring the SSE
 * literature recommends behind `Last-Event-ID`, written to disk rather than
 * held in memory so it also survives the console restarting.
 *
 * Deliberately raw: the *event* is stored, not a rendered line. Formatting
 * lives in one place in the browser (`toLine`), and duplicating it here would
 * mean a replayed run and a live one could disagree about what happened.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from '../log.ts';
import { runDir } from './state.ts';

export type TranscriptEntry = {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
};

/** Events worth replaying. Everything else is state the UI re-fetches anyway. */
const KEEP = new Set(['stream', 'phase', 'verify']);
/** A chatty phase can emit thousands of events; keep one run's file bounded. */
const MAX_BYTES = 4 * 1024 * 1024;
/** One line of console output. A pasted file is not a console line. */
const MAX_TEXT = 4_000;

export function transcriptFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.log.jsonl`);
}

export class Transcript {
  readonly path: string;
  private seq = 0;
  private full = false;

  constructor(root: string, slug: string, id: string) {
    this.path = transcriptFile(root, slug, id);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.seq = this.read().at(-1)?.seq ?? 0;
    } catch {
      /* a transcript we cannot open costs the replay, never the run */
    }
  }

  /** Returns false when the event was not one worth keeping. */
  append(event: string, data: Record<string, unknown>): boolean {
    if (!KEEP.has(event) || this.full) return false;
    const entry: TranscriptEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      event,
      data: trim(data),
    };
    try {
      if (statSync(this.path).size > MAX_BYTES) {
        this.full = true;
        log.warn('transcript.full', { path: this.path, note: 'run continues; the live view still streams' });
        return false;
      }
    } catch {
      /* no file yet — the normal first append */
    }
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch (error) {
      log.warn('transcript.append', { path: this.path, error });
      return false;
    }
  }

  read(limit?: number): TranscriptEntry[] {
    return readTranscript(this.path, limit);
  }
}

export function readTranscript(path: string, limit = 400): TranscriptEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (limit && lines.length > limit) lines = lines.slice(-limit);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as TranscriptEntry); } catch { /* half-written tail */ }
  }
  return entries;
}

/** Keep long values from turning one console line into a log file. */
function trim(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === 'string' && value.length > MAX_TEXT
      ? `${value.slice(0, MAX_TEXT)}… (${value.length - MAX_TEXT} more characters)`
      : value;
  }
  return out;
}
