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

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NO_ACTIVITY, activity, fold, toLine } from './console-model';
import { DEFAULTS, EFFORTS, MODELS, effortAlias, isLive, modelAlias } from './defaults';
import { LiveConsole } from './console';
import { phaseActions } from '@shared/phase-model.js';

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
    for (const s of ['running', 'waiting', 'pausing', 'stopping']) expect(isLive(s)).toBe(true);
    for (const s of ['finished', 'halted', 'paused', 'interrupted']) expect(isLive(s)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });
});

describe('plan-prose aliases', () => {
  it('reads a model or an effort out of a plan bullet, and only a known one', () => {
    expect(modelAlias('**Model:** Opus 4.8, because the reasoning is hard')).toBe('opus');
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
      kind: 'todos', items: [{ content: 'do it', status: 'pending' }],
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
