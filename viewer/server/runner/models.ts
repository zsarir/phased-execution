/**
 * Reads `scripts/models.env` — the F5-style single source for the MODEL
 * vocabulary, shared with the bash engine exactly the way `sizing.env`,
 * `mcp.env` and `verify.env` are: bash sources the file, this module
 * regex-parses the same lines, and a drift test (`test/models-env.test.ts`)
 * holds the two readers — and the hardcoded fallback — to the same sets.
 *
 * What this replaced. The vocabulary was previously one array (`MODEL_FALLBACK`
 * in `errors.ts`) that doubled as the allowed-values list, plus five unrelated
 * regexes that each re-spelled the same alternation, plus two bash globs. The
 * failure mode was never a crash; it was silence. `routes.ts` validated a
 * per-phase model by EXACT membership in the four aliases, so a phase asking
 * for `claude-opus-5` — a name the CLI takes happily — was dropped without a
 * word and ran on the run's default. The same door rejected `opus[1m]`.
 *
 * The three questions every caller actually asks, and why they are separate:
 *
 *  - `modelFamily()` — which quota does this spend? A `[1m]` variant is still
 *    Opus to the usage endpoint, so the family of `claude-opus-5[1m]` is
 *    `opus`, deliberately. Escalation rank is family rank for the same reason.
 *  - `is1m()` — which context window did the operator ask for? This is the one
 *    question the family cannot answer, and the only one the budget cares
 *    about.
 *  - `isKnownModel()` — should the door take this string? Matching is by
 *    family substring rather than exact equality, because the CLI ships dated
 *    ids (`claude-haiku-4-5-20251001`) and a lineup refresh must not turn into
 *    a 400 on the day it lands. Garbage (`gpt-4`, `bogus-model-xyz`) still
 *    fails, which is the whole point of having a door.
 *
 * The fallback exists for a console driving an OLDER scripts directory that
 * predates the file; it must be kept identical to the file's contents, which
 * is what the drift test pins.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ModelsEnv = {
  /** Aliases, strongest first. The order IS the escalation ladder. */
  aliases: readonly string[];
  /** alias → canonical full id. */
  ids: ReadonlyMap<string, string>;
  /** Aliases that select a mode rather than a model; no rank, passed through. */
  modes: ReadonlySet<string>;
  /** The context-window suffix the CLI understands on either spelling. */
  oneM: string;
  /** Aliases whose per-session budget class is the big one. */
  big: ReadonlySet<string>;
  /** Families the 1M window is actually available on — for pick lists only. */
  oneMCapable: readonly string[];
};

export const MODELS_ENV_FALLBACK: ModelsEnv = {
  aliases: ['fable', 'opus', 'sonnet', 'haiku'],
  ids: new Map([
    ['fable', 'claude-fable-5'],
    ['opus', 'claude-opus-5'],
    ['sonnet', 'claude-sonnet-5'],
    ['haiku', 'claude-haiku-4-5'],
  ]),
  modes: new Set(['opusplan']),
  oneM: '[1m]',
  big: new Set(['fable', 'opus', 'sonnet', 'mythos']),
  oneMCapable: ['fable', 'opus', 'sonnet'],
};

const cache = new Map<string, ModelsEnv>();

/** Parse one `KEY="a b c"` line into an ordered list, or null when absent. */
function readList(text: string, key: string): string[] | null {
  const match = new RegExp(`^${key}="([^"]*)"`, 'm').exec(text);
  return match ? match[1].split(/\s+/).filter(Boolean) : null;
}

