/**
 * The client half of the situation vocabulary — a re-export, like
 * `lib/recovery.ts`: ids, labels, blurbs and the actor table live in
 * `shared/situation-model.js`, imported by the server's classifier, the
 * ladder and this client alike, so a chip, a panel and a journal line can
 * never drift apart. `test/situation.test.ts` holds them identical by import
 * identity.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// and node resolves no Vite alias.
export {
  SITUATIONS,
  SITUATION_ACTOR,
  SITUATION_BLURBS,
  SITUATION_LABELS,
  SUB_KINDS,
  isSituation,
  parseSituationKey,
  situationKey,
  situationLabel,
} from '../../../shared/situation-model.js';

export type SituationId =
  | 'superseded'
  | 'qa-failed'
  | 'qa-pending'
  | 'foreign-live'
  | 'foreign-stale'
  | 'waiting-external'
  | 'gated-manual'
  | 'plan-broken'
  | 'mcp-unavailable'
  | 'resource-wall'
  | 'blocked-declared'
  | 'verify-red'
  | 'done-unrecorded'
  | 'work-in-progress'
  | 'never-started'
  | 'unknown';

/** The wire shape the diagnosis endpoint carries (`server/service.ts` `PhaseDiagnosis.situation`). */
export type SituationView = {
  id: SituationId | string;
  sub?: string;
  key: string;
  label: string;
  blurb: string;
  actor: 'machine' | 'person' | 'wait' | 'none' | string;
  why: string[];
};
