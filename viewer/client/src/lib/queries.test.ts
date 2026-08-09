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

  it('carries the 19 wire names, run events included', () => {
    expect(SSE_EVENTS).toHaveLength(19);
    // Sessions are on the stream deliberately: the socket is a session's own
    // live channel, but the dashboard card and the nav badges do not hold it.
    expect(SSE_EVENTS).toContain('sessions');
    // Accounts ride the stream so the header meters move without polling.
    expect(SSE_EVENTS).toContain('accounts');
    // So does the MCP registry: a server that goes needs-auth changes what
    // every launch dialog may offer, and no page is holding that.
    expect(SSE_EVENTS).toContain('mcp');
    // The runner prefixes its own events (`server/runner/runner.ts` emits
    // `run:` + event). Listening for `phase` instead of `run:phase` is the
    // mistake this pins down.
    for (const name of [
      'run:run', 'run:phase', 'run:stream', 'run:journal', 'run:verify', 'run:state',
      // Admission. Its own event because it changes what the console may
      // START, which none of the others describe — a phase can sit queued for
      // minutes while nothing about any run's own state changes at all.
      'run:queue',
    ]) {
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
      [{ status: 'pending' }, { status: 'resolved' }],
      4,
    );
    expect(counts).toEqual({
      plans: 2, phases: 11, ready: 2, approvals: 1, unread: 4,
      agentSessions: 0, terminalSessions: 0, mcpAttention: 0,
    });
  });

  it('badges each session page with its own live count, ignoring ended records', () => {
    // One registry, two pages: a single number on both would read as
    // double-counting, and an ended record is history rather than something
    // running — a badge that counted it would never go back to zero.
    const counts = shellCounts(undefined, undefined, 0, [
      { kind: 'claude' },
      { kind: 'claude', exited: { code: 0 } },
      { kind: 'shell' },
      { kind: 'shell' },
      { kind: 'shell', exited: { code: 1 } },
      // A record from a server that predates `kind` is a shell.
      {},
    ]);
    expect(counts.agentSessions).toBe(1);
    expect(counts.terminalSessions).toBe(3);
  });

  // The badge links straight to the departures board, so it has to promise
  // exactly what that board will show — and the board drops closed plans. The
  // census beside it (`plans`, `phases`) keeps counting everything, the same
  // split the server makes: closing a plan quiets it, it does not delete it.
  it('leaves a closed plan out of the ready badge but keeps it in the census', () => {
    const counts = shellCounts(
      [
        { slug: 'a', kind: 'plan', phases: 8, ready: [1, 2], status: 'active' },
        { slug: 'b', kind: 'plan', phases: 4, ready: [3, 4], status: 'abandoned' },
      ],
      undefined,
      0,
    );
    expect(counts.ready).toBe(2);   // only plan a
    expect(counts.plans).toBe(2);   // census: both
    expect(counts.phases).toBe(12); // census: both
  });

  it('survives an empty cache', () => {
    expect(shellCounts(undefined, undefined, 0)).toEqual({
      plans: 0, phases: 0, ready: 0, approvals: 0, unread: 0,
      agentSessions: 0, terminalSessions: 0, mcpAttention: 0,
    });
  });
});
