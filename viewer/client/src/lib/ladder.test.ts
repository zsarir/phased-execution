/**
 * `ladderView()` — the one derivation every Ways-forward surface renders from.
 * Pure data in, pure data out: what the machine tried, what it is doing now,
 * what it tries next (from the SHARED table, by identity), or the one errand.
 */

import { describe, expect, it } from 'vitest';
import { RUNGS_BY_SITUATION as SHARED_TABLE } from '../../../shared/ladder-model.js';
import {
  RUNGS_BY_SITUATION,
  errandsOf,
  ladderView,
  rungLabel,
  situationLabelFor,
  untriedRungs,
} from './ladder';
import type { Errand, RecoverySlot } from './api';

const slot = (over: Partial<RecoverySlot> = {}): RecoverySlot => ({ attempts: 0, lastAt: '', ...over });
const errand = (over: Partial<Errand> = {}): Errand => ({
  phase: 2,
  situation: 'verify-red',
  tried: ['resume-own-session (fix-verification) → failed', 'fix-agent → failed'],
  need: "The phase's §Verification to pass.",
  how: 'Read What failed, fix it, then Re-check.',
  at: '2026-08-20T10:00:00.000Z',
  ...over,
});

describe('the shared table, by identity', () => {
  it("is the server's table — the same object, not a copy", () => {
    expect(RUNGS_BY_SITUATION).toBe(SHARED_TABLE);
  });

  it("names every climbed rung in the table's own words", () => {
    expect(rungLabel('reboard-fresh')).toBe('Re-board fresh');
    expect(rungLabel('resume-own-session', { mode: 'continue' })).toBe('Continue in its own session');
    expect(rungLabel('resume-own-session', { mode: 'fix-verification' })).toBe('Resume with the failure');
    expect(rungLabel('reboard-resume-brief', { escalate: 'model' })).toBe('Board fresh, stronger');
    // A vehicle with no row anywhere still reads as words, never a raw id.
    expect(rungLabel('some-newer-vehicle')).toBe('some newer vehicle');
  });

  it('untriedRungs walks the table in climb order, skipping what was climbed', () => {
    const all = untriedRungs('work-in-progress', []);
    expect(all.map((r) => r.label)).toEqual([
      'Continue in its own session',
      'Board fresh with a resume brief',
      'Board fresh, stronger',
    ]);
    const after = untriedRungs('work-in-progress', [
      { situation: 'work-in-progress', rung: 'resume-own-session', params: { mode: 'continue' } },
    ]);
    expect(after[0].label).toBe('Board fresh with a resume brief');
    // A sub-kind falls back to the id's table, and a person's situation has none.
    expect(untriedRungs('blocked-declared:unknown', [])[0].vehicle).toBe('unblock-session');
    expect(untriedRungs('gated-manual', [])).toEqual([]);
  });
});

describe('ladderView', () => {
  it("reads the record's situation and proposes the first rung when nothing was tried", () => {
    const view = ladderView({
      run: { recoveries: {} },
      phase: 1,
      record: { situation: { key: 'never-started' } },
    });
    expect(view.empty).toBe(false);
    expect(view.situation).toMatchObject({ key: 'never-started', label: 'Never started', actor: 'machine' });
    expect(view.tried).toEqual([]);
    expect(view.next?.label).toBe('Re-board fresh');
    expect(view.errand).toBeUndefined();
  });

  it('lists what was tried with how it ended, and the next rung after it', () => {
    const run = {
      recoveries: {
        '3': slot({
          rungs: [
            {
              situation: 'work-in-progress',
              rung: 'resume-own-session',
              params: { mode: 'continue' },
              at: '2026-08-20T09:00:00Z',
              outcome: 'failed',
              costUsd: 2.5,
            },
          ],
        }),
      },
    };
    const view = ladderView({ run, phase: 3 });
    expect(view.situation?.key).toBe('work-in-progress');
    expect(view.tried).toHaveLength(1);
    expect(view.tried[0]).toMatchObject({
      label: 'Continue in its own session',
      outcomeLabel: 'did not hold',
      costUsd: 2.5,
    });
    expect(view.next?.label).toBe('Board fresh with a resume brief');
  });

  it('shows the rung in flight and proposes nothing while it runs', () => {
    const run = {
      recoveries: {
        '3': slot({
          rungs: [
            {
              situation: 'verify-red',
              rung: 'resume-own-session',
              params: { mode: 'fix-verification' },
              at: '',
              outcome: 'running',
            },
          ],
        }),
      },
    };
    const view = ladderView({ run, phase: 3 });
    expect(view.running?.label).toBe('Resume with the failure');
    expect(view.next).toBeUndefined();
  });

  it('carries the one errand and proposes nothing beyond it', () => {
    const run = { recoveries: { '2': slot({ errand: errand(), rungs: [] }) } };
    const view = ladderView({ run, phase: 2 });
    expect(view.errand).toEqual(errand());
    expect(view.situation?.label).toBe('Verification red');
    expect(view.next).toBeUndefined();
  });

  it("reads the run-level errand for a phase-less target, and a phase's own for a phase", () => {
    const run = { recoveries: {}, errand: errand({ phase: 0, situation: 'resource-wall:auth' }) };
    expect(ladderView({ run }).errand?.situation).toBe('resource-wall:auth');
    expect(ladderView({ run }).situation?.label).toBe('Resource wall · auth');
    expect(ladderView({ run, phase: 4 }).empty).toBe(true);
  });

  it('is empty for a resolved run — the errand it left is not relitigated', () => {
    const run = {
      recoveries: { '2': slot({ errand: errand() }) },
      resolved: { at: 'x', reason: 'superseded' },
    };
    expect(ladderView({ run, phase: 2 })).toEqual({ tried: [], empty: true });
  });

  it("lets the diagnosis endpoint's situation outrank the record's cache", () => {
    const view = ladderView({
      run: { recoveries: {} },
      phase: 1,
      situation: { id: 'blocked-declared', sub: 'lock' },
      record: { situation: { key: 'never-started' } },
    });
    expect(view.situation?.key).toBe('blocked-declared:lock');
    expect(view.next?.label).toBe('Queue behind the lock');
  });
});

describe('errandsOf', () => {
  it('orders phase errands by phase and puts the run-level one last', () => {
    const run = {
      recoveries: {
        '7': slot({ errand: errand({ phase: 7 }) }),
        '2': slot({ errand: errand({ phase: 2 }) }),
        plan: slot({ errand: errand({ phase: 0 }) }),
      },
      errand: errand({ phase: 0, situation: 'resource-wall:budget' }),
    };
    expect(errandsOf(run).map((e) => `${e.phase}:${e.situation}`)).toEqual([
      '2:verify-red',
      '7:verify-red',
      '0:resource-wall:budget',
    ]);
    expect(errandsOf(null)).toEqual([]);
  });

  it('labels a full key the way the chips do', () => {
    expect(situationLabelFor('blocked-declared:credential')).toBe('Declared blocked · credential');
    expect(situationLabelFor('never-started')).toBe('Never started');
  });
});
