/**
 * The eight things this form can be, and exactly what each one sends.
 *
 * A mode is a FIELD SET plus a payload builder. That pairing is the whole
 * consolidation: four surfaces used to each decide privately which choices to
 * offer and how to spell them, so "Continue" on a plan page could not set a
 * budget while "Continue" on the run page could, and neither said so.
 *
 * ## Why the payloads are built here and not in the component
 *
 * Because they are the contract, and a contract you can only exercise by
 * rendering a dialog and clicking a button is a contract nobody re-checks.
 * `buildRunPayload` and `buildTicket` are pure: `run-setup.test.tsx` pins them
 * field by field, including the omissions, which is where the interesting bugs
 * live — a key that stops being sent degrades silently to the server's own
 * default, and the run looks healthy and is not the run that was asked for.
 *
 * ## The omission rules, stated once
 *
 * - **Always sent, exactly as shown**: `permissionProfile`, `mcpPolicy`,
 *   `autoRecover`, `gitMode`. A run written without them falls back to a
 *   preference, and a form that shows a value and sends nothing is lying.
 * - **Omitted when empty**: `mcpServers`, `onlyPhases`, `attachDefaultSkills`,
 *   `qa`. Absence is their meaning on disk, and a run file that never named
 *   servers must keep meaning what it meant.
 * - **Sent as `null` when blank**: the two budgets. `null` is "no ceiling",
 *   which is a choice; absence would mean "leave whatever was there".
 */

import type { PhaseOptions, RunState } from '@/lib/api';
import { RECOVERY_LABELS, type RecoveryClass } from '@/lib/recovery';
import { EMPTY, parsePhases, type PermissionChoice, type RunSetupField, type RunSetupValues } from './schema';

export type RunSetupMode =
  'defaults' | 'plan' | 'start' | 'continue' | 'phase' | 'recovery' | 'qa' | 'session' | 'live';

/** What a mode needs to know that is not a form value. */
export interface RunSetupContext {
  slug?: string;
  /** The phase a `phase`, `qa` or `recovery` launch is about. */
  phase?: number;
  /** The run being continued or reconfigured — the seed, and the resume target. */
  run?: RunState | null;
  runId?: string;
  recoveryClass?: string;
  /** Turn the plan's QA gate on as part of a `qa` launch (its qa-mode is `off`). */
  activate?: boolean;
  /** The plan's `**Model:**` / `**Effort:**` for this phase, when it names one. */
  qaModel?: string;
  qaEffort?: string;
  /** Skills the plan asks every session to invoke — a review opens on them. */
  planSkills?: string[];
}

interface ModeSpec {
  /** The fields this mode shows — and therefore the fields it sends. */
  fields: readonly RunSetupField[];
  /** The button. */
  submit: string | ((context: RunSetupContext) => string);
  /** Which door it knocks on; `prefs` is Settings ▸ Automation. */
  door: 'runStart' | 'runSettings' | 'ticket' | 'prefs' | 'launch';
  /** Sessions offer "Plan only"; runs never do. */
  sessionPermissions?: boolean;
}

/**
 * The full run field set — what a surface minting or reconfiguring a whole run
 * offers. `phase` deliberately shows less (below); a "run only this one" is a
 * narrow act, and burying it under a per-phase matrix and a failure ceiling is
 * how a one-phase launch turns into a re-read of the run's whole configuration.
 */
const RUN_FIELDS = [
  'model',
  'effort',
  'autonomy',
  'permissionProfile',
  'accountId',
  'onLimit',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'gitMode',
  'openPr',
  'qa',
  'attachDefaultSkills',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'autoRecover',
  'maxParallel',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
] as const;

/** A live run: everything above minus the three a patch may never carry. */
const LIVE_FIELDS = RUN_FIELDS.filter(
  (field) => field !== 'qa' && field !== 'accountId',
) as readonly RunSetupField[];

/** The dialog's narrow launch, unchanged: choices, not configuration. */
const PHASE_FIELDS = [
  'model',
  'effort',
  'accountId',
  'onLimit',
  'permissionProfile',
  'attachDefaultSkills',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'gitMode',
  'openPr',
  'qa',
  'autoRecover',
] as const;

