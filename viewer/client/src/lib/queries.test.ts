/**
 * The data-plane guard.
 *
 * The failure this prevents is quiet: the server grows an event, nothing on the
 * client listens for it, and a screen simply stops updating for that one case —
 * with no error, no console warning, and a page that looks alive. Making the
 * event→effect table total, and asserting it, turns that into a red test.
 */

import { describe, expect, it } from 'vitest';
import { SSE_EVENTS } from './sse';
import { EVENT_EFFECTS, keys, shellCounts } from './queries';

describe('SSE → Query bridge', () => {
  it('has an effect for every event the server can emit', () => {
    const missing = SSE_EVENTS.filter((name) => !(name in EVENT_EFFECTS));
    expect(missing, `unhandled events: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no effect for an event that does not exist', () => {
    const extra = Object.keys(EVENT_EFFECTS).filter(
      (name) => !(SSE_EVENTS as readonly string[]).includes(name),
    );
    expect(extra, `phantom events: ${extra.join(', ')}`).toEqual([]);
  });

  it('carries the 15 wire names, run events included', () => {
    expect(SSE_EVENTS).toHaveLength(15);
    // The runner prefixes its own events (`server/runner/runner.ts` emits
    // `run:` + event). Listening for `phase` instead of `run:phase` is the
    // mistake this pins down.
    for (const name of ['run:run', 'run:phase', 'run:stream', 'run:journal', 'run:verify', 'run:state']) {
      expect(SSE_EVENTS).toContain(name);
    }
    // `hello` is the handshake frame, not a change notification.
    expect(SSE_EVENTS).not.toContain('hello');
  });

  it('keeps the firehose out of the cache', () => {
    // These two arrive many times a second while a phase is talking; routing
    // them through invalidation would refetch the run object per line.
    expect(EVENT_EFFECTS['run:stream'].streamOnly).toBe(true);
    expect(EVENT_EFFECTS['run:journal'].streamOnly).toBe(true);
  });

  it('makes a file change reach the board', () => {
    const changed = EVENT_EFFECTS.changed;
    expect(changed.invalidate).toContainEqual(keys.plans());
    expect(changed.slugScoped).toBe('plan');
  });

  it('treats a warm as everything being suspect', () => {
    expect(EVENT_EFFECTS.warm.all).toBe(true);
  });
});

describe('shellCounts', () => {
  it('counts plans, phases, ready and pending approvals', () => {
    const counts = shellCounts(
      [
        { slug: 'a', kind: 'plan', phases: 8, ready: [1, 2] },
        { slug: 'b', kind: 'plan', phases: 3, ready: [] },
        { slug: 'c', kind: 'document', phases: 0, ready: [] },
      ],
      [{ id: '1', status: 'pending' }, { id: '2', status: 'resolved' }],
      4,
    );
    expect(counts).toEqual({ plans: 2, phases: 11, ready: 2, approvals: 1, unread: 4 });
  });

  it('survives an empty cache', () => {
    expect(shellCounts(undefined, undefined, 0))
      .toEqual({ plans: 0, phases: 0, ready: 0, approvals: 0, unread: 0 });
  });
});
