/**
 * The other three artefacts in a handoff folder: `INDEX.md`, `test-status.md`
 * and `.locks/phase-NN.lock`.
 */

import { tableAfter, plainCell } from './markdown.ts';
import { parseScope } from '../../shared/scope.js';

export type IndexRow = { phase: number; title: string; status: string; link?: string };

/** Rows of the INDEX table; `TBD` links (planned phases) come back without one. */
export function parseIndex(text: string): IndexRow[] {
  const rows = tableAfter(text, () => true);
  const out: IndexRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    if (!/^\d+$/.test(phase)) continue;
    const linkCell = row.cells[3] ?? '';
    const link = /\]\(([^)]+)\)/.exec(linkCell)?.[1];
    out.push({
      phase: Number(phase),
      title: plainCell(row.cells[1] ?? ''),
      status: plainCell(row.cells[2] ?? '').toLowerCase(),
      link,
    });
  }
  return out;
}

export type QaResult = 'pass' | 'fail' | 'pending' | 'waived' | 'unknown';
export type QaRow = { phase: number; result: QaResult; report?: string };

const QA_VALUES: QaResult[] = ['pass', 'fail', 'pending', 'waived'];

/** Rows of `## QA status` in `test-status.md` — written by `qa-record.sh`. */
export function parseTestStatus(text: string): QaRow[] {
  const rows = tableAfter(text, (t) => /qa status/i.test(t));
  const out: QaRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    if (!/^\d+$/.test(phase)) continue;
    const value = plainCell(row.cells[1] ?? '').toLowerCase();
    const report = plainCell(row.cells[2] ?? '');
    out.push({
      phase: Number(phase),
      result: (QA_VALUES as string[]).includes(value) ? (value as QaResult) : 'unknown',
      report: report && report !== '-' ? (/\]\(([^)]+)\)/.exec(row.cells[2] ?? '')?.[1] ?? report) : undefined,
    });
  }
  return out;
}

export type Lock = {
  slug: string;
  phase: number;
  owner: string;
  host?: string;
  claimedAt?: number;
  leaseUntil?: number;
  /** Lease elapsed — `phase-lock.sh` lets another session take it over. */
  expired: boolean;
  /**
   * The repos this session is working in, from the plan's Repos column.
   *
   * Optional because it is: a lock written before scopes existed, or by a
   * `claim` that named none, has no `scope=` line. Absent means UNKNOWN, and
   * every reader has to treat unknown as colliding with everything — the
   * alternative is admitting a second session into a tree it cannot see.
   */
  scope?: string[];
  /**
   * The Claude session that holds it — `session=`, written by `phase-lock.sh
   * claim` from `--session` / `$PE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`.
   * Absent on locks older than the line, or claimed by a session that did not
   * know its id: the reader then falls back to lease rules. Present, it is the
   * key the session registry answers presence for — a lock whose session has
   * ended is debris now, not at lease end.
   */
  session?: string;
  file: string;
};

/** `key=value` lock file written by `phase-lock.sh claim`. */
export function parseLock(text: string, file: string, now = Date.now()): Lock | null {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) values[m[1]] = m[2].trim();
  }
  const phase = Number.parseInt(values.phase ?? '', 10);
  if (!Number.isFinite(phase)) return null;

  const leaseUntil = Number.parseInt(values.lease_until ?? '', 10);
  const claimedAt = Number.parseInt(values.claimed_at ?? '', 10);

  const scope = values.scope ? parseScope(values.scope) : [];

  return {
    slug: values.slug ?? '',
    phase,
    owner: values.owner ?? 'unknown',
    host: values.host,
    claimedAt: Number.isFinite(claimedAt) ? claimedAt * 1000 : undefined,
    leaseUntil: Number.isFinite(leaseUntil) ? leaseUntil * 1000 : undefined,
    expired: Number.isFinite(leaseUntil) ? leaseUntil * 1000 < now : false,
    scope: scope.length ? scope : undefined,
    ...(values.session ? { session: values.session.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || undefined } : {}),
    file,
  };
}
