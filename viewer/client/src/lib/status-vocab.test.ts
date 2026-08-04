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
