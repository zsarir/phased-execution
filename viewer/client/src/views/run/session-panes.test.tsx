/**
 * Two sessions, two windows — and the proof they cannot bleed into each other.
 *
 * This is the client half of the runner pool, and its failure mode is the reason
 * it needs a test rather than a look: when the filtering is wrong nothing throws,
 * no request fails, and the page renders perfectly. It just shows two sessions'
 * sentences spliced into one paragraph, with no way for a reader to tell which
 * half belongs to which phase. "It looked right" cannot distinguish a working
 * build from a broken one here, so every case below drives BOTH lanes and asserts
 * on what the other pane did *not* get.
 *
 * The events are pushed through the real `EventSource` seam rather than by
 * calling the hook's callback, so what is under test is the whole path the
 * browser takes: named frame → `JSON.parse` → `fanOut` → predicate → fold.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys, queryClientConfig } from '@/lib/queries';
import { __resetStreamForTests } from '@/lib/sse';
import type { PhaseRecord, PhaseStatus, QueueEntry, RunState, TranscriptEntry } from '@/lib/api';
import { forPhase } from './console';
import { livePhases } from './header';
import {
  QueuedPane, SessionPanes, crossLaneId, holderLabel, laneId, lanesAcross, lanesOf,
  queueEntryFor, waitingLabel,
} from './session-panes';

/* ------------------------------------------------------------------ *
 * A stream something can actually be pushed down
 * ------------------------------------------------------------------ */

/**
 * The suite's `FakeEventSource` accepts listeners and drops them, which is right
 * for every test that only needs the console not to explode. These cases need
 * the opposite: to be the server.
 */
class DrivableEventSource {
  static latest: DrivableEventSource | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    DrivableEventSource.latest = this;
  }

  addEventListener(name: string, fn: (event: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(fn);
  }

  removeEventListener(name: string, fn: (event: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void { this.readyState = 2; }

  /** Deliver one named frame exactly as the browser would. */
  send(name: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
}

/** Push a server frame and let React flush it. */
const emit = (name: string, data: unknown) =>
  act(() => { DrivableEventSource.latest?.send(name, data); });

// Assignment, not `defineProperty`: `test-setup.ts` installs its own fake with
// `writable: true` and no `configurable`, which defaults to false — so the slot
// can be written but never redefined.
const slot = globalThis as unknown as { EventSource: unknown };
const original = slot.EventSource;

beforeEach(() => {
  __resetStreamForTests();
  DrivableEventSource.latest = null;
  slot.EventSource = DrivableEventSource;
});

afterEach(() => {
  __resetStreamForTests();
  slot.EventSource = original;
  vi.clearAllMocks();
});

/**
 * Mount with the transcript already answered, so no pane fetches one.
 *
 * `staleTime: Infinity` is the whole config, so seeded data is never refetched —
 * which keeps these cases about the live stream rather than about replay.
 */
function mount(node: React.ReactElement, transcripts: Record<string, TranscriptEntry[]> = {}) {
  const client = new QueryClient(queryClientConfig);
  for (const [key, entries] of Object.entries(transcripts)) {
    const [slug, runId] = key.split('#');
    client.setQueryData([...keys.transcript(slug!), runId ?? 'latest'], entries);
  }
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** Two panes of the same run, side by side, each labelled so it can be read alone. */
function twoLanes(runId = 'r1') {
  return mount(
    <>
      <div data-testid="pane-6">
        <SessionPanes slug="demo" runId={runId} phase={6} live allowRun={false} />
      </div>
      <div data-testid="pane-7">
        <SessionPanes slug="demo" runId={runId} phase={7} live allowRun={false} />
      </div>
    </>,
    { [`demo#${runId}`]: [] },
  );
}

const pane = (n: number) => within(screen.getByTestId(`pane-${n}`));

/* ------------------------------------------------------------------ *
 * The property the pool exists for
 * ------------------------------------------------------------------ */

describe('two lanes of one run', () => {
  it('keeps each pane to its own phase, with both driven at once', () => {
    twoLanes();

    // Interleaved deliberately. A filter that merely *ordered* correctly, or one
    // that latched onto the first phase it saw, passes a sequential fixture.
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 6, kind: 'text', text: 'six speaks' });
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 7, kind: 'text', text: 'seven speaks' });
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 6, kind: 'text', text: 'six again' });

    expect(pane(6).getByText('six speaks')).toBeInTheDocument();
    expect(pane(6).getByText('six again')).toBeInTheDocument();
    expect(pane(6).queryByText('seven speaks')).not.toBeInTheDocument();

    expect(pane(7).getByText('seven speaks')).toBeInTheDocument();
    expect(pane(7).queryByText('six speaks')).not.toBeInTheDocument();
  });

  it('ignores another RUN entirely, even on the same phase number', () => {
    // Two plans running phase 6 at once is the ordinary case for the pool, and
    // a runId-blind filter reads as "the console is duplicating lines".
    twoLanes();
    emit('run:stream', { runId: 'other', slug: 'elsewhere', phase: 6, kind: 'text', text: 'not ours' });
    expect(pane(6).queryByText('not ours')).not.toBeInTheDocument();
    expect(pane(7).queryByText('not ours')).not.toBeInTheDocument();
  });

  it('resets the task list only for the phase whose session restarted', () => {
    twoLanes();
    emit('run:stream', {
      runId: 'r1', phase: 6, kind: 'todos', items: [{ content: 'six is working', status: 'pending' }],
    });
    emit('run:stream', {
      runId: 'r1', phase: 7, kind: 'todos', items: [{ content: 'seven is working', status: 'pending' }],
    });
    expect(pane(6).getByText('six is working')).toBeInTheDocument();
    expect(pane(7).getByText('seven is working')).toBeInTheDocument();

    // `activity()` clears the list on phase+running — a new phase is a new
    // session with a new list. Unfiltered, this wipes phase 6's panel while
    // phase 6 is still working, which is a lie about a live session.
    emit('run:phase', { runId: 'r1', phase: 7, status: 'running', model: 'opus' });

    expect(pane(6).getByText('six is working')).toBeInTheDocument();
    expect(pane(7).queryByText('seven is working')).not.toBeInTheDocument();
  });

  it('routes the runner narration of a phase to that phase alone', () => {
    twoLanes();
    emit('run:verify', { runId: 'r1', phase: 7, command: 'npm test', index: 0, total: 2 });
    expect(pane(7).getByText('[1/2] npm test')).toBeInTheDocument();
    expect(pane(6).queryByText('[1/2] npm test')).not.toBeInTheDocument();
  });
});

