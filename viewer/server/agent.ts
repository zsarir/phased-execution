/**
 * Agent sessions: an interactive `claude` in the browser terminal.
 *
 * This module is the only place claude argv for a terminal session is
 * composed, and everything in it is built from allowlisted fields — the
 * client can never pass argv, a command, an env var or a flag. The terminal
 * registry (`terminal.ts`) spawns exactly the `LaunchSpec` resolved here.
 *
 * ## Where the rules come from
 *
 * The vocabularies are the runner's, imported rather than re-declared, so a
 * model or mode that becomes acceptable for the autopilot is acceptable here
 * in the same commit: `MODEL_FALLBACK` (aliases the CLI takes), `EFFORTS`
 * (the CLI only *warns* on an unknown effort, so it is enforced here), and
 * `PERMISSION_MODES` — which deliberately does not contain
 * `bypassPermissions`, so refusing it needs no special case. The composed
 * argv still passes through `sanitize()`, the runner's single audit point
 * for forbidden flags, before the positional prompt is appended.
 *
 * ## Why the prompt is appended AFTER sanitize
 *
 * `sanitize()` inspects every argv slot; a prompt whose exact text is
 * `--bare` would be deleted as a forbidden flag. The prompt is user prose,
 * not a flag, so it is appended last — and the complementary guard is
 * validation: a prompt that *begins* with `-` is refused outright, so the
 * CLI can never parse it as an option either.
 *
 * ## Why the child env is the shell's, not the runner's
 *
 * `childEnv()` (runner/errors.ts) sets `CLAUDE_CODE_RETRY_WATCHDOG=1`, which
 * is documented for CI/unattended sessions: it retries rate limits
 * indefinitely and stretches transient failures to hours. On an *interactive*
 * TUI that looks like a hang to the person watching, who could simply retry.
 * So agent sessions inherit the same env a shell does (terminal.ts adds TERM
 * and COLORTERM — and `CLAUDE_CONFIG_DIR` rides along in process.env, which
 * is also the home `/api/skills` enumerates).
 */

import { randomUUID } from 'node:crypto';

import { EFFORTS, isEffort, PERMISSION_MODES, sanitize } from './runner/spawn.ts';
import { MODEL_FALLBACK as MODELS } from './runner/errors.ts';
import { skillDirective, type SkillInfo } from './skills.ts';
import type { LaunchSpec, SessionMeta } from './terminal.ts';

/** A prompt bigger than this is a file, not a message. */
export const MAX_AGENT_PROMPT_BYTES = 16 * 1024;

/** The plan wizard's brief — roomy, but the composed prompt must still fit. */
export const MAX_BRIEF_BYTES = 8 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the run endpoints accept: `name` or `plugin:name`. */
const SKILL_ID = /^[\w.-]+(?::[\w.-]+)?$/;

export type AgentRefusal = { ok: false; status: number; error: string };

export type AgentContext = {
  /** Every skill the child could invoke, from the home it will inherit. */
  skills: () => SkillInfo[];
  /** The phased-execution scripts directory this console runs with. */
  scriptsDir: string;
  /** Whether a source root is open — the plan wizard needs one to write into. */
  rootOpen: boolean;
};

/**
 * Validate a request body into a `LaunchSpec`, or say exactly why not.
 *
 * Every failure names the field and the allowed values; none of them creates
 * a session. The spec's fields:
 *
 *   model           ∈ MODEL_FALLBACK, optional (absent = the CLI's default)
 *   effort          ∈ EFFORTS, optional
 *   permissionMode  ∈ PERMISSION_MODES, optional
 *   prompt          ≤ 16 KB, may not begin with `-`, exclusive with intent
 *   skills          extra skill ids appended as a directive line
 *   resume          a claude session uuid → `--resume`, exclusive with both
 *   intent: 'plan'  the wizard: the server composes the prompt from `brief`
 *   brief           ≤ 8 KB, required (and only meaningful) with intent
 */
