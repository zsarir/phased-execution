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
import { recoveryLabel, recoveryPrompt, type RecoveryFacts } from './recovery.ts';
import { qaLabel, qaPrompt, type QaFacts } from './qa-session.ts';
import { skillDirective, type SkillInfo } from './skills.ts';
import type { LaunchSpec, SessionMeta } from './terminal.ts';

/** A prompt bigger than this is a file, not a message. */
export const MAX_AGENT_PROMPT_BYTES = 16 * 1024;

/** The plan wizard's brief — roomy, but the composed prompt must still fit. */
export const MAX_BRIEF_BYTES = 8 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the run endpoints accept: `name` or `plugin:name`. */
const SKILL_ID = /^[\w.-]+(?::[\w.-]+)?$/;

/**
 * The permission profiles a QA session may be started under.
 *
 * Deliberately two rather than the runner's three. `trusted` is an *autopilot*
 * idea — it means "no approval card is raised", and there is no card here: a QA
 * session runs in a terminal a person is looking at, so the only real question
 * is whether the CLI asks that person before acting. Guarded is that CLI, and
 * bypass is the CLI told to stop asking, which is the one choice worth naming
 * because it is the one that can change a repository unattended.
 */
const QA_PROFILES = ['guarded', 'bypass'] as const;
type QaProfile = (typeof QA_PROFILES)[number];

export type AgentRefusal = { ok: false; status: number; error: string };

