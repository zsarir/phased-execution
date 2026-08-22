/**
 * One form's shape, and what each field is called on the wire.
 *
 * `RunSetupValues` is the whole vocabulary — every choice any launch surface
 * ever offered, in one object. A mode does not get its own type: it gets a
 * subset of these fields to SHOW (`modes.ts`) and a payload builder that reads
 * the same values. That is the point of the consolidation; four shapes with
 * four spellings of "which model" is what let a run start on a model nobody
 * chose.
 *
 * ## The wire map is the contract
 *
 * `WIRE` says which server field each value becomes, or `null` for the ones
 * that never reach a run door (`prompt` is a session's first message;
 * `permissionMode` belongs to an agent ticket). `schema-parity.test.ts` walks
 * it against `shared/run-settings.js` in both directions, so:
 *
 * - a field the server accepts and this form cannot send fails the test, and
 * - a field this form would send that no door reads fails it too.
 *
 * `shared/run-settings.js` in turn is held against the route module's own
 * source by `test/run-settings-parity.test.ts`. Three files, one list.
 *
 * ## Why the numbers are strings
 *
 * Budgets, `maxParallel` and `maxConsecutiveFailures` are `<input type=number>`
 * values, and an empty one is `''`, not `0`. The distinction is load-bearing on
 * every one of them — `''` means "no ceiling" and `0` means "never" — so they
 * stay text through the form and are coerced once, at the payload boundary,
 * where the meaning of empty can be stated per field.
 */

import * as z from 'zod/mini';
import type { Autonomy, McpPolicy, PermissionProfile, PhaseOptions } from '@/lib/api';

/** The one permission vocabulary. `plan` is offered to sessions only. */
export type PermissionChoice = PermissionProfile | 'plan';

export interface RunSetupValues {
  model: string;
  effort: string;
  autonomy: Autonomy;
  /** Guarded / Trusted / Bypass, plus `plan` where a session is being minted. */
  permissionProfile: PermissionChoice;
  /** A session's CLI `--permission-mode`, when the choice above does not spell it. */
  permissionMode: string;
  accountId: string;
  onLimit: 'switch' | 'wait' | 'pause';
  phaseBudgetUsd: string;
  runBudgetUsd: string;
  gitMode: 'default-branch' | 'new-branch';
  openPr: boolean;
  qa: boolean;
  attachDefaultSkills: boolean;
  skills: string[];
  mcpServers: string[];
  mcpPolicy: McpPolicy;
  autoRecover: boolean;
  maxParallel: string;
  maxConsecutiveFailures: string;
  /** `"1,3,5-7"` — parsed at the payload boundary, so a half-typed range is not an error yet. */
  onlyPhases: string;
  phaseOptions: Record<string, PhaseOptions>;
  /** A session's first message. Never a run field. */
  prompt: string;
}

export type RunSetupField = keyof RunSetupValues;

/**
 * What each value is called on a run door — `null` where it is not a run field.
 *
 * Every name on the right-hand side must appear in `shared/run-settings.js`,
 * and every field in that module must appear here. The test says so.
 */
export const WIRE: Readonly<Record<RunSetupField, string | null>> = Object.freeze({
  model: 'model',
  effort: 'effort',
  autonomy: 'autonomy',
  permissionProfile: 'permissionProfile',
  permissionMode: null,
  accountId: 'accountId',
  onLimit: 'onLimit',
  phaseBudgetUsd: 'phaseBudgetUsd',
  runBudgetUsd: 'runBudgetUsd',
  gitMode: 'gitMode',
  openPr: 'openPr',
  qa: 'qa',
  attachDefaultSkills: 'attachDefaultSkills',
  skills: 'skills',
  mcpServers: 'mcpServers',
  mcpPolicy: 'mcpPolicy',
  autoRecover: 'autoRecover',
  maxParallel: 'maxParallel',
  maxConsecutiveFailures: 'maxConsecutiveFailures',
  onlyPhases: 'onlyPhases',
  phaseOptions: 'phaseOptions',
  prompt: null,
});

