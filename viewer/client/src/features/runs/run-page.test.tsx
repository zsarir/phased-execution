/**
 * The rest of Phase 4's load-bearing behaviour.
 *
 * Three things here are easy to break by accident and invisible when broken:
 *
 * 1. **The defaults.** They are one exported object read by the controls and
 *    asserted here, so "the Autopilot tab opens on opus/max/keep-going/trusted"
 *    is a fact rather than a thing someone once saw.
 * 2. **The console model's identity contract.** `activity()` returns the state
 *    it was given when nothing changed, and the React wrapper depends on that to
 *    avoid re-rendering three panels per streamed token.
 * 3. **The board gates the actions, not the run record.** The defect the phase
 *    table was rebuilt for is offering to re-run a phase the board calls done.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NO_ACTIVITY, activity, fold, toLine } from './console-model';
import { DEFAULTS, EFFORTS, MODELS, effortAlias, isLive, modelAlias } from './defaults';
import { LiveConsole } from './console';
import { displayState } from './phase-table';
import { seedSkills } from './lane-setup';
import { RunHeader, RunTiles, phaseProgress } from './tiles';
import { phaseActions } from '@shared/phase-model.js';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';

/** RunHeader reads the accounts cache for the paying-account chip. */
function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('DEFAULTS', () => {
  it('opens a fresh run on opus / max / keep-going / trusted', () => {
    expect(DEFAULTS).toEqual({
      model: 'opus',
      effort: 'max',
      autonomy: 'keep-going',
      permissionProfile: 'trusted',
    });
  });

  it('offers every default as a real choice in its own vocabulary', () => {
    // A default the select cannot show is a form that opens on a blank field.
    expect(MODELS).toContain(DEFAULTS.model);
    expect(EFFORTS).toContain(DEFAULTS.effort);
  });

  it('is frozen, so a view cannot edit the opening posture for everyone else', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe('isLive', () => {
  it('counts frozen as live — there is a child holding a session', () => {
    // Treating it as idle would offer a Start button that refuses because a run
    // is already in progress.
    expect(isLive('frozen')).toBe(true);
    for (const s of ['running', 'waiting', 'pausing', 'stopping', 'halting']) expect(isLive(s)).toBe(true);
    for (const s of ['finished', 'halted', 'paused', 'interrupted']) expect(isLive(s)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });

  it('counts queued as live too, read from the other end', () => {
    // It holds no child and no lock — which is exactly why the SERVER keeps it
    // out of its own `IN_FLIGHT` — but a loop is behind it, sitting in
    // `admit()`. The client's question is "do the controls for a running run
    // apply", and for a queued one they do: Start would 409.
    expect(isLive('queued')).toBe(true);
  });
});

describe('plan-prose aliases', () => {
  it('reads a model or an effort out of a plan bullet, and only a known one', () => {
    expect(modelAlias('**Model:** Opus 5, because the reasoning is hard')).toBe('opus');
    expect(effortAlias('run this at MAX effort')).toBe('max');
    expect(modelAlias('whatever is cheapest')).toBeUndefined();
    expect(effortAlias(undefined)).toBeUndefined();
  });
});

describe('the console model, as React consumes it', () => {
  it('returns the SAME object when an event changes nothing', () => {
    // The contract the whole live console rests on: `setPanels(current =>
    // activity(current, …))` with an unchanged reference is a bail-out, not a
    // re-render. Roughly nine in ten stream events are this case.
    const before = NO_ACTIVITY;
    const after = activity(before, 'stream', { kind: 'partial', text: 'thinking…' });
    expect(after).toBe(before);
  });

  it('returns a NEW object when a tool call opens', () => {
    const after = activity(NO_ACTIVITY, 'stream', { kind: 'tool', id: 't1', name: 'Bash' });
    expect(after).not.toBe(NO_ACTIVITY);
    expect(after.tools).toHaveLength(1);
    // `null`, not absent: "still running" is a state the panel renders.
    expect(after.tools[0].ok).toBeNull();
    expect(after.tools[0].ms).toBeNull();
  });

  it('resets the task list when a new phase starts', () => {
    const withTodos = activity(NO_ACTIVITY, 'stream', {
      kind: 'todos',
      items: [{ content: 'do it', status: 'pending' }],
    });
    expect(withTodos.todos).toHaveLength(1);
    const next = activity(withTodos, 'phase', { phase: 2, status: 'running' });
    expect(next.todos).toEqual([]);
  });

  it('folds streamed fragments into one line rather than one line per token', () => {
    let lines = fold([], toLine('stream', { kind: 'partial', text: 'Hel' })!, 1);
    lines = fold(lines, toLine('stream', { kind: 'partial', text: 'lo' })!, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello');
  });

  it('keeps two subagents apart by the call that started them', () => {
    // Without `parent` these interleaved into one line, legible as neither.
    let lines = fold([], toLine('stream', { kind: 'subagent', text: 'A1', parent: 'a' })!, 1);
    lines = fold(lines, toLine('stream', { kind: 'subagent', text: 'B1', parent: 'b' })!, 2);
    expect(lines).toHaveLength(2);
  });
});

describe('LiveConsole', () => {
  it('says what it will show rather than rendering an empty box', () => {
    render(<LiveConsole lines={[]} />);
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'polite');
  });

  it('hides the quiet kinds until Detail is asked for, and counts them', () => {
    const lines = [
      { id: 1, kind: 'tool', text: 'Bash', at: 0 },
      { id: 2, kind: 'thinking', text: 'hmm', at: 0 },
      { id: 3, kind: 'hook', text: 'a hook', at: 0 },
    ];
    render(<LiveConsole lines={lines} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText('hmm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Detail \(2\)/ })).toBeInTheDocument();
    expect(screen.getByText(/1 lines/)).toBeInTheDocument();
  });
});

describe('displayState — Boarding is not what a phase being worked on says', () => {
  // "Boarding" is the departures word for the engine's `ready`, which is read
  // from handoff files. Retry a phase and the board goes on saying it for as
  // long as it takes the session to write one — an hour is normal — while the
  // run has demonstrably started work. The row showed only the stale word.
  // The rule keys on the ROW's own record being live-running — not on
  // `run.activePhase`, which mirrors only the LOWEST live lane and sent every
  // other running lane straight back to "Boarding".
  it('shows a phase whose own record is live-running as in progress', () => {
    expect(displayState('ready', { running: true })).toBe('in-progress');
    expect(displayState('waiting', { running: true })).toBe('in-progress');
  });

  it('never overrules the board on done — that is the board reporting work finished', () => {
    expect(displayState('done', { running: true })).toBe('done');
  });

  it('leaves every other row exactly as the board reported it', () => {
    // Not running: the record is settled, or the console is not live — either
    // way there is no fresher fact to prefer and the board is all there is.
    expect(displayState('ready', { running: false })).toBe('ready');
    expect(displayState('blocked', { running: false })).toBe('blocked');
  });
});

describe('phaseActions — the board gates every action', () => {
  const ctx = { live: false, allowRun: true };

  it('never offers to run a phase the board calls done', () => {
    // Even when this run's own record says it failed. The record is what THAT
    // RUN did; the board is what is true now.
    const done = { phase: 1, state: 'done', record: { status: 'failed' } };
    expect(phaseActions(done, ctx)).toMatchObject({ runAlone: false, retry: false, skip: false });
  });

  it('offers Run only this for a ready phase, and not for a waiting one', () => {
    expect(phaseActions({ phase: 2, state: 'ready' }, ctx).runAlone).toBe(true);
    expect(phaseActions({ phase: 3, state: 'waiting' }, ctx).runAlone).toBe(false);
  });

  it('offers a diagnosis even on a console that cannot act', () => {
    // Reading the evidence changes nothing; refusing to show it is what sent
    // people to a terminal.
    const stalled = { phase: 2, state: 'ready', record: { status: 'failed' } };
    expect(phaseActions(stalled, { live: false, allowRun: false }).diagnose).toBe(true);
  });

  it('offers nothing that acts while a loop is driving, except Skip', () => {
    const failed = { phase: 2, state: 'ready', record: { status: 'failed' } };
    const live = phaseActions(failed, { live: true, allowRun: true });
    expect(live).toMatchObject({ runAlone: false, retry: false, skip: true });
  });
});

describe('seedSkills — which boxes the picker opens with ticked', () => {
  it('gives a run that does not exist yet the machine defaults', () => {
    expect(seedSkills(null, ['graph-tool'])).toEqual(['graph-tool']);
  });

  it('lets an existing run answer for itself, empty list included', () => {
    // THE case this exists for. `state.skills` is deleted when it is empty, so
    // an absent list on a REAL run means the operator turned them all off —
    // and `run.skills ?? defaults` would put the boxes straight back, making
    // them impossible to untick.
    const run = { id: 'r1' } as unknown as RunState;
    expect(seedSkills(run, ['graph-tool'])).toEqual([]);
  });

  it('shows an existing run its own list, not the machine one', () => {
    const run = { id: 'r1', skills: ['investigate'] } as unknown as RunState;
    expect(seedSkills(run, ['graph-tool'])).toEqual(['investigate']);
  });

  it('hands back a copy, so editing the picker cannot edit console state', () => {
    const defaults = ['graph-tool'];
    seedSkills(null, defaults).push('something-else');
    expect(defaults).toEqual(['graph-tool']);
  });
});

describe('phaseProgress — a running phase against its estimate', () => {
  it('shows the estimate while the phase is inside it', () => {
    expect(phaseProgress(10 * 60_000, 40 * 60_000)).toBe('~40 min');
  });

  it('says "over estimate" rather than counting down to zero', () => {
    // A clock that reaches 0:00 and stops reads as "it is stuck", which is the
    // one thing an over-running phase most reliably is not.
    expect(phaseProgress(90 * 60_000, 40 * 60_000)).toBe('over estimate');
  });

  it('renders nothing at all without an estimate', () => {
    expect(phaseProgress(60_000, undefined)).toBeNull();
    expect(phaseProgress(60_000, 0)).toBeNull();
  });
});

/**
 * The header's icons are decoration, and decoration that reaches the
 * accessibility tree stops being decoration: the phase clock would announce
 * itself as "timer 12m" and every text query for the time would start matching
 * an icon too. So the property worth holding is not which glyph was chosen —
 * it is that none of them adds a word.
 */
describe('the run header emphasis', () => {
  const RUN = {
    id: 'r1',
    slug: 'demo',
    status: 'running',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 0,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-04T10:20:00Z',
    activePhase: 2,
    child: { pid: 1, phase: 2, sessionId: 's', startedAt: '2026-08-04T10:10:00Z' },
  } as unknown as RunState;

  it('gives the phase clock the weight, and the icons no voice', () => {
    const { container } = mount(<RunHeader run={RUN} live={false} eta={null} />);

    // The clock is still exactly the time — an icon that announced itself
    // would land inside this accessible text.
    const clock = screen.getByTitle(/How long the phase running now has been going/);
    expect(clock.textContent?.trim()).toMatch(/^\d/);
    // ...and it is the biggest thing on the line, which is the whole change.
    expect(clock.className).toMatch(/text-base|text-lg/);
    expect(clock.className).toMatch(/font-semibold/);

    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden');
    }
  });

  it('the model tile still reads as its model, icons and all', () => {
    const { container } = render(<RunTiles run={RUN} phases={[]} />);

    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument();
    expect(screen.getByText(/max effort · keep-going/)).toBeInTheDocument();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden');
    }
  });
});

describe('the completion promise', () => {
  const LIVE = {
    id: 'r1',
    slug: 'demo',
    status: 'running',
    model: 'opus',
    autonomy: 'keep-going',
    spentUsd: 0,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-04T10:20:00Z',
    activePhase: 2,
    child: null,
    phases: {},
  } as unknown as RunState;

  it('a keep-going unscoped run says it drives to plan completion, with the budget when spent', () => {
    mount(<RunHeader run={{ ...LIVE, consecutiveFailures: 1 } as RunState} live eta={null} />);
    expect(screen.getByText('runs to plan completion')).toBeTruthy();
    expect(screen.getByText('failures 1/2')).toBeTruthy();
  });

  it('a scoped run makes no completion promise, and a clean streak shows no failure figure', () => {
    mount(<RunHeader run={{ ...LIVE, onlyPhases: [4] } as RunState} live eta={null} />);
    expect(screen.queryByText('runs to plan completion')).toBeNull();
    expect(screen.queryByText(/^failures /)).toBeNull();
  });
});

describe("the Phases done tile counts the PLAN, not the run's records", () => {
  const WEDGED = {
    id: 'r1',
    slug: 'demo',
    status: 'parked',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 0,
    createdAt: '2026-08-22T10:00:00Z',
    updatedAt: '2026-08-22T14:00:00Z',
  } as unknown as RunState;

  // A run holds a record only for phases it actually boarded. On a plan wedged
  // after two of eight phases, both records read `done` — so the tile above the
  // fold read "2 / 2", which is what a finished run looks like, while the board
  // said 2/8 and six phases were held. The denominator has to come from the
  // plan, which the page already has.
  it('uses the plan total when it is known', () => {
    const { container } = render(
      <RunTiles
        run={WEDGED}
        phases={
          [
            { phase: 1, status: 'done', attempts: 1 },
            { phase: 3, status: 'done', attempts: 1 },
          ] as never
        }
        total={8}
      />,
    );
    expect(container.textContent).toContain('/ 8');
    expect(container.textContent).not.toContain('/ 2');
  });

  it('falls back to the record count when the plan detail has not loaded', () => {
    const { container } = render(
      <RunTiles run={WEDGED} phases={[{ phase: 1, status: 'done', attempts: 1 }] as never} />,
    );
    expect(container.textContent).toContain('/ 1');
  });
});
