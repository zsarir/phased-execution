/**
 * The nine banner states, and the property the consolidation exists to give.
 *
 * The old run view could not be tested this way at all: each notice was rendered
 * at its own call site inside a 1,646-line component, so "which notices does this
 * run raise, and in what order" was not a question the code could answer without
 * mounting the whole page. `runNotes()` is a pure function, so every state can be
 * forced in one line and the ordering asserted rather than eyeballed.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NOTE_ORDER, RunStatusStack, looksLikeAuthFailure, runNotes } from './status';
import type { RunState } from '@/lib/api';

const RUN: RunState = {
  id: 'abc1234',
  slug: 'demo',
  root: '/repo',
  status: 'running',
  autonomy: 'keep-going',
  model: 'opus',
  effort: 'max',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 1.5,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: '2026-08-03T10:00:00Z',
  updatedAt: '2026-08-03T10:20:00Z',
  activePhase: 2,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: {},
};

const run = (patch: Partial<RunState>): RunState => ({ ...RUN, ...patch });

/** Every note id this run raises, in the order the stack will render them. */
const ids = (state: RunState | null, opts: { live?: boolean; allowRun?: boolean } = {}) =>
  runNotes({
    run: state,
    live: opts.live ?? true,
    allowRun: opts.allowRun ?? true,
  }).map((n) => n.id);

describe('runNotes — one slot per legacy banner', () => {
  it('raises nothing for an ordinary running run on a console that can act', () => {
    expect(ids(RUN)).toEqual([]);
  });

  /* Each case is the trigger the legacy `web/views/run.js` used, verbatim. */
  const cases: [string, RunState | null, { live?: boolean; allowRun?: boolean }][] = [
    ['halt', run({ halt: { at: '2026-08-03T10:00:00Z', reason: 'no handoff', phase: 2 } }), {}],
    ['ended', run({ status: 'finished', finishedReason: 'every phase is done' }), { live: false }],
    ['pause', run({ status: 'pausing', pause: { requestedAt: '2026-08-03T10:00:00Z', afterPhase: 2, by: 'me' } }), {}],
    ['pause', run({ status: 'paused' }), { live: false }],
    ['frozen', run({ status: 'frozen', freeze: { at: '2026-08-03T10:00:00Z', phase: 2, pid: 1, by: 'me', escalateAt: '2026-08-03T12:00:00Z' } }), {}],
    ['waiting-window', run({ status: 'waiting', waitUntil: '2026-08-03T12:00:00Z' }), {}],
    // Paused ON the limit: the policy said "pause and ask", or a restart
    // preserved the clock. The reset time is what separates it from `pause`.
    ['limit-paused', run({ status: 'paused', waitUntil: '2026-08-03T12:00:00Z', onLimit: 'pause' }), { live: false }],
    ['budget', run({ limits: { status: 'limited', window: 'five_hour', utilization: 0.82, at: 'x' } }), {}],
    ['scoped', run({ onlyPhases: [3] }), {}],
    ['profile', run({ permissionProfile: 'bypass' }), {}],
    ['read-only', RUN, { allowRun: false }],
  ];

  for (const [id, state, opts] of cases) {
    it(`raises \`${id}\` and only \`${id}\``, () => {
      expect(ids(state, opts)).toEqual([id]);
    });
  }

  it('covers every declared slot across the cases above', () => {
    const covered = new Set(cases.map(([id]) => id));
    expect([...covered].sort()).toEqual([...NOTE_ORDER].sort());
  });
});

describe('runNotes — ordering', () => {
  it('puts the notes in the declared priority, not in severity or source order', () => {
    // A halted, scoped, bypass run on a read-only console: four at once, which
    // is the case that made the old view unreadable.
    const state = run({
      status: 'halted',
      halt: { at: '2026-08-03T10:00:00Z', reason: 'stopped', phase: 1 },
      onlyPhases: [1],
      permissionProfile: 'bypass',
    });
    expect(ids(state, { live: false, allowRun: false }))
      .toEqual(['halt', 'scoped', 'profile', 'read-only']);
  });

  it('never raises both spellings of a pause', () => {
    // `pausing` and `paused` are mutually exclusive statuses sharing one slot;
    // two notes with the same id would render as a duplicate banner.
    for (const status of ['pausing', 'paused'] as const) {
      const raised = ids(run({ status }), { live: status === 'pausing' });
      expect(raised.filter((id) => id === 'pause')).toHaveLength(1);
    }
  });

  it('does not explain the ending of a run that is still going', () => {
    // Guarded on `!live`: a `finishedReason` left on a resumed run must not
    // announce that the run stopped while it is visibly running.
    expect(ids(run({ finishedReason: 'budget spent' }), { live: true })).toEqual([]);
  });

  it('leaves the ending to the halt when a run was halted', () => {
    const state = run({
      status: 'halted',
      halt: { at: '2026-08-03T10:00:00Z', reason: 'a person is needed' },
      finishedReason: 'halted',
    });
    expect(ids(state, { live: false })).toEqual(['halt']);
  });
});