export function buildAgentLaunch(
  body: Record<string, unknown>,
  ctx: AgentContext,
): { ok: true; launch: LaunchSpec } | AgentRefusal {
  const bad = (error: string): AgentRefusal => ({ ok: false, status: 400, error });

  const model = str(body.model);
  if (model && !MODELS.includes(model)) return bad(`model must be one of: ${MODELS.join(', ')}.`);

  const effort = str(body.effort);
  if (effort && !isEffort(effort)) return bad(`effort must be one of: ${EFFORTS.join(', ')}.`);

  const permissionMode = str(body.permissionMode);
  if (permissionMode && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return bad(`permission mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
  }

  const resume = str(body.resume);
  if (resume && !UUID_RE.test(resume)) return bad('resume must be a claude session id (a uuid).');

  if (body.intent != null && body.intent !== 'plan') return bad("intent, when given, must be 'plan'.");
  const planIntent = body.intent === 'plan';

  const prompt = str(body.prompt)?.trim();
  if (prompt && Buffer.byteLength(prompt) > MAX_AGENT_PROMPT_BYTES) {
    return bad('the prompt is too long (16 KB max).');
  }
  if (prompt && prompt.startsWith('-')) {
    return bad("a prompt may not begin with '-' — the CLI would read it as a flag.");
  }
  if (resume && prompt) return bad('resume and a prompt are mutually exclusive — the resumed session has its context.');
  if (resume && planIntent) return bad('resume and a plan brief are mutually exclusive.');

  // What the first message says, and what the session gets named after.
  let text = '';
  let named = '';
  let planSkill = '';
  if (planIntent) {
    if (prompt) return bad('a plan session composes its own prompt — send the brief instead.');
    const brief = str(body.brief)?.trim();
    if (!brief) return bad('a plan session needs a brief.');
    if (Buffer.byteLength(brief) > MAX_BRIEF_BYTES) return bad('the brief is too long (8 KB max).');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = phasedExecutionSkillId(ctx.skills());
    text = planPrompt(brief, planSkill, ctx.scriptsDir);
    named = brief;
  } else if (prompt) {
    text = prompt;
    named = prompt;
  }

  // The plan skill is already the subject of the composed prompt; naming it
  // again in the directive would read as a second, competing instruction.
  const extras = skillIds(body.skills).filter((id) =>
    id !== planSkill && !(planIntent && (id === 'phased-execution' || id.endsWith(':phased-execution'))));
  const directive = skillDirective(extras);
  if (directive) text = text ? `${text}\n${directive}` : directive.trim();

  if (text && Buffer.byteLength(text) > MAX_AGENT_PROMPT_BYTES) {
    return bad('the composed prompt is too long (16 KB max).');
  }

  const claudeSessionId = resume ?? randomUUID();
  const label = labelFor(planIntent, named);

  const argv: string[] = [];
  if (resume) argv.push('--resume', resume);
  else argv.push('--session-id', claudeSessionId);
  if (permissionMode) argv.push('--permission-mode', permissionMode);
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  if (label) argv.push('--name', label.slice(0, 80));

  const flags = sanitize(argv);
  const args = text ? [...flags, text] : flags;

  const meta: SessionMeta = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    claudeSessionId,
    ...(planIntent ? { intent: 'plan' as const } : {}),
  };

  return {
    ok: true,
    launch: { kind: 'claude', file: 'claude', args, ...(label ? { label } : {}), meta },
  };
}

/**
 * The id the boot prompt should invoke for plan authoring.
 *
 * Clones offer the bare `phased-execution`; marketplace installs offer the
 * namespaced `<plugin>:phased-execution`. `listSkills` already ordered
 * project ahead of personal ahead of plugin, so the first exact id wins,
 * then any skill whose *name* is right, then the literal as a last resort —
 * a session can still resolve it even if discovery saw nothing.
 */
export function phasedExecutionSkillId(skills: SkillInfo[]): string {
  const exact = skills.find((skill) => skill.id === 'phased-execution');
  if (exact) return exact.id;
  const byName = skills.find((skill) => skill.name === 'phased-execution');
  return byName ? byName.id : 'phased-execution';
}

/**
 * The wizard's boot prompt: the skill's own Mode 1, spelled as steps, with
 * one deliberate override — step 6 stops instead of rolling into the root
 * phase, because in this product flow the phases are run from the console
 * once the operator has read the plan.
 *
 * Everything interpolated is machine-local (the scripts directory) or the
 * operator's own words (the brief); the committed template itself must stay
 * neutral — a test holds it to the same scrub patterns as the guide.
 */
export function planPrompt(brief: string, skillId: string, scriptsDir: string): string {
  return [
    `Invoke the ${skillId} skill (/${skillId}) and use its Mode 1 — plan — for the brief below.`,
    "You are in the repository this plan is for; the skill's helper scripts live at:",
    scriptsDir,
    '',
    "Follow the skill's own Mode 1 procedure end to end, in this session:",
    '',
    '1. Pick the session budget for the model that will EXECUTE the phases (the skill\'s',
    '   references/sizing.md) and author the FEWEST phases that fit it.',
    '2. Draft the plan in the shape references/plan-format.md requires. The "## Phase graph"',
    '   table is machine-read: every phase lists every dependency, plus Size tags (S/M/L),',
    '   exit criteria, and the blocking-vs-simultaneous callout.',
    `3. Scaffold the file first: bash ${scriptsDir}/new-plan.sh <slug> — then fill the`,
    '   template in at docs/plans/<slug>.md.',
    `4. Sanity-check: bash ${scriptsDir}/phase-graph.sh <slug> (every phase listed, the`,
    `   roots ready, suggested batches printed) and bash ${scriptsDir}/validate.sh <slug>.`,
    '5. Commit docs/plans/<slug>.md with a message naming the plan.',
    '6. Then STOP and summarise the plan — do not begin implementing phases; they run from',
    '   the console (or from later sessions) once the operator has read the plan.',
    '',
    'If the brief leaves a real decision open, ask before authoring — the operator is',
    'watching this terminal and will answer here.',
    '',
    'The brief:',
    '',
    brief,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Small parsers
 * ------------------------------------------------------------------ */

/** A non-empty string, or nothing — `''` from a form means "not chosen". */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Extra skill ids: shaped, deduped, capped — invalid entries dropped, not fatal. */
function skillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > 200 || !SKILL_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * What the tab and claude's own `/resume` picker call this session. Derived
 * from the operator's words rather than a counter, so five parked sessions
 * are five names, not `Claude 1` through `Claude 5` — the registry's counter
 * still names sessions launched bare.
 */
function labelFor(planIntent: boolean, text: string): string | undefined {
  const words = text.replace(/\s+/g, ' ').trim();
  if (!words) return undefined;
  const short = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
  return planIntent ? `Plan: ${short}` : `Claude: ${short}`;
}
