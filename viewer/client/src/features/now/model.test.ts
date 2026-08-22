/**
 * Now, as data.
 *
 * ## What is worth asserting here, and what deliberately is not
 *
 * The inbox's CONTENT is the server's decision — which item exists, how loud
 * it is, what was tried, which remedies apply — and `viewer/test/inbox.test.ts`
 * pins all of it against the builder that makes it. Re-asserting "an auth wall
 * leads with sign-in" here, against an item this file hand-built to lead with
 * sign-in, would be a test of the fixture.
 *
 * So these are the rules the CLIENT owns:
 *
 *  - which action a row LEADS with, given what the server sent;
 *  - what the badge counts, and what it deliberately does not;
 *  - which lanes are "running now", and in what order;
 *  - why nothing is running when nothing is;
 *  - and the whole departures ranking, moved here from `views/ready/model.ts`
 *    with its cases — the properties that are invisible until they are wrong.
 */

import { describe, expect, it } from 'vitest';
import type { ForeignSession, InboxItem, PlanDetail, PlanSummaryFull, RunState } from '@/lib/api';
import {
  NO_FILTERS,
  applyFilters,
  idleReason,
  inboxCounts,
  isClaimed,
  isLiveRun,
  load,
  needsYouCount,
  nowLanes,
  otherSessions,
  plansInFlight,
  pulseRuns,
  queueTotals,
  rank,
  splitActions,
  toDepartures,
  type Departure,
} from './model';

/* ================================================================== *
 * The inbox
 * ================================================================== */

const item = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'errand:demo:4::verify-red',
    kind: 'errand',
    severity: 'needs-you',
    slug: 'demo',
    phase: 4,
    title: 'demo — phase 4 needs you',
    need: 'The SSH key the session named.',
    how: 'Provide it, then recover.',
    since: '2026-08-20T10:00:00.000Z',
    href: '#/plan/demo/run',
    actions: [],
    ...over,
  }) as InboxItem;

const action = (verb: string, flag?: string) => ({
  verb,
  label: verb,
  endpoint: `/api/${verb}`,
  method: 'POST' as const,
  ...(flag ? { flag } : {}),
});

describe('which remedy a row leads with', () => {
  it('leads with the first the server sent — the order is its decision, not ours', () => {
    const { primary, rest } = splitActions(
      item({ actions: [action('login'), action('recheck'), action('dismiss')] }),
    );
    expect(primary?.verb).toBe('login');
    expect(rest.map((a) => a.verb)).toEqual(['recheck', 'dismiss']);
  });

  it('never leads with one this console cannot perform, but never hides it either', () => {
    // A console started without --allow-run still has to be told its run is
    // parked; hiding the button because it would not work is the dead end
    // these cards exist to end. It just stops being the one that leads.
    const { primary, rest } = splitActions(item({ actions: [action('recover', 'run'), action('dismiss')] }));
    expect(primary?.verb).toBe('dismiss');
    expect(rest.map((a) => a.verb)).toEqual(['recover']);
  });

  it('leads with nothing when every remedy is flagged, and still offers them all', () => {
    const { primary, rest } = splitActions(
      item({ actions: [action('recover', 'run'), action('freeze', 'run')] }),
    );
    expect(primary).toBeUndefined();
    expect(rest).toHaveLength(2);
  });

  it('survives an item with no actions at all — a health row is a statement', () => {
    expect(splitActions(item({ actions: [] }))).toEqual({ rest: [] });
  });
});

describe('what the badge counts', () => {
  it('counts what is waiting on a person and leaves the fyi rows out', () => {
    const items = [
      item({ id: 'a', severity: 'urgent' }),
      item({ id: 'b', severity: 'needs-you' }),
      item({ id: 'c', severity: 'fyi', kind: 'ruling' }),
      item({ id: 'd', severity: 'fyi', kind: 'lock' }),
    ];
    // A ruling worth reading and a lock nobody is queued behind are real rows
    // and neither is a person being waited on. A badge that counts them is a
    // badge that is never zero, and a badge that is never zero stops being read.
    expect(needsYouCount(items)).toBe(2);
    expect(inboxCounts(items)).toEqual({ urgent: 1, 'needs-you': 1, fyi: 2, total: 4 });
  });

  it('reads an absent inbox as zero rather than throwing', () => {
    expect(needsYouCount(undefined)).toBe(0);
    expect(inboxCounts([])).toEqual({ urgent: 0, 'needs-you': 0, fyi: 0, total: 0 });
  });
});