describe('the run-level pane', () => {
  it('takes every lane of its own run, and nothing from any other', () => {
    mount(
      <div data-testid="pane-0">
        <SessionPanes slug="demo" runId="r1" live allowRun={false} />
      </div>,
      { 'demo#r1': [] },
    );
    emit('run:stream', { runId: 'r1', phase: 6, kind: 'text', text: 'six speaks' });
    emit('run:stream', { runId: 'r1', phase: 7, kind: 'text', text: 'seven speaks' });
    emit('run:stream', { runId: 'other', phase: 6, kind: 'text', text: 'not ours' });

    expect(pane(0).getByText('six speaks')).toBeInTheDocument();
    expect(pane(0).getByText('seven speaks')).toBeInTheDocument();
    expect(pane(0).queryByText('not ours')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Replay, narrowed the same way
 * ------------------------------------------------------------------ */

describe('forPhase', () => {
  const entry = (seq: number, phase?: number): TranscriptEntry => ({
    seq,
    at: '2026-08-04T00:00:00Z',
    event: 'stream',
    data: phase == null ? { kind: 'text', text: `line ${seq}` } : { phase, kind: 'text', text: `line ${seq}` },
  });

  it('keeps the lane asked for and drops the others', () => {
    const all = [entry(1, 6), entry(2, 7), entry(3, 6)];
    expect(forPhase(all, 6)?.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('keeps the run-level narration, which belongs to no lane', () => {
    // Dropping it would leave a lane's replay starting mid-sentence.
    expect(forPhase([entry(1), entry(2, 7)], 7)?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('is the identity with no phase — the run pane replays everything', () => {
    const all = [entry(1, 6), entry(2, 7)];
    expect(forPhase(all, undefined)).toBe(all);
    expect(forPhase(undefined, 6)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Which lanes exist at all
 * ------------------------------------------------------------------ */

const run = (over: Partial<RunState> = {}): RunState => ({
  id: 'r1',
  slug: 'demo',
  status: 'running',
  phases: {},
  child: null,
  activePhase: null,
  ...over,
} as unknown as RunState);

/** Phase records arrive keyed by the phase number **as a string**. */
const phases = (...records: { phase: number; status: PhaseStatus }[]): Record<string, PhaseRecord> =>
  Object.fromEntries(records.map((r) => [String(r.phase), { attempts: 1, costUsd: 0, ...r }]));

describe('lanesOf', () => {
  it('is every phase with a pane worth showing, lowest first', () => {
    const lanes = lanesOf(run({
      phases: phases(
        { phase: 7, status: 'running' },
        { phase: 2, status: 'done' },
        { phase: 4, status: 'queued' },
        { phase: 5, status: 'verifying' },
        { phase: 9, status: 'pending' },
        { phase: 3, status: 'awaiting-verification' },
      ),
    }) as RunState);

    expect(lanes.map((l) => l.phase)).toEqual([3, 4, 5, 7]);
    expect(lanes.map((l) => l.queued)).toEqual([false, true, false, false]);
  });

  it('includes a queued phase, which has no child by definition', () => {
    // The lane people most need to see is the one that looks like nothing is
    // happening — so it cannot be derived from `children`.
    const lanes = lanesOf(run({ children: {}, phases: phases({ phase: 4, status: 'queued' }) }));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.queued).toBe(true);
  });

  it('is empty for no run at all', () => {
    expect(lanesOf(null)).toEqual([]);
    expect(lanesOf(undefined)).toEqual([]);
  });

  it('keeps two plans apart in a cross-plan tab id', () => {
    const a = run({ id: 'r1', slug: 'alpha', phases: phases({ phase: 5, status: 'running' }) });
    const b = run({ id: 'r2', slug: 'beta', phases: phases({ phase: 5, status: 'running' }) });
    const lanes = lanesAcross([a, b]);

    // Same phase number, two plans: `laneId` alone would collide and Radix would
    // render one panel for two triggers.
    expect(lanes.map(laneId)).toEqual(['p5', 'p5']);
    expect(lanes.map(crossLaneId)).toEqual(['alpha:p5', 'beta:p5']);
  });
});

describe('livePhases', () => {
  it('reads every lane from children when the pool wrote them', () => {
    const child = (phase: number) => ({ pid: phase, phase, sessionId: `s${phase}`, startedAt: '' });
    expect(livePhases(run({ children: { 7: child(7), 3: child(3) } }))).toEqual([3, 7]);
  });

  it('falls back to the mirror for a run recorded before lanes existed', () => {
    const state = run({ child: { pid: 1, phase: 2, sessionId: 's', startedAt: '' } });
    expect(livePhases(state)).toEqual([2]);
    expect(livePhases(run())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Saying what a queued phase is waiting on
 * ------------------------------------------------------------------ */

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'q1',
  slug: 'demo',
  phase: 4,
  runId: 'r1',
  scope: ['packages/cart-api'],
  since: Date.now() - 90_000,
  waitingOn: [],
  bypassed: 0,
  reserving: false,
  ...over,
});

const holder = (over: Partial<QueueEntry['waitingOn'][number]> = {}) => ({
  kind: 'grant' as const,
  slug: 'other-plan',
  phase: 2,
  owner: 'claude-a/session',
  scope: ['packages/cart-api'],
  overlaps: ['packages/cart-api'],
  ...over,
});

describe('waitingLabel', () => {
  it('names the holder rather than repeating the state', () => {
    // "queued" alone is the same non-answer `pausing` used to be.
    expect(waitingLabel(entry({ waitingOn: [holder()] })))
      .toBe('queued — waiting on other-plan P2');
  });

  it('counts the rest instead of running off the end of the cell', () => {
    expect(waitingLabel(entry({ waitingOn: [holder(), holder({ slug: 'third' })] })))
      .toBe('queued — waiting on other-plan P2 +1');
  });

  it('falls back to the bare word when the scheduler has named nobody', () => {
    expect(waitingLabel(entry())).toBe('queued');
    expect(waitingLabel(undefined)).toBe('queued');
  });

  it('reports the two non-scope blocks as themselves, not as a plan', () => {
    // `kind: 'reserved'` carries `session cap` / `usage window` in the slug —
    // rendering that as "waiting on session cap P null" would be nonsense.
    expect(holderLabel('reserved', 'session cap', null)).toBe('session cap');
    expect(holderLabel('lock', 'other-plan', 3)).toBe('other-plan P3 (lock)');
    expect(holderLabel('grant', 'other-plan', null)).toBe('other-plan');
  });
});

describe('queueEntryFor', () => {
  it('matches on plan AND phase, never on either alone', () => {
    const entries = [entry(), entry({ id: 'q2', slug: 'other', phase: 4 })];
    expect(queueEntryFor(entries, 'demo', 4)?.id).toBe('q1');
    expect(queueEntryFor(entries, 'other', 4)?.id).toBe('q2');
    expect(queueEntryFor(entries, 'demo', 5)).toBeUndefined();
    expect(queueEntryFor(undefined, 'demo', 4)).toBeUndefined();
  });
});

describe('QueuedPane', () => {
  it('says what it wants, what holds it, and how long it has been there', () => {
    mount(<QueuedPane phase={4} entry={entry({ waitingOn: [holder()] })} />);

    expect(screen.getByText('Phase 4 is queued')).toBeInTheDocument();
    // Twice, and deliberately: once as the scope this phase wants, once as the
    // token that actually collided. Either alone leaves the reader guessing
    // which of several repos is the one in contention.
    expect(screen.getAllByText('packages/cart-api')).toHaveLength(2);
    expect(screen.getByText('other-plan P2')).toBeInTheDocument();
    expect(screen.getByText(/overlaps/)).toBeInTheDocument();
    expect(screen.getByText('1:30')).toBeInTheDocument();
  });

  it('still shows the declared scope before the scheduler has answered', () => {
    // The scopes endpoint answers from the plan, so the pane is never blank —
    // "queued" with nothing under it is the state this card exists to replace.
    mount(<QueuedPane phase={4} scope={['docs-site']} />);
    expect(screen.getByText('docs-site')).toBeInTheDocument();
    expect(screen.getByText(/has not answered yet/)).toBeInTheDocument();
  });

  it('says when a phase has been passed over enough to reserve its scope', () => {
    mount(<QueuedPane phase={4} entry={entry({ bypassed: 3, reserving: true })} />);
    expect(screen.getByText(/Passed over 3 time/)).toBeInTheDocument();
    expect(screen.getByText(/Now reserving its scope/)).toBeInTheDocument();
  });
});
