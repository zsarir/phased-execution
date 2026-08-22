/**
 * What a run may be told, named once.
 *
 * Two doors accept run settings — `POST /api/run/:slug/start` and
 * `POST /api/run/:slug/settings` — and until Phase 4 they each quietly dropped
 * whatever they did not recognise. Phase 4 made them 400 instead. This module
 * is the other half of that fix: the LIST itself, in one place, so the form
 * that builds a payload and the route that reads one cannot drift.
 *
 * There are three readers:
 *
 * - `server/api/routes.ts` is the real door, and these lists describe it.
 *   Nothing here validates anything; the route's own coercion is still the wall.
 * - `client/src/features/run-setup/schema.ts` builds its zod shape from these
 *   names, so a field the server accepts and the form cannot send is a test
 *   failure rather than a silent capability gap.
 * - `test/run-settings-parity.test.ts` reads the route module's source and
 *   holds all three honest: every `body.<field>` the two case blocks read must
 *   appear here, and every name here must be read there.
 *
 * ⚠️ Data only, no imports — the client bundles this, and `node --test`
 * imports it directly. Adding a field to a door means adding it here in the
 * same commit; that is the whole point.
 */

/**
 * Fields `POST /api/run/:slug/start` reads off the body.
 *
 * Ordered the way the route reads them, not alphabetically: this list is a
 * description of that code, and a reviewer comparing the two should be able to
 * walk both in one pass.
 */
export const RUN_START_FIELDS = Object.freeze([
  'model',
  'effort',
  'maxParallel',
  'maxConsecutiveFailures',
  'autonomy',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'resumeRunId',
  'onlyPhases',
  'phaseOptions',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'permissionProfile',
  'gitMode',
  'openPr',
  'attachDefaultSkills',
  'qa',
  'accountId',
  'onLimit',
  'autoRecover',
]);

/**
 * Fields `POST /api/run/:slug/settings` reads off the body.
 *
 * The difference from `start` is the point, so it is spelled out rather than
 * derived: `resumeRunId`, `qa` and `accountId` are START-only — a settings
 * patch cannot mint a run, turn a plan's QA gate on, or move a run's account
 * (that last one is its own verb, `switch-account`). `by` is not a setting: it
 * is the audit attribution the route stamps.
 */
export const RUN_SETTINGS_FIELDS = Object.freeze([
  'model',
  'effort',
  'maxParallel',
  'autoRecover',
  'autonomy',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'permissionProfile',
  'gitMode',
  'openPr',
  'attachDefaultSkills',
  'onLimit',
]);

/** Accepted on `start` and refused on `settings` — asserted, not assumed. */
export const START_ONLY_FIELDS = Object.freeze(
  RUN_START_FIELDS.filter((field) => !RUN_SETTINGS_FIELDS.includes(field)),
);

/** What one phase may override for itself (`PhaseOptions`, `phaseOptions()` in the route). */
export const PHASE_OPTION_FIELDS = Object.freeze([
  'model',
  'effort',
  'tools',
  'permissionMode',
  'skills',
  'skillsOff',
  'mcpServers',
  'mcpOff',
  'mcpPolicy',
]);

/**
 * What `POST /api/agent/ticket` takes for the two launches this form mints —
 * a QA review and a recovery. Not a run: an agent ticket opens ONE interactive
 * session, so it has no budget, no git strategy and no per-phase matrix.
 *
 * `cols`/`rows` are carried by the caller (`estimateTerminalSize`), not by the
 * form: the pty is born at the size the browser can see, which is a property of
 * the viewport rather than of the launch.
 */
export const AGENT_TICKET_FIELDS = Object.freeze([
  'intent',
  'slug',
  'phase',
  'runId',
  'recoveryClass',
  'activate',
  'model',
  'effort',
  'permissionProfile',
  'permissionMode',
  'prompt',
  'skills',
  'resume',
  'accountId',
  'cols',
  'rows',
]);