/** An agent ticket has no budget, no branch and no matrix — it is one session. */
const TICKET_FIELDS = ['model', 'effort', 'accountId', 'attachDefaultSkills', 'skills'] as const;

export const MODES: Readonly<Record<RunSetupMode, ModeSpec>> = Object.freeze({
  defaults: {
    fields: ['attachDefaultSkills', 'qa', 'gitMode', 'openPr', 'autoRecover', 'mcpPolicy'],
    submit: 'Save defaults',
    door: 'prefs',
  },
  start: { fields: RUN_FIELDS, submit: 'Start', door: 'runStart' },
  continue: { fields: RUN_FIELDS, submit: 'Continue', door: 'runStart' },
  phase: {
    fields: PHASE_FIELDS,
    submit: (context) => `Run phase ${context.phase}`,
    door: 'runStart',
  },
  recovery: {
    fields: TICKET_FIELDS,
    // The class names the button, as it always has: "Repair the plan with a
    // new agent" says what will happen; "Fix it with an agent" does not.
    submit: (context) => RECOVERY_LABELS[context.recoveryClass as RecoveryClass] ?? 'Fix it with an agent',
    door: 'ticket',
  },
  qa: {
    // `qa` here is the ACTIVATION checkbox — turn the plan's gate on as part of
    // this review — not the run-level gate toggle. Same value, same control,
    // different sentence; `buildTicket` sends it as `activate`.
    fields: [...TICKET_FIELDS, 'permissionProfile', 'qa'],
    submit: 'Start review',
    door: 'ticket',
  },
  /**
   * The plan wizard. Deliberately WITHOUT permissions: a plan-authoring
   * session always starts in plan mode, and the select this form used to offer
   * was the one hole in that rule — `auto`/`acceptEdits` here launched a
   * session that could write a plan nobody had approved. The server applies it
   * (`buildAgentLaunch`, `intent: 'plan'`); omitting the field IS the choice.
   */
  plan: {
    fields: ['model', 'effort', 'attachDefaultSkills', 'skills'],
    submit: 'Start authoring',
    door: 'launch',
  },
  session: {
    fields: ['model', 'effort', 'permissionProfile', 'accountId', 'prompt', 'skills'],
    submit: 'Start session',
    door: 'launch',
    sessionPermissions: true,
  },
  live: { fields: LIVE_FIELDS, submit: 'Apply from next phase', door: 'runSettings' },
});

/** Does this mode show that field? The single question every renderer asks. */
export function shows(mode: RunSetupMode, field: RunSetupField): boolean {
  return (MODES[mode].fields as readonly string[]).includes(field);
}

export function submitLabel(mode: RunSetupMode, context: RunSetupContext): string {
  const label = MODES[mode].submit;
  return typeof label === 'function' ? label(context) : label;
}

/** `''` is "no ceiling" and reaches the server as an explicit null. */
const dollars = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/** `''` is "this console's own default" and is left off the payload entirely. */
const whole = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

/**
 * What a run door is told.
 *
 * Reads only the fields the mode SHOWS, so a value seeded and never rendered
 * cannot leak into a payload — which is the failure the old four-surface split
 * kept producing in the other direction, by rendering a value and not sending
 * it.
 */