describe('runNotes — the thresholds', () => {
  it('stays quiet about a usage window the account still calls allowed', () => {
    const state = run({ limits: { status: 'allowed', utilization: 0.99, at: 'x' } });
    expect(ids(state)).toEqual([]);
  });

  it('stays quiet below three quarters of the window', () => {
    const state = run({ limits: { status: 'limited', utilization: 0.74, at: 'x' } });
    expect(ids(state)).toEqual([]);
  });

  it('says nothing about a guarded profile — that is the ordinary case', () => {
    expect(ids(run({ permissionProfile: 'guarded' }))).toEqual([]);
  });

  it('says nothing about an empty scope', () => {
    expect(ids(run({ onlyPhases: [] }))).toEqual([]);
  });
});

describe('runNotes — the actions attached to a note', () => {
  it('offers to clear a scope only when the console may act', () => {
    const scoped = run({ onlyPhases: [3] });
    const withHandler = runNotes({
      run: scoped, live: true, allowRun: true, onClearScope: () => {},
    });
    expect(withHandler[0].action).toBeTruthy();

    const readOnly = runNotes({
      run: scoped, live: true, allowRun: false, onClearScope: () => {},
    });
    expect(readOnly.find((n) => n.id === 'scoped')?.action).toBeUndefined();
  });

  it('PIN: a halted verification always offers the AI a way in', () => {
    // The capability #19 asks for — "the app can spawn a session to fix this" —
    // is this button, and nothing else on the page leads to it. A halt card
    // without it is the dead end the recovery work existed to remove, so the
    // three states are pinned rather than left to the component.
    const halted = run({
      status: 'halted',
      halt: { at: '2026-08-03T10:00:00Z', reason: 'phase 2 did not verify: npm test', phase: 2 },
    });
    const recovery = { kind: 'halted-verification' as const, allowAgent: true, target: { slug: 'demo', phase: 2 } };

    render(<RunStatusStack run={halted} live={false} allowRun recovery={recovery} />);
    expect(screen.getByRole('button', { name: /fix/i })).toBeEnabled();

    // A console without --allow-agent says which flag turns it on. Never absent:
    // a remedy that exists and is unavailable has to say so.
    const off = runNotes({
      run: halted, live: false, allowRun: true, recovery: { ...recovery, allowAgent: false },
    });
    expect(off.find((n) => n.id === 'halt')?.action).toBeTruthy();

    // And a recovery already running is a link to it, not a second one.
    render(
      <RunStatusStack
        run={halted}
        live={false}
        allowRun
        recovery={{ ...recovery, runningSessionId: 'sess-9' }}
      />,
    );
    expect(screen.getByRole('link', { name: /recovery running/i }))
      .toHaveAttribute('href', '#/agent/sess-9');
  });

  it('an MCP park offers the door the park sentence never mentioned', () => {
    // The park says an unattended session cannot sign a server in, which is
    // true and was the whole of the advice — so the card named the problem and
    // then stopped talking, and a real plan stayed down with 0 phases done.
    // There is a second remedy, and it is one button.
    const parked = run({
      status: 'parked',
      halt: {
        at: '2026-08-03T10:00:00Z',
        reason: 'nothing left to run on its own — phase 1 is parked (phase 1 cannot start: MCP '
          + 'servers grafana (needs authentication)).',
        phase: 1,
        kind: 'mcp-preflight',
      },
    });
    render(<RunStatusStack run={parked} live={false} allowRun />);
    expect(screen.getByRole('button', { name: /Continue without these servers/i })).toBeEnabled();

    // A console that may not spawn runs cannot offer it — the verb retries
    // phases, and retrying is running.
    expect(runNotes({ run: parked, live: false, allowRun: false })
      .find((n) => n.id === 'halt')?.action).toBeUndefined();
  });

  it('offers to re-guard only a run that is still live', () => {
    const loose = run({ permissionProfile: 'trusted' });
    expect(runNotes({ run: loose, live: true, allowRun: true, onGuard: () => {} })[0].action)
      .toBeTruthy();
    // Nothing to narrow on a run that has already stopped.
    expect(runNotes({ run: loose, live: false, allowRun: true, onGuard: () => {} })[0].action)
      .toBeUndefined();
  });
});