/**
 * The two run fields no VALUE carries, because they are facts about the
 * launch rather than choices in it: which run to resume, and which phases a
 * "run only this" was scoped to. The payload builders add them from context.
 */
export const CONTEXT_FIELDS = Object.freeze(['resumeRunId']);

/**
 * The resolver's schema.
 *
 * Deliberately permissive on vocabulary — the server re-validates every model
 * name against `scripts/models.env` and answers 400 with the reason, and a
 * client-side allow-list would refuse a name the CLI accepts the morning a new
 * model lands. What is checked here is what the server CANNOT explain as well
 * as the form can: a budget that is not a number, a parallel count outside the
 * console's own ceiling, a phase list that is not a phase list.
 */
export const runSetupSchema = z.object({
  model: z.string(),
  effort: z.string(),
  autonomy: z.enum(['keep-going', 'halt-on-everything']),
  permissionProfile: z.enum(['guarded', 'trusted', 'bypass', 'plan']),
  permissionMode: z.string(),
  accountId: z.string(),
  onLimit: z.enum(['switch', 'wait', 'pause']),
  phaseBudgetUsd: money('Budget per phase'),
  runBudgetUsd: money('Budget for the run'),
  gitMode: z.enum(['default-branch', 'new-branch']),
  openPr: z.boolean(),
  qa: z.boolean(),
  attachDefaultSkills: z.boolean(),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  mcpPolicy: z.enum(['continue', 'require']),
  autoRecover: z.boolean(),
  maxParallel: whole('Max parallel', 1, 99),
  maxConsecutiveFailures: whole('Stop after N failures', 1, 50),
  onlyPhases: z.string().check(
    z.refine(
      (text) => text.trim() === '' || /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(text),
      {
        message: 'Phases look like 1, 3, 5-7',
      },
    ),
  ),
  phaseOptions: z.record(z.string(), z.any()),
  prompt: z.string(),
});

/** `''` is "no ceiling"; anything else must be a non-negative number. */
function money(label: string) {
  return z.string().check(
    z.refine((text) => text.trim() === '' || (Number.isFinite(Number(text)) && Number(text) >= 0), {
      message: `${label} is a number of dollars, or empty for no ceiling`,
    }),
  );
}

/** `''` is "this console's own default"; anything else is a whole number in range. */
function whole(label: string, min: number, max: number) {
  return z
    .string()
    .check(
      z.refine(
        (text) =>
          text.trim() === '' ||
          (Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max),
        { message: `${label} is a whole number between ${min} and ${max}` },
      ),
    );
}

/**
 * A blank form. Never rendered as-is — every mode seeds over it from the
 * preferences, the run's own record, or the plan's bullets — but it is what
 * makes a missing seed a visible default rather than `undefined` reaching a
 * controlled input and turning it uncontrolled mid-edit.
 */
export const EMPTY: Readonly<RunSetupValues> = Object.freeze({
  model: '',
  effort: '',
  autonomy: 'keep-going',
  permissionProfile: 'guarded',
  permissionMode: '',
  accountId: 'default',
  onLimit: 'wait',
  phaseBudgetUsd: '',
  runBudgetUsd: '',
  gitMode: 'default-branch',
  openPr: true,
  qa: false,
  attachDefaultSkills: false,
  skills: [],
  mcpServers: [],
  mcpPolicy: 'continue',
  autoRecover: false,
  maxParallel: '',
  maxConsecutiveFailures: '',
  onlyPhases: '',
  phaseOptions: {},
  prompt: '',
});

/** `"1, 3, 5-7"` → `[1, 3, 5, 6, 7]`; empty or unreadable → `undefined`. */
export function parsePhases(text: string): number[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      // A backwards range is read the way it is written rather than dropped:
      // "7-5" is a typo with an obvious meaning, and silently sending nothing
      // would scope the run to the whole plan.
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) out.add(n);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isInteger(one)) out.add(one);
  }
  return out.size ? [...out].sort((a, b) => a - b) : undefined;
}

/** The inverse, for seeding the field from a run that already has a scope. */
export function formatPhases(phases: number[] | null | undefined): string {
  return phases?.length ? phases.join(', ') : '';
}