export type AgentContext = {
  /** Every skill the child could invoke, from the home it will inherit. */
  skills: () => SkillInfo[];
  /** The phased-execution scripts directory this console runs with. */
  scriptsDir: string;
  /** Whether a source root is open — the plan wizard needs one to write into. */
  rootOpen: boolean;
  /**
   * The resolved recovery briefing, for `intent: 'recovery'`.
   *
   * Composed by the service (which can read the board, the run, the lock and
   * the health issues) and passed in here rather than parsed from the body —
   * the browser names *what* to recover, never *what the prompt says*. Absent
   * for every other intent.
   */
  recovery?: RecoveryFacts;
  /**
   * The resolved QA briefing, for `intent: 'qa'`.
   *
   * Composed by the service (which reads the plan, the handoff, the commits and
   * the board) for the same two reasons the recovery briefing is: a page cannot
   * dictate what a review session is told, and a brief cannot claim an exit
   * criterion exists unless the plan holds one. Absent for every other intent.
   */
  qa?: QaFacts;
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
 *   intent:         a recovery: the server composes the prompt from the
 *     'recovery'    briefing it resolved (`ctx.recovery`), and stamps
 *                   `meta.recovery` so the exit can be checked against it
 *   intent: 'qa'    an independent review: the server composes the prompt from
 *                   the brief it resolved (`ctx.qa`), stamps `meta.qa` with the
 *                   verdict snapshot, and NEVER resumes — a review inherited
 *                   from the session that built the phase is not independent
 *   permissionProfile  `guarded` | `bypass`, QA sessions only; bypass is the
 *                   one place `sanitize`'s `allowBypass` is unlocked here
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

  if (body.intent != null && body.intent !== 'plan' && body.intent !== 'recovery' && body.intent !== 'qa') {
    return bad("intent, when given, must be 'plan', 'recovery' or 'qa'.");
  }
  const planIntent = body.intent === 'plan';
  const recoveryIntent = body.intent === 'recovery';
  const qaIntent = body.intent === 'qa';

  // Bypass is unlocked for ONE flow, named rather than implied. Widening it to
  // every agent session would be a different decision from the one this field
  // exists for, so the refusal is explicit and the surface stays where it was.
  const profileField = str(body.permissionProfile);
  if (profileField && !qaIntent) {
    return bad('permissionProfile is only accepted on a QA session — other sessions use permissionMode.');
  }
  if (profileField && !(QA_PROFILES as readonly string[]).includes(profileField)) {
    return bad(`permission profile must be one of: ${QA_PROFILES.join(', ')}.`);
  }
  const profile = (profileField ?? 'guarded') as QaProfile;
  if (profile === 'bypass' && permissionMode) {
    return bad('bypass IS the permission mode — send one or the other, not both.');
  }

  const prompt = str(body.prompt)?.trim();
  if (prompt && Buffer.byteLength(prompt) > MAX_AGENT_PROMPT_BYTES) {
    return bad('the prompt is too long (16 KB max).');
  }
  if (prompt && prompt.startsWith('-')) {
    return bad("a prompt may not begin with '-' — the CLI would read it as a flag.");
  }
  if (resume && prompt) return bad('resume and a prompt are mutually exclusive — the resumed session has its context.');
  if (resume && planIntent) return bad('resume and a plan brief are mutually exclusive.');
  if (resume && recoveryIntent) return bad('resume and a recovery are mutually exclusive — a recovery starts fresh.');
  // Said again here even though `parseQaRequest` refuses it first: this is the
  // function that composes argv, and "the review is never the session that
  // built it" must not depend on a caller having parsed the body correctly.
  if (resume && qaIntent) return bad('a QA session is a fresh review — it never resumes the session that built the phase.');

  // What the first message says, and what the session gets named after.
  let text = '';
  let named = '';
  let planSkill = '';
  let label: string | undefined;
  let recoveryMeta: SessionMeta['recovery'];
  let qaMeta: SessionMeta['qa'];
  if (planIntent) {
    if (prompt) return bad('a plan session composes its own prompt — send the brief instead.');
    const brief = str(body.brief)?.trim();
    if (!brief) return bad('a plan session needs a brief.');
    if (Buffer.byteLength(brief) > MAX_BRIEF_BYTES) return bad('the brief is too long (8 KB max).');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = phasedExecutionSkillId(ctx.skills());
    text = planPrompt(brief, planSkill, ctx.scriptsDir);
    named = brief;
  } else if (recoveryIntent) {
    if (prompt) return bad('a recovery session composes its own prompt.');
    // The service resolves the briefing before we are called; reaching here
    // without one is a wiring bug, not something a browser can provoke.
    const facts = ctx.recovery;
    if (!facts) return bad('that recovery could not be resolved.');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = facts.skillId;
    text = recoveryPrompt(facts);
    // Named from the thing it repairs, not from the prompt: `Recover <slug> P<N>`
    // reads as a row on the board, so sessions and phases scan together.
    label = recoveryLabel(facts);
    recoveryMeta = {
      kind: facts.class,
      slug: facts.slug,
      ...(facts.phase != null ? { phase: facts.phase } : {}),
      ...(facts.runId ? { runId: facts.runId } : {}),
    };
  } else if (qaIntent) {
    if (prompt) return bad('a QA session composes its own prompt.');
    // Resolved by the service before we are called; reaching here without a
    // briefing is a wiring bug, not something a browser can provoke.
    const facts = ctx.qa;
    if (!facts) return bad('that QA session could not be resolved.');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = facts.skillId;
    text = qaPrompt(facts);
    label = qaLabel(facts);
    // The snapshot the exit check compares against. Taken from the facts the
    // service resolved a moment ago, so "did this session record anything?" is
    // answered against the table as it stood when the session was minted.
    qaMeta = {
      slug: facts.slug,
      phase: facts.phase,
      ...(facts.previous?.result ? { before: facts.previous.result } : {}),
      ...(facts.previous?.report ? { beforeReport: facts.previous.report } : {}),
    };
  } else if (prompt) {
    text = prompt;
    named = prompt;
  }

  // The skill the composed prompt is already about; naming it again in the
  // directive would read as a second, competing instruction.
  const composed = planIntent || recoveryIntent || qaIntent;
  const extras = skillIds(body.skills).filter((id) =>
    id !== planSkill && !(composed && (id === 'phased-execution' || id.endsWith(':phased-execution'))));
  const directive = skillDirective(extras);
  if (directive) text = text ? `${text}\n${directive}` : directive.trim();

  if (text && Buffer.byteLength(text) > MAX_AGENT_PROMPT_BYTES) {
    return bad('the composed prompt is too long (16 KB max).');
  }

  const claudeSessionId = resume ?? randomUUID();
  label ??= labelFor(planIntent, named);

  const argv: string[] = [];
  if (resume) argv.push('--resume', resume);
  else argv.push('--session-id', claudeSessionId);
  // Guarded is the absence of the flag — the CLI's own "ask before acting",
  // which is what a person watching a terminal is there for.
  if (profile === 'bypass') argv.push('--permission-mode', 'bypassPermissions');
  else if (permissionMode) argv.push('--permission-mode', permissionMode);
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  if (label) argv.push('--name', label.slice(0, 80));

  // `sanitize` stays the single audit point: bypass is not special-cased here,
  // it is UNLOCKED here, by the one profile that may ask for it.
  const flags = sanitize(argv, profile === 'bypass' ? { allowBypass: true } : undefined);
  const args = text ? [...flags, text] : flags;

  const meta: SessionMeta = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // What the session is actually running under, not what was asked for: the
    // page that shows "bypass" must be reading the resolved argv's mode.
    ...(profile === 'bypass' ? { permissionMode: 'bypassPermissions' }
      : permissionMode ? { permissionMode } : {}),
    claudeSessionId,
    ...(planIntent ? { intent: 'plan' as const } : {}),
    // The linkage P2 built the session-exit announce policy around: a session
    // carrying it is always announced when it ends, and its outcome is checked
    // against the thing it was opened to fix.
    ...(recoveryMeta ? { intent: 'recovery' as const, recovery: recoveryMeta } : {}),
    // The linkage the exit check reads: a QA session's end is answered by
    // re-reading test-status.md rather than by reporting that a process ended.
    ...(qaMeta ? { intent: 'qa' as const, qa: qaMeta } : {}),
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