/** Parse one `KEY="a=1 b=2"` line into a Map, or null when absent. */
function readPairs(text: string, key: string): Map<string, string> | null {
  const list = readList(text, key);
  if (!list) return null;
  const out = new Map<string, string>();
  for (const entry of list) {
    const eq = entry.indexOf('=');
    if (eq > 0) out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

/** Parse one `KEY="value"` line as a single token, or null when absent. */
function readWord(text: string, key: string): string | null {
  const match = new RegExp(`^${key}="([^"]*)"`, 'm').exec(text);
  return match ? match[1].trim() : null;
}

export function loadModelsEnv(scriptsDir: string): ModelsEnv {
  const hit = cache.get(scriptsDir);
  if (hit) return hit;
  let env = MODELS_ENV_FALLBACK;
  try {
    const text = readFileSync(join(scriptsDir, 'models.env'), 'utf8');
    env = {
      aliases: readList(text, 'MODEL_ALIASES') ?? MODELS_ENV_FALLBACK.aliases,
      ids: readPairs(text, 'MODEL_IDS') ?? MODELS_ENV_FALLBACK.ids,
      modes: new Set(readList(text, 'MODEL_MODES') ?? [...MODELS_ENV_FALLBACK.modes]),
      oneM: readWord(text, 'MODEL_1M_SUFFIX') || MODELS_ENV_FALLBACK.oneM,
      big: new Set(readList(text, 'MODEL_BIG') ?? [...MODELS_ENV_FALLBACK.big]),
      oneMCapable: readList(text, 'MODEL_1M_CAPABLE') ?? MODELS_ENV_FALLBACK.oneMCapable,
    };
  } catch { /* an older scripts dir without the file — the fallback holds */ }
  cache.set(scriptsDir, env);
  return env;
}

/**
 * The alias a name belongs to, by substring in alias order, or null.
 *
 * Substring rather than equality so every spelling of one model answers the
 * same: `opus`, `claude-opus-5`, `claude-opus-5[1m]` are all `opus`. Alias
 * ORDER decides ties, which is why `models.env` documents the order as
 * load-bearing — a longer name containing a shorter one must come first.
 */
export function modelFamily(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  return env.aliases.find((alias) => lower.includes(alias)) ?? null;
}

/** Did the operator ask for the 1M window? The one thing the family cannot say. */
export function is1m(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): boolean {
  return Boolean(model) && model!.toLowerCase().includes(env.oneM.toLowerCase());
}

/** A mode alias (`opusplan`) — accepted at the doors, but never ranked. */
export function isModelMode(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): boolean {
  return Boolean(model) && env.modes.has(model!.toLowerCase().trim());
}

/**
 * Should a door accept this string as a model?
 *
 * Deliberately permissive about real Claude names and strict about everything
 * else. The alternative the tree used to run — exact membership in four
 * aliases — rejected `claude-opus-5`, which is the spelling the CLI's own
 * `--help` gives as an example.
 */
export function isKnownModel(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): boolean {
  if (!model || !model.trim()) return false;
  return isModelMode(model, env) || modelFamily(model, env) !== null;
}

/** The canonical full id for a name, or the name itself when it is already one. */
export function canonicalModelId(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): string | undefined {
  if (!model) return undefined;
  const family = modelFamily(model, env);
  if (!family) return model;
  const trimmed = model.toLowerCase().trim();
  if (trimmed !== family && trimmed !== `${family}${env.oneM}`) return model;
  const id = env.ids.get(family) ?? family;
  return is1m(model, env) ? `${id}${env.oneM}` : id;
}

export type BudgetClass = '1m' | 'haiku' | 'big' | 'default';

/**
 * Which per-session budget class a model falls in.
 *
 * `[1m]` wins over the family, because the suffix is a window selector and the
 * window is the only thing the budget is a function of. Everything else keeps
 * the classification the tree has always had, so no existing plan re-batches.
 */
export function budgetClassOf(model?: string, env: ModelsEnv = MODELS_ENV_FALLBACK): BudgetClass {
  if (!model || !model.trim()) return 'default';
  if (is1m(model, env)) return '1m';
  const lower = model.toLowerCase();
  for (const alias of env.big) if (lower.includes(alias)) return 'big';
  if (modelFamily(model, env) === 'haiku') return 'haiku';
  return 'default';
}

/**
 * Every model name worth OFFERING, strongest first, with its 1M variant where
 * that window is actually available.
 *
 * Separate from `isKnownModel` on purpose. This is the pick list; that is the
 * door. `haiku[1m]` is absent here because the API refuses it today, and
 * present there because a subscription can gain the beta without the console
 * shipping a new version.
 */
export function offeredModels(env: ModelsEnv = MODELS_ENV_FALLBACK): string[] {
  const out: string[] = [];
  for (const alias of env.aliases) {
    out.push(alias);
    if (env.oneMCapable.includes(alias)) out.push(`${alias}${env.oneM}`);
  }
  return out;
}