/* ================================================================== *
 * The lanes
 * ================================================================== */

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/tmp/demo',
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 1.25,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    activePhase: 4,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    ...over,
  }) as unknown as RunState;

const record = (over: Record<string, unknown> = {}) => ({
  phase: 4,
  status: 'running',
  attempts: 1,
  costUsd: 0.5,
  startedAt: '2026-08-20T09:30:00.000Z',
  ...over,
});

describe('which lanes are running now', () => {
  it('reads the lanes off the PHASE records, not off the live children', () => {
    // `children` holds only lanes with a process. A lane queued behind a lock
    // or parked on an external clock has none — and is exactly the one somebody
    // is asking about.
    const lanes = nowLanes([
      run({
        phases: {
          '2': record({ phase: 2, status: 'queued' }) as never,
          '4': record({ phase: 4, status: 'running' }) as never,
          '1': record({ phase: 1, status: 'done' }) as never,
        },
        children: { '4': { pid: 9, phase: 4, sessionId: 's4', startedAt: '2026-08-20T09:30:00.000Z' } },
      }),
    ]);
    expect(lanes.map((l) => l.phase).sort()).toEqual([2, 4]);
    expect(lanes.find((l) => l.phase === 4)?.child?.sessionId).toBe('s4');
    expect(lanes.find((l) => l.phase === 2)?.child).toBeUndefined();
  });

  it('draws nothing for a run with no loop behind it', () => {
    expect(nowLanes([run({ status: 'halted', phases: { '4': record() as never } })])).toEqual([]);
    expect(nowLanes([run({ status: 'finished', phases: { '4': record() as never } })])).toEqual([]);
  });

  it('ignores the plan-wide slot a numeric key filter is the only guard against', () => {
    const lanes = nowLanes([
      run({ phases: { plan: record({ phase: 0, status: 'running' }) as never } as never }),
    ]);
    expect(lanes).toEqual([]);
  });

  it('puts a stalled lane above a healthy one however long the healthy one has run', () => {
    const lanes = nowLanes([
      run({
        phases: {
          '2': record({
            phase: 2,
            startedAt: '2026-08-20T06:00:00.000Z',
          }) as never,
          '4': record({
            phase: 4,
            startedAt: '2026-08-20T09:59:00.000Z',
            liveness: {
              phase: 4,
              lastOutputAt: '2026-08-20T09:10:00.000Z',
              turnsSinceLastTool: 0,
              commitsSinceStart: 0,
              treeDirty: false,
              stall: { signal: 'silent', since: '2026-08-20T09:20:00.000Z', detail: 'nothing' },
            },
          }) as never,
        },
      }),
    ]);
    // The whole reason to look at this list is to find the one not working.
    expect(lanes.map((l) => l.phase)).toEqual([4, 2]);
  });

  it('orders equals oldest first, and a lane with no clock last', () => {
    const lanes = nowLanes([
      run({
        phases: {
          '2': record({ phase: 2, startedAt: '2026-08-20T09:00:00.000Z' }) as never,
          '3': record({ phase: 3, startedAt: undefined }) as never,
          '4': record({ phase: 4, startedAt: '2026-08-20T08:00:00.000Z' }) as never,
        },
        children: {},
      }),
    ]);
    expect(lanes.map((l) => l.phase)).toEqual([4, 2, 3]);
  });

  it('takes the title and the ETA from the plan detail, and says when it has neither', () => {
    const bare = nowLanes([run({ phases: { '4': record() as never } })])[0];
    expect(bare.enriched).toBe(false);
    expect(bare.title).toBeUndefined();
    expect(bare.eta).toBeUndefined();

    const detail = {
      summary: { title: 'Demo plan' },
      phases: [{ phase: 4, title: 'Wire the ingest' }],
      // The SERVER's estimate. Nothing here multiplies a weight by a rate: that
      // rule lives in `analysis/stats.ts` and a second copy would disagree.
      eta: {
        plan: null,
        perPhase: [{ phase: 4, weight: 40_000, estMs: 3_600_000, basis: 'plan', label: '1h' }],
      },
    } as unknown as PlanDetail;
    const full = nowLanes([run({ phases: { '4': record() as never } })], new Map([['demo', detail]]))[0];
    expect(full.enriched).toBe(true);
    expect(full.title).toBe('Wire the ingest');
    expect(full.planTitle).toBe('Demo plan');
    expect(full.eta?.label).toBe('1h');
  });
});

