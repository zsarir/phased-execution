/**
 * The client's reading of closure.
 *
 * This predicate has two siblings by necessity — `plan_is_closed()` in
 * `scripts/phase-graph.sh` and `isClosedStatus()` in
 * `server/analysis/stats.ts` — because bash and the server each need the answer
 * before the other can give it. Three implementations of one rule is two too
 * many to leave unpinned, so the vocabulary is asserted here explicitly rather
 * than only through the surfaces that consume it.
 */

import { describe, expect, it } from 'vitest';
import { CLOSED_STATUSES, closedTitle, isClosed, isClosedStatus } from './closure';

describe('the closed vocabulary', () => {
  it('is exactly the three terminal words the engine uses', () => {
    // Pinned as a set, not a length: adding a fourth word is a decision that has
    // to be made in bash, in the server and here at once, and this is where a
    // client that quietly learned one on its own gets caught.
    expect([...CLOSED_STATUSES].sort()).toEqual(['abandoned', 'complete', 'superseded']);
  });

  it('counts complete as closed — deliberately, and for every finished plan at once', () => {
    expect(isClosedStatus('complete')).toBe(true);
  });

  it('does not close a plan that is merely not active', () => {
    for (const word of ['active', 'proposal', 'backlog', 'approved', 'unknown', '']) {
      expect(isClosedStatus(word)).toBe(false);
    }
    expect(isClosedStatus(undefined)).toBe(false);
  });

  it('reads the word the way a hand-edited file writes it', () => {
    // Six plans in this source were marked by hand before the verb existed.
    expect(isClosedStatus(' Abandoned ')).toBe(true);
    expect(isClosedStatus('SUPERSEDED')).toBe(true);
  });
});

describe('reading a plan', () => {
  it('prefers the server’s own flag to the status word', () => {
    // So a server that learns a new terminal word does not have to wait for the
    // client to agree with it — and cannot be contradicted by it mid-release.
    expect(isClosed({ status: 'shelved', closed: true })).toBe(true);
    expect(isClosed({ status: 'abandoned', closed: false })).toBe(false);
  });

  it('falls back to the word when the flag is absent', () => {
    expect(isClosed({ status: 'abandoned' })).toBe(true);
    expect(isClosed({ status: 'active' })).toBe(false);
  });

  it('is false for nothing at all rather than throwing', () => {
    // Every caller here reads from a query that may not have resolved.
    expect(isClosed(undefined)).toBe(false);
    expect(isClosed({})).toBe(false);
  });
});

describe('the badge tooltip', () => {
  it('leads with what the status word means, then the reason, then the date', () => {
    const title = closedTitle({
      status: 'superseded',
      closed: true,
      closedReason: 'replaced by console-operability',
      closedOn: '2026-08-05',
    });
    expect(title).toContain('Another plan took this one over.');
    expect(title).toContain('replaced by console-operability');
    expect(title).toContain('Closed 2026-08-05');
    expect(title).toContain('Reopen');
  });

  it('still explains itself when the plan was closed by hand with no reason', () => {
    const title = closedTitle({ status: 'abandoned', closed: true });
    expect(title).toContain('Work stopped here deliberately');
    expect(title).toContain('Reopen');
  });
});