export function buildRunPayload(
  mode: RunSetupMode,
  values: RunSetupValues,
  context: RunSetupContext = {},
): Record<string, unknown> {
  const run = context.run ?? null;
  const on = (field: RunSetupField) => shows(mode, field);
  const payload: Record<string, unknown> = {};

  if (on('model')) payload.model = values.model;
  if (on('effort')) payload.effort = values.effort;

  // Sent only when it says something: `default` with no account on the run is
  // the absence the server already assumes, and `wait` likewise. Both stay
  // sticky once a run has answered them, which is why the run is consulted.
  if (on('accountId') && (values.accountId !== 'default' || run?.accountId)) {
    payload.accountId = values.accountId;
  }
  if (on('onLimit') && (values.onLimit !== 'wait' || run?.onLimit)) payload.onLimit = values.onLimit;

  // A narrow launch does not reopen the run's own posture: it inherits it, so
  // "run only phase 3" cannot quietly re-autonomy the rest of the plan.
  payload.autonomy = on('autonomy') ? values.autonomy : (run?.autonomy ?? EMPTY.autonomy);
  payload.phaseBudgetUsd = on('phaseBudgetUsd')
    ? dollars(values.phaseBudgetUsd)
    : (run?.phaseBudgetUsd ?? null);
  payload.runBudgetUsd = on('runBudgetUsd') ? dollars(values.runBudgetUsd) : (run?.runBudgetUsd ?? null);

  if (on('permissionProfile')) payload.permissionProfile = values.permissionProfile;
  if (on('skills')) payload.skills = values.skills;
  if (on('mcpServers') && values.mcpServers.length) payload.mcpServers = values.mcpServers;
  if (on('mcpPolicy')) payload.mcpPolicy = values.mcpPolicy;
  if (on('attachDefaultSkills') && values.attachDefaultSkills) payload.attachDefaultSkills = true;
  if (on('gitMode')) {
    payload.gitMode = values.gitMode;
    if (values.gitMode === 'new-branch' && on('openPr')) payload.openPr = values.openPr;
  }
  if (on('qa') && values.qa) payload.qa = true;
  if (on('autoRecover')) payload.autoRecover = values.autoRecover;
  if (on('maxParallel')) {
    const n = whole(values.maxParallel);
    if (n !== undefined) payload.maxParallel = n;
  }
  if (on('maxConsecutiveFailures')) {
    const n = whole(values.maxConsecutiveFailures);
    if (n !== undefined) payload.maxConsecutiveFailures = n;
  }
  if (on('phaseOptions') && Object.keys(values.phaseOptions).length) {
    payload.phaseOptions = values.phaseOptions;
  }

  // Scope. A `phase` launch says it outright; every other mode sends whatever
  // the operator typed, and an empty box means the whole plan — which is why a
  // continue "never silently inherits a single-phase run".
  if (mode === 'phase' && context.phase != null) payload.onlyPhases = [context.phase];
  else if (on('onlyPhases')) {
    const phases = parsePhases(values.onlyPhases);
    if (phases) payload.onlyPhases = phases;
  }

  // Which run this picks up. `live` is a patch on a run that already exists,
  // so it never resumes anything.
  if (MODES[mode].door === 'runStart') {
    const resumable = resumeTarget(mode, run);
    if (resumable) payload.resumeRunId = resumable;
  }
  return payload;
}

/**
 * The run a launch picks up, if any.
 *
 * A `continue` resumes whatever it was given. A `phase` or a `start` resumes
 * only a run that has not finished — restarting a finished run would append to
 * a record that already closed.
 */
function resumeTarget(mode: RunSetupMode, run: RunState | null): string | undefined {
  if (!run) return undefined;
  if (mode === 'continue') return run.id;
  if (mode === 'start' || mode === 'phase') return run.status !== 'finished' ? run.id : undefined;
  return undefined;
}

/**
 * What an agent ticket is told — a QA review or a recovery.
 *
 * `skills` here is the MERGED list: a ticket has no attach flag for the server
 * to union in, so the merge is the caller's. That asymmetry with the run doors
 * is deliberate and pinned by the tests either side of it.
 */
export function buildTicket(
  mode: 'qa' | 'recovery',
  values: RunSetupValues,
  context: RunSetupContext,
  defaultSkills: string[],
): Record<string, unknown> {
  const skills = mergedSkills(values, defaultSkills);
  const body: Record<string, unknown> = { intent: mode };
  if (mode === 'qa') {
    body.slug = context.slug;
    body.phase = context.phase;
    // Only where the plan's gate is actually off and the console may write —
    // `context.activate` carries that judgement, `values.qa` carries the tick.
    if (context.activate && values.qa) body.activate = true;
  } else {
    body.recoveryClass = context.recoveryClass;
    body.slug = context.slug;
    if (context.phase != null) body.phase = context.phase;
    if (context.runId) body.runId = context.runId;
  }
  // `''` from a select means "this machine's default", which is an omission
  // rather than a value the server should validate.
  if (values.model) body.model = values.model;
  if (values.effort) body.effort = values.effort;
  if (mode === 'qa') body.permissionProfile = values.permissionProfile;
  // `auto` travels: the ticket door resolves it against the meters the same way
  // a run start does. Stripping it here meant picking "auto" on a repair ran
  // the session on the machine login — silently, and usually on the account
  // that had just hit the wall.
  if (values.accountId !== 'default') body.accountId = values.accountId;
  if (skills.length) body.skills = skills;
  return body;
}

