/**
 * One vocabulary, two surfaces, zero drift.
 *
 * The status words are explained twice — on every badge's hover and in the
 * Guide's Reference tables — and the two must never disagree, because the
 * whole point is that an operator staring at `parked` should get ONE answer.
 * The Records are typed over the closed unions, so a new status that nobody
 * explains is a compile error; this file pins the other half — that the guide
 * page names every word the machine can show, and that no entry is an empty
 * shrug.
 */

import { describe, expect, it } from 'vitest';
import reference from '@/content/guide/reference.md?raw';
import { BOARD_STATE_HELP, PHASE_STATUS_HELP, RUN_STATUS_HELP, boardStateTitle, phaseStatusTitle, runStatusTitle } from './status-vocab';
import { CLOSED_HELP, closedTitle } from './closure';
import { STATE_BOARD } from '@/components/ui/chip';

describe('every status word is explained, nowhere emptily', () => {
  it('has a real meaning AND a real next move for every entry', () => {
    for (const [table, entries] of Object.entries({ RUN_STATUS_HELP, PHASE_STATUS_HELP, BOARD_STATE_HELP })) {
      for (const [word, help] of Object.entries(entries)) {
        expect(help.means.length, `${table}.${word}.means`).toBeGreaterThan(20);
        expect(help.then.length, `${table}.${word}.then`).toBeGreaterThan(5);
      }
    }
  });

  it('the guide reference names every run status, phase status and board state', () => {
    for (const word of Object.keys(RUN_STATUS_HELP)) {
      expect(reference, `run status ${word}`).toContain(`\`${word}\``);
    }
    for (const word of Object.keys(PHASE_STATUS_HELP)) {
      expect(reference, `phase status ${word}`).toContain(`\`${word}\``);
    }
    for (const word of Object.keys(BOARD_STATE_HELP)) {
      expect(reference, `board state ${word}`).toContain(`\`${word}\``);
    }
    // The departures spellings too — Held, Departed and friends are the words
    // actually painted on the board, and they are what the question was about.
    for (const spelled of new Set(Object.values(STATE_BOARD))) {
      expect(reference, `departures word ${spelled}`).toContain(`**${spelled}**`);
    }
  });

  // The fourth vocabulary. `CLOSED_HELP` lives in closure.ts rather than here —
  // it is a property of a PLAN, not of a phase or a run — but it is explained on
  // the same two surfaces and so must not drift on either. Its own docstring
  // calls it "the vocabulary the badge and the Guide share"; this is what makes
  // that true rather than aspirational.
  it('the guide reference names every terminal plan status, and each says how it ended', () => {
    for (const [word, help] of Object.entries(CLOSED_HELP)) {
      expect(reference, `plan status ${word}`).toContain(`\`${word}\``);
      expect(help.length, `CLOSED_HELP.${word}`).toBeGreaterThan(20);
    }
    // `active` is the open half of the same question, and the table is only
    // legible if it names the state a plan is in before anybody closes it.
    expect(reference, 'plan status active').toContain('`active`');
  });

  it('the closed badge explains how a plan ended, why, and that it can come back', () => {
    const title = closedTitle({ status: 'superseded', closed: true, closedOn: '2026-03-14', closedReason: 'folded into the payments rework' });
    expect(title).toContain('Another plan took this one over.');
    expect(title).toContain('folded into the payments rework');
    expect(title).toContain('2026-03-14');
    // Reversibility is the whole reason closing is a cheap decision — the badge
    // must never read as a one-way door.
    expect(title).toContain('Reopen');
    // An unknown status still answers rather than going blank.
    expect(closedTitle({ status: 'retired', closed: true })).toContain('retired');
    expect(closedTitle(undefined)).toBe('');
  });

  it('the title helpers answer for the words people asked about, meaning then move', () => {
    for (const [fn, word] of [
      [runStatusTitle, 'halted'], [runStatusTitle, 'interrupted'], [runStatusTitle, 'parked'],
      [phaseStatusTitle, 'parked'], [boardStateTitle, 'waiting'], [boardStateTitle, 'stuck'],
    ] as const) {
      const title = fn(word);
      expect(title, word).toBeTruthy();
      expect(title, word).toContain('→');
    }
    // An unknown word stays silent rather than inventing an explanation.
    expect(runStatusTitle('mystery')).toBeUndefined();
  });
});