describe('RunStatusStack — one stack, in the declared order', () => {
  it('renders every raised note as a sibling of the others, priority-first', () => {
    // The point of the consolidation: these used to be four `Banner`s rendered
    // at four unrelated places in a 1,646-line component, so nothing could put
    // them in an order or even count them.
    const state = run({
      status: 'halted',
      halt: { at: '2026-08-03T10:00:00Z', reason: 'a person is needed', phase: 1 },
      waitUntil: null,
      onlyPhases: [1],
      permissionProfile: 'trusted',
    });
    const { container } = render(
      <RunStatusStack run={state} live={false} allowRun={false} />,
    );

    const banners = [...container.querySelectorAll('[role="status"]')];
    expect(banners).toHaveLength(4);
    // All four share one parent — the stack — rather than being scattered.
    expect(new Set(banners.map((b) => b.parentElement)).size).toBe(1);
    expect(banners.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Halted.'),
      expect.stringContaining('Scoped run.'),
      expect.stringContaining('Trusted run.'),
      expect.stringContaining('read-only for runs'),
    ]);
  });

  it('renders nothing at all when the run has nothing to say', () => {
    const { container } = render(<RunStatusStack run={RUN} live allowRun />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the note that a phone user needs at the top of the stack', () => {
    // A frozen run that is also on bypass: the freeze is the actionable one.
    const state = run({
      status: 'frozen',
      permissionProfile: 'bypass',
      freeze: { at: '2026-08-03T10:00:00Z', phase: 2, pid: 9, by: 'me', escalateAt: '2026-08-03T12:00:00Z' },
    });
    render(<RunStatusStack run={state} live allowRun />);
    const banners = screen.getAllByRole('status');
    expect(banners[0].textContent).toContain('Frozen mid-phase.');
  });
});

describe('looksLikeAuthFailure', () => {
  it('believes the probe when it says signed out', () => {
    expect(looksLikeAuthFailure(RUN, { loggedIn: false, checkedAt: 'x' })).toBe(true);
  });

  it('reads a halt that talks about signing in, even with no probe', () => {
    // The probe can be missing or stale; the halt reason is the run's own words.
    const halted = run({ halt: { at: 'x', reason: 'the session was not signed in' } });
    expect(looksLikeAuthFailure(halted, undefined)).toBe(true);
    expect(looksLikeAuthFailure(run({ halt: { at: 'x', reason: 'authenticate first' } }), undefined))
      .toBe(true);
  });

  it('does not cry wolf over an ordinary halt', () => {
    expect(looksLikeAuthFailure(run({ halt: { at: 'x', reason: 'no handoff written' } }), undefined))
      .toBe(false);
    expect(looksLikeAuthFailure(RUN, { loggedIn: true, checkedAt: 'x' })).toBe(false);
  });
});

describe('the halt card action — the session API leads, the pty agent follows', () => {
  const halted = (kind?: string) => run({
    status: 'halted',
    slug: 'demo',
    halt: { at: '2026-08-03T10:00:00Z', reason: 'no handoff was written', phase: 2, ...(kind ? { kind } : {}) },
  });
  const withRecovery = (state: RunState) => runNotes({
    run: state, live: false, allowRun: true,
    recovery: { kind: 'halted-missing-handoff', allowAgent: true, target: { slug: 'demo', phase: 2 } },
  }).find((n) => n.id === 'halt');

  it('a session-shaped halt leads with "Resume session & finish closeout"', () => {
    const note = withRecovery(halted('no-handoff'));
    render(<>{note?.action}</>);
    const resume = screen.getByRole('button', { name: /Resume session & finish closeout/ });
    expect(resume).toBeTruthy();
    // The pty agent is still there — demoted, not removed: two buttons.
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('a plan-shaped halt keeps the agent button as the only remedy', () => {
    const note = withRecovery(halted('plan-lint'));
    render(<>{note?.action}</>);
    expect(screen.queryByRole('button', { name: /Resume session & finish closeout/ })).toBeNull();
  });

  it('without --allow-run the session remedy is not offered', () => {
    const note = runNotes({
      run: halted('no-handoff'), live: false, allowRun: false,
      recovery: { kind: 'halted-missing-handoff', allowAgent: true, target: { slug: 'demo', phase: 2 } },
    }).find((n) => n.id === 'halt');
    render(<>{note?.action}</>);
    expect(screen.queryByRole('button', { name: /Resume session & finish closeout/ })).toBeNull();
  });
});