/**
 * What a session the caller owns is told — the launcher, and the plan wizard.
 *
 * The wizard's ticket has no `permissionMode` and its skills arrive MERGED,
 * because a plan ticket has no attach flag for the server to union in. Both
 * asymmetries were already true; they are stated here rather than in two forms.
 */
export function buildLaunch(
  values: RunSetupValues,
  mode: RunSetupMode = 'session',
  defaultSkills: string[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: values.model, effort: values.effort };
  if (mode === 'plan') {
    const skills = mergedSkills(values, defaultSkills);
    if (skills.length) body.skills = skills;
    return body;
  }
  body.permissionMode = values.permissionMode;
  if (values.accountId !== 'default') body.accountId = values.accountId;
  if (values.prompt.trim()) body.prompt = values.prompt.trim();
  if (values.skills.length) body.skills = values.skills;
  return body;
}

/** The Automation preferences this form owns — one patch, merged server-side. */
export function buildPrefs(values: RunSetupValues): Record<string, unknown> {
  return {
    attachDefaultSkills: values.attachDefaultSkills,
    qaByDefault: values.qa,
    gitMode: values.gitMode,
    openPrOnComplete: values.openPr,
    autoRecoverByDefault: values.autoRecover,
    mcpPolicy: values.mcpPolicy,
  };
}

/** The machine's defaults plus what was ticked — order stable, no duplicates. */
export function mergedSkills(values: RunSetupValues, defaultSkills: string[]): string[] {
  return [...new Set([...(values.attachDefaultSkills ? defaultSkills : []), ...values.skills])];
}

/**
 * The permission choices a mode offers.
 *
 * One vocabulary, as the redesign promised — the same field, the same labels,
 * the same component. Sessions add "Plan only" and drop Bypass, because the
 * agent-ticket door refuses `bypassPermissions` outright; they also keep the
 * CLI's own two extra modes, which map onto no run profile and would otherwise
 * simply stop being reachable.
 */
export const PERMISSION_CHOICES: Readonly<Record<PermissionChoice | string, string>> = Object.freeze({
  guarded: 'Guarded — ask me about the irreversible',
  trusted: 'Trusted — only the deny list stops it',
  bypass: 'Bypass — the CLI stops asking too',
  plan: 'Plan only (read-only) — until a plan is approved',
  auto: 'Auto — the CLI decides what needs asking',
  dontAsk: 'Don’t ask — refuse rather than prompt',
});

export const RUN_PERMISSIONS = ['guarded', 'trusted', 'bypass'] as const;
export const SESSION_PERMISSIONS = ['guarded', 'trusted', 'plan', 'auto', 'dontAsk'] as const;
/** QA reviews offer the two the QA door accepts, under the same words. */
export const QA_PERMISSIONS = ['guarded', 'bypass'] as const;

/**
 * The CLI `--permission-mode` a session choice spells.
 *
 * Guarded is the CLI's own default (ask first), which the runner's vocabulary
 * writes as an omission rather than a value; Trusted is `acceptEdits`, the
 * closest honest analogue for a session a person is watching. `auto`,
 * `dontAsk` and `plan` are already CLI modes and pass through unchanged.
 */
export function permissionModeFor(choice: string): string {
  if (choice === 'guarded') return '';
  if (choice === 'trusted') return 'acceptEdits';
  return choice;
}

/** The inverse, for seeding the field from a session that already exists. */
export function permissionChoiceFor(mode: string | undefined): string {
  if (!mode || mode === 'manual' || mode === 'default') return 'guarded';
  if (mode === 'acceptEdits') return 'trusted';
  return mode;
}

export type { PhaseOptions };