describe('why nothing is running', () => {
  const base = { allowRun: true, signedOut: false, ready: 0, queued: 0, needsYou: 0 };

  it('names the wall before anything else — nothing starts under a signed-out login', () => {
    expect(idleReason({ ...base, signedOut: true, ready: 5 }).headline).toContain('signed out');
  });

  it('says a read-only console cannot start anything rather than offering to', () => {
    expect(idleReason({ ...base, allowRun: false, ready: 5 }).headline).toContain('cannot start');
  });

  it('distinguishes queued, waiting-on-you, ready and genuinely nothing', () => {
    expect(idleReason({ ...base, queued: 2 }).detail).toContain('queued');
    expect(idleReason({ ...base, needsYou: 1 }).detail).toContain('waiting on you');
    expect(idleReason({ ...base, ready: 3 }).detail).toContain('Next up');
    expect(idleReason(base).detail).toContain('Nothing is ready');
  });
});

/* ================================================================== *
 * The runs and sessions the Pulse used to draw
 * ================================================================== */

const foreign = (over: Partial<ForeignSession> = {}): ForeignSession =>
  ({
    sessionId: 's',
    kind: 'foreign',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    turns: 1,
    presence: 'live',
    ...over,
  }) as ForeignSession;

describe('pulseRuns', () => {
  it('keeps one run per plan — the newest — and drops what settled over a day ago', () => {
    const NOW = Date.UTC(2026, 7, 20, 12);
    const fresh = new Date(NOW - 60_000).toISOString();
    const stale = new Date(NOW - 48 * 3_600_000).toISOString();
    const rows = pulseRuns(
      [
        run({ id: 'a-old', slug: 'alpha', status: 'finished', updatedAt: stale }),
        run({ id: 'b', slug: 'beta', status: 'finished', updatedAt: fresh }),
        run({ id: 'c', slug: 'gamma', status: 'running', updatedAt: fresh }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.slug)).toEqual(['gamma', 'beta']);
  });
});

describe('isLiveRun', () => {
  it('counts the states with a loop behind them, nothing else', () => {
    expect(isLiveRun(run({ status: 'running' }))).toBe(true);
    expect(isLiveRun(run({ status: 'frozen' }))).toBe(true);
    expect(isLiveRun(run({ status: 'queued' }))).toBe(true);
    expect(isLiveRun(run({ status: 'halted' }))).toBe(false);
    expect(isLiveRun(undefined)).toBe(false);
  });
});

describe('otherSessions', () => {
  it('lists live sessions no lane draws, and what ended within the hour, live first', () => {
    const now = Date.now();
    const lanes = [{ slug: 'demo', child: { pid: 1, phase: 4, sessionId: 'own-4', startedAt: '' } }];
    const sessions = [
      foreign({ sessionId: 'drawn', plan: { slug: 'demo', phase: 3, strong: true } }),
      foreign({ sessionId: 'own-4', plan: { slug: 'demo', phase: 4, strong: true } }),
      foreign({ sessionId: 'no-plan' }),
      foreign({ sessionId: 'other-plan', plan: { slug: 'beta', phase: 1, strong: true } }),
      foreign({
        sessionId: 'just-left',
        presence: 'ended',
        endedAt: new Date(now - 5 * 60_000).toISOString(),
        lastSeen: new Date(now - 5 * 60_000).toISOString(),
      }),
      foreign({
        sessionId: 'long-gone',
        presence: 'ended',
        endedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      }),
      foreign({ sessionId: 'unknown', presence: 'unknown' }),
    ];
    const ids = otherSessions(sessions, lanes, now).map((s) => s.sessionId);
    expect(ids.slice(0, 2).sort()).toEqual(['no-plan', 'other-plan']);
    expect(ids[2]).toBe('just-left');
    expect(ids).not.toContain('drawn');
    expect(ids).not.toContain('own-4');
    expect(ids).not.toContain('long-gone');
    expect(ids).not.toContain('unknown');
    expect(otherSessions(undefined, lanes, now)).toEqual([]);
  });
});

/* ================================================================== *
 * Next up — the departures board's own cases, moved with it
 * ================================================================== */

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull => ({
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  activity: Date.UTC(2026, 7, 3),
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [],
  mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
  ...over,
});

const detail = (phases: unknown[]): PlanDetail => ({ phases }) as unknown as PlanDetail;

const phaseView = (over: Record<string, unknown> = {}) => ({
  phase: 2,
  title: 'Wire the ingest',
  state: 'ready',
  size: 'M',
  weight: 40_000,
  gated: false,
  bullets: [],
  analysis: { unblocks: 3, onCriticalPath: true, weight: 40_000 },
  ...over,
});

const NOW = Date.UTC(2026, 7, 3, 12);

describe('building the queue', () => {
  it('reads ready as phase numbers, not objects', () => {
    // The whole defect in one assertion: the wire shape is `[2]`, and a row
    // built from it must still know it is phase 2.
    const [d] = toDepartures([plan({ ready: [2] })], new Map(), NOW);
    expect(d.phase).toBe(2);
    expect(d.key).toBe('alpha#2');
  });

  it('renders a row before the plan detail lands, then upgrades it', () => {
    const bare = toDepartures([plan()], new Map(), NOW)[0];
    expect(bare.enriched).toBe(false);
    expect(bare.title).toBeUndefined();
    expect(bare.onCriticalPath).toBe(true);

    const full = toDepartures(
      [plan({ nextBest: { phase: 2, unblocks: 3 } })],
      new Map([['alpha', detail([phaseView()])]]),
      NOW,
    )[0];
    expect(full.enriched).toBe(true);
    expect(full.title).toBe('Wire the ingest');
    expect(full.unblocks).toBe(3);
  });

  it('counts idle days from the plan activity', () => {
    const [d] = toDepartures([plan({ activity: NOW - 9 * 86_400_000 })], new Map(), NOW);
    expect(d.idleDays).toBe(9);
  });

  it('treats an expired lease as unclaimed', () => {
    expect(isClaimed({ owner: 'someone', expired: false })).toBe(true);
    expect(isClaimed({ owner: 'someone', expired: true })).toBe(false);
    expect(isClaimed(undefined)).toBe(false);
  });

  it('never boards a closed plan, whichever terminal word it uses', () => {
    for (const status of ['complete', 'abandoned', 'superseded']) {
      expect(toDepartures([plan({ status, ready: [2, 3] })], new Map(), NOW)).toEqual([]);
    }
  });

  it('reads the server’s closed flag ahead of the status word', () => {
    expect(toDepartures([plan({ status: 'shelved', closed: true, ready: [2] })], new Map(), NOW)).toEqual([]);
    expect(
      toDepartures([plan({ status: 'shelved', closed: false, ready: [2] })], new Map(), NOW),
    ).toHaveLength(1);
  });

  it('leaves a closed plan out of the queue totals', () => {
    const summaries = [
      plan({ slug: 'gone', status: 'abandoned', ready: [1, 2], remainingSessions: 5 }),
      plan({ slug: 'live', ready: [2], remainingSessions: 2 }),
    ];
    const totals = queueTotals(toDepartures(summaries, new Map(), NOW), summaries);
    expect(totals).toMatchObject({ phases: 1, plans: 1, sessions: 2 });
  });
});

describe('ranking', () => {
  const queue = (): Departure[] =>
    toDepartures(
      [
        plan({ slug: 'heavy', ready: [1], activity: NOW - 86_400_000, budget: 200_000 }),
        plan({ slug: 'light', ready: [1], activity: NOW, budget: 200_000 }),
        plan({ slug: 'stale', ready: [1], activity: NOW - 30 * 86_400_000, budget: 200_000 }),
      ],
      new Map([
        [
          'heavy',
          detail([
            phaseView({
              phase: 1,
              weight: 90_000,
              analysis: { unblocks: 5, onCriticalPath: false, weight: 90_000 },
            }),
          ]),
        ],
        [
          'light',
          detail([
            phaseView({
              phase: 1,
              weight: 15_000,
              analysis: { unblocks: 1, onCriticalPath: false, weight: 15_000 },
            }),
          ]),
        ],
        [
          'stale',
          detail([
            phaseView({
              phase: 1,
              weight: 40_000,
              analysis: { unblocks: 2, onCriticalPath: true, weight: 40_000 },
            }),
          ]),
        ],
      ]),
      NOW,
    );

  it('the five orders genuinely differ — a shared first row would be one sort with five labels', () => {
    expect(rank(queue(), 'leverage')[0].slug).toBe('heavy');
    expect(rank(queue(), 'critical')[0].slug).toBe('stale');
    expect(rank(queue(), 'quick')[0].slug).toBe('light');
    expect(rank(queue(), 'momentum')[0].slug).toBe('light');
    expect(rank(queue(), 'unstick')[0].slug).toBe('stale');
  });

  it('sinks a claimed phase below every unclaimed one, in every order', () => {
    const claimedQueue = toDepartures(
      [
        plan({ slug: 'taken', ready: [1], locks: [{ phase: 1, owner: 'other', expired: false }] }),
        plan({ slug: 'free', ready: [1] }),
      ],
      new Map([
        // The claimed one is the better move on every other measure, which is
        // exactly the case that must not win.
        [
          'taken',
          detail([
            phaseView({
              phase: 1,
              weight: 15_000,
              analysis: { unblocks: 9, onCriticalPath: true, weight: 15_000 },
            }),
          ]),
        ],
        [
          'free',
          detail([
            phaseView({
              phase: 1,
              weight: 90_000,
              analysis: { unblocks: 0, onCriticalPath: false, weight: 90_000 },
            }),
          ]),
        ],
      ]),
      NOW,
    );
    for (const order of ['leverage', 'critical', 'quick', 'momentum', 'unstick'] as const) {
      expect(rank(claimedQueue, order)[0].slug, order).toBe('free');
    }
  });

  it('sorts an unsized phase last rather than as weightless', () => {
    const mixed = toDepartures(
      [plan({ slug: 'sized', ready: [1] }), plan({ slug: 'unsized', ready: [1] })],
      new Map([
        [
          'sized',
          detail([
            phaseView({
              phase: 1,
              weight: 90_000,
              analysis: { unblocks: 0, onCriticalPath: false, weight: 90_000 },
            }),
          ]),
        ],
      ]),
      NOW,
    );
    expect(rank(mixed, 'quick').map((d) => d.slug)).toEqual(['sized', 'unsized']);
  });
});

describe('filtering and load', () => {
  const queue = () =>
    toDepartures(
      [
        plan({ slug: 'a', ready: [1], repos: ['hub'], locks: [{ phase: 1, owner: 'x', expired: false }] }),
        plan({ slug: 'b', ready: [1], repos: ['aws', 'hub'] }),
      ],
      new Map([['b', detail([phaseView({ phase: 1, gated: true })])]]),
      NOW,
    );

  it('hides claimed phases, and gated phases, on request', () => {
    expect(applyFilters(queue(), { ...NO_FILTERS, unclaimed: true }).map((d) => d.slug)).toEqual(['b']);
    expect(applyFilters(queue(), { ...NO_FILTERS, open: true }).map((d) => d.slug)).toEqual(['a']);
  });

  it('counts what the board is showing', () => {
    const totals = queueTotals(queue(), [
      plan({ slug: 'a', remainingSessions: 2 }),
      plan({ slug: 'b', remainingSessions: 3 }),
    ]);
    expect(totals).toMatchObject({ phases: 2, plans: 2, claimed: 1, gated: 1, sessions: 5 });
  });

  it('reads a weight as a fraction of the plan budget, and says when it is over', () => {
    expect(load(40_000, 200_000)).toMatchObject({ fraction: 0.2, short: '20%', over: false });
    const over = load(300_000, 200_000);
    expect(over.over).toBe(true);
    expect(over.short).toBe('over');
    // Clamped for drawing — a bar cannot be 150% wide — but the label still says so.
    expect(over.fraction).toBe(1);
    expect(load(undefined, 200_000).fraction).toBeNull();
    expect(load(40_000, 0).fraction).toBeNull();
  });
});

describe('plans in flight', () => {
  it('takes the open, unfinished plans, most recently active first', () => {
    const rows = plansInFlight(
      [
        plan({ slug: 'done', done: 4, phases: 4, activity: NOW }),
        plan({ slug: 'shut', status: 'abandoned', done: 1, activity: NOW }),
        plan({ slug: 'old', done: 1, activity: NOW - 86_400_000 }),
        plan({ slug: 'new', done: 1, activity: NOW }),
        plan({ slug: 'doc', kind: 'document', done: 1, activity: NOW }),
      ],
      6,
    );
    // `done < phases` alone is true of every abandoned plan ever written, which
    // is how the old dashboard opened on a wall of plans nobody is returning to.
    expect(rows.map((p) => p.slug)).toEqual(['new', 'old']);
  });

  it('respects the limit — a strip is one engine read', () => {
    const many = Array.from({ length: 9 }, (_, i) => plan({ slug: `p${i}`, activity: NOW - i }));
    expect(plansInFlight(many, 6)).toHaveLength(6);
  });
});
