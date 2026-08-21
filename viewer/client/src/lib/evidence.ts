/**
 * The client half of the evidence vocabulary — a re-export, like
 * `lib/situation.ts`: the words, the truth table and the `why[]` prose live in
 * `shared/evidence-model.js`, imported by the server's `detail()`/
 * `phaseDiagnosis()`, by the runner's classifier and by this client alike, so
 * a badge, a panel and a journal line can never disagree about whether a phase
 * was actually verified. `test/evidence-model.test.ts` holds them identical by
 * import identity.
 *
 * The one thing to keep in mind when rendering this: `evidenced` is not
 * `done`. The board's `done` is a CLAIM — a `status: complete` line in a
 * handoff — and `evidenced` is whether anything ever ran to back it. A phase
 * can be legitimately done and not evidenced; say so, do not hide it.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// and node resolves no Vite alias.
export {
  BOARD_WORDS,
  HANDOFF_WORDS,
  QA_WORDS,
  RULING_KINDS,
  VERIFICATION_WORDS,
  deriveEvidence,
  isQaWord,
  isVerificationWord,
} from '../../../shared/evidence-model.js';

export type VerificationWord = 'none' | 'red' | 'skipped' | 'human' | 'green';

export type QaWord = 'off' | 'fail' | 'pending' | 'pass' | 'waived';

export type BoardWord = 'done' | 'in-progress' | 'stuck' | 'ready' | 'waiting' | 'unknown';

export type HandoffWord = 'absent' | 'pending' | 'in-progress' | 'blocked' | 'complete' | 'unknown';

export type RulingKind = 'ambiguity' | 'deviation' | 'deferral';

/**
 * The wire shape the plan and diagnosis endpoints carry. Optional on every
 * client mirror that embeds it: a freshly built client must keep working
 * against a not-yet-restarted older server, where the field is simply absent —
 * and absent reads as "we do not know", never as evidenced.
 */
export type EvidenceView = {
  board: BoardWord | string;
  handoff: HandoffWord | string;
  verification: VerificationWord | string;
  qa: QaWord | string;
  evidenced: boolean;
  why: string[];
};
