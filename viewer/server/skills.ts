/**
 * Which skills a phase could invoke.
 *
 * A plan can already name skills that every session must use — one line,
 * `**Skills (every session):**`, re-injected into every boot prompt by the
 * engine. That is the durable statement and it stays exactly as it is. What was
 * missing is everything around it: no way to see what is installed, no way to
 * turn one on for a single run, and no way to give one phase a skill the rest
 * of the plan has no use for.
 *
 * So this enumerates what the *child* would be able to invoke, from the same
 * Claude home the child will run in — the console can be started from any of
 * several homes and the session inherits its environment, so reading the wrong
 * one would offer skills that do not exist over there.
 *
 * Nothing here is authoritative about whether a skill will trigger; that is the
 * model's decision. It is authoritative about what may be *named*, which is
 * what a picker needs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { log } from './log.ts';
import { parseFrontMatter, scalar } from './parse/frontmatter.ts';

export type SkillSource = 'personal' | 'project' | 'plugin';

export type SkillInfo = {
  /** What you would type after the slash: `name` or `plugin:name`. */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  /** For plugin skills, the plugin that supplies it. */
  plugin?: string;
  path: string;
};

/** A skill directory nested deeper than this is not a skill directory. */
const MAX_DEPTH = 3;
/** Enough to be cheap on a tab switch, short enough to notice a new install. */
const CACHE_MS = 30_000;

/**
 * The Claude home the spawned session will use.
 *
 * `CLAUDE_CONFIG_DIR` is what the child inherits, so it is what decides which
 * `skills/` directory exists for it — not the one this file happens to live in.
 */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/* ------------------------------------------------------------------ *
 * Reading one skill
 * ------------------------------------------------------------------ */

/**
 * A skill's own account of itself.
 *
 * The frontmatter `name` is what the model invokes, and it is not always the
 * directory name — so the directory is only the fallback. A description over a
 * line or two is truncated: this is a picker, not the skill.
 */
export function readSkill(file: string, source: SkillSource, plugin?: string): SkillInfo | null {
  let text: string;
  try { text = readFileSync(file, 'utf8').slice(0, 8_000); } catch { return null; }

  const { values } = parseFrontMatter(text);
  const raw = values.name;
  const name = scalar(typeof raw === 'string' ? raw : '') || basename(join(file, '..'));
  if (!name || !/^[\w.-]+$/.test(name)) return null;

  const described = values.description;
  const description = scalar(typeof described === 'string' ? described : '')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

  return {
    id: plugin ? `${plugin}:${name}` : name,
    name,
    description,
    source,
    ...(plugin ? { plugin } : {}),
    path: file,
  };
}

/**
 * Every `SKILL.md` under a root, without descending forever.
 *
 * Dot-directories are skipped except `.claude`, because a real plugin on this
 * machine ships its skills at `<install>/.claude/skills/<name>/SKILL.md` and a
 * blanket dotfile skip made every one of them invisible.
 */
function findSkillFiles(root: string, depth = 0, found: string[] = []): string[] {
  if (depth > MAX_DEPTH || !existsSync(root)) return found;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return found; }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    if (entry.startsWith('.') && entry !== '.claude') continue;
    const full = join(root, entry);
    try {
      if (entry === 'SKILL.md') found.push(full);
      else if (statSync(full).isDirectory()) findSkillFiles(full, depth + 1, found);
    } catch { /* a file that vanished mid-walk is not a signal */ }
  }
  return found;
}

/**
 * Slash commands, which are invoked exactly like skills and are how several
 * plugins ship their entry point (`commands/feature-dev.md` →
 * `/feature-dev:feature-dev`). Their name comes from the FILENAME — the front
 * matter of a command carries a description and no name at all.
 */
function findCommandFiles(root: string): { file: string; name: string }[] {
  const dir = join(root, 'commands');
  if (!existsSync(dir)) return [];
  const out: { file: string; name: string }[] = [];
  const walk = (at: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(at); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(at, entry);
      try {
        if (statSync(full).isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      } catch { continue; }
      if (!entry.endsWith('.md')) continue;
      out.push({ file: full, name: entry.slice(0, -3) });
    }
  };
  walk(dir, 0);
  return out;
}

/** A command file, read as the skill it is invoked as. */
function readCommand(file: string, name: string, source: SkillSource, plugin?: string): SkillInfo | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  let text: string;
  try { text = readFileSync(file, 'utf8').slice(0, 8_000); } catch { return null; }
  const { values } = parseFrontMatter(text);
  const described = values.description;
  return {
    id: plugin ? `${plugin}:${name}` : name,
    name,
    description: scalar(typeof described === 'string' ? described : '').replace(/\s+/g, ' ').slice(0, 300),
    source,
    ...(plugin ? { plugin } : {}),
    path: file,
  };
}

/* ------------------------------------------------------------------ *
 * Plugins
 * ------------------------------------------------------------------ */

type InstalledPlugins = {
  plugins?: Record<string, { installPath?: string; lastUpdated?: string }[]>;
};

/**
 * Installed plugins, by the path they were actually installed to.
 *
 * Globbing the cache directory would be wrong: several versions of the same
 * plugin sit there side by side, and only one of them is the one a session
 * would load. The install record says which.
 */
export function installedPlugins(home: string): { plugin: string; path: string }[] {
  let config: InstalledPlugins;
  try { config = JSON.parse(readFileSync(join(home, 'plugins', 'installed_plugins.json'), 'utf8')) as InstalledPlugins; }
  catch { return []; }

  const out: { plugin: string; path: string }[] = [];
  for (const [key, entries] of Object.entries(config.plugins ?? {})) {
    // `plugin@marketplace`; the invocation prefix is the plugin alone.
    const plugin = key.split('@')[0];
    if (!plugin || !Array.isArray(entries)) continue;
    // Newest install wins when a plugin was installed more than once.
    const newest = [...entries]
      .filter((e) => e?.installPath)
      .sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')))[0];
    if (newest?.installPath && existsSync(newest.installPath)) {
      out.push({ plugin, path: newest.installPath });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Everything, once
 * ------------------------------------------------------------------ */

let cache: { at: number; home: string; root: string; value: SkillInfo[] } | null = null;

/**
 * Every skill a phase in this repo could invoke, sorted by where it comes from
 * and then by name. Duplicated ids are collapsed, keeping the more specific
 * source: a project skill shadows a personal one of the same name.
 */
export function listSkills(root: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillInfo[] {
  const home = claudeHome(env);
  const key = root ?? '';
  if (cache && cache.home === home && cache.root === key && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }

  const byId = new Map<string, SkillInfo>();
  const add = (skill: SkillInfo | null) => { if (skill && !byId.has(skill.id)) byId.set(skill.id, skill); };

  try {
    // Project first, so a repo's own version of a name is the one offered.
    if (root) {
      const project = join(root, '.claude');
      for (const file of findSkillFiles(join(project, 'skills'))) add(readSkill(file, 'project'));
      for (const { file, name } of findCommandFiles(project)) add(readCommand(file, name, 'project'));
    }
    for (const file of findSkillFiles(join(home, 'skills'))) add(readSkill(file, 'personal'));
    for (const { file, name } of findCommandFiles(home)) add(readCommand(file, name, 'personal'));
    for (const { plugin, path } of installedPlugins(home)) {
      for (const file of findSkillFiles(path)) add(readSkill(file, 'plugin', plugin));
      for (const { file, name } of findCommandFiles(path)) add(readCommand(file, name, 'plugin', plugin));
    }
  } catch (error) {
    log.warn('skills.scan', { error });
  }

  const order: Record<SkillSource, number> = { project: 0, personal: 1, plugin: 2 };
  const value = [...byId.values()].sort((a, b) =>
    order[a.source] - order[b.source] || a.id.localeCompare(b.id));

  cache = { at: Date.now(), home, root: key, value };
  return value;
}

export function forgetSkills(): void { cache = null; }

/**
 * What a session should do with a skill that keeps a per-repository index.
 *
 * Written CONDITIONALLY and in the general case on purpose. Some machines run a
 * skill that maintains durable per-repository state — a knowledge graph, a
 * search index — and such a skill is worth almost nothing if it is only ever
 * written: the value is in querying it at the START of a session, when the cost
 * of not knowing where something lives is highest, and refreshing it at the end,
 * when what changed is still known. A session naming the skill and never doing
 * either was the ordinary outcome, because nothing asked.
 *
 * It says "if a listed skill" rather than naming one, so a console with no such
 * skill installed carries a sentence that is simply vacuous rather than an
 * instruction to invoke something that does not exist. The per-repository half
 * matters as much: these graphs are built inside a repository and a query run
 * from the wrong directory answers about the wrong tree.
 */
const KNOWLEDGE_GRAPH_DIRECTIVE =
  'If a listed skill maintains a per-repository knowledge graph: at session START, query it for '
  + 'each repository this phase touches — run the query from inside that repository — and '
  + 'refresh/update the graph there before your handoff.';

/**
 * The line appended to a boot prompt for skills chosen in the console.
 *
 * Deliberately additive and deliberately separate from the engine's own text:
 * `phase-graph.sh` remains the only thing that decides what a boot prompt says
 * about the *plan*, including the plan's own skills line. This is the operator
 * adding to it for one run, and it reads as that.
 *
 * Every caller that names skills goes through here — the runner's phase prompts,
 * the agent launcher, the wizard, recovery sessions — which is why the directive
 * above lives in this function and not at one of them.
 */
export function skillDirective(skills: string[]): string {
  const named = [...new Set(skills.filter(Boolean))];
  if (!named.length) return '';
  return `\nAlso invoke ${named.length === 1 ? 'this skill' : 'these skills'} for this phase `
    + `(chosen for this run, in addition to any the plan names): ${named.map((s) => `/${s}`).join(', ')}\n`
    + `\n${KNOWLEDGE_GRAPH_DIRECTIVE}\n`;
}
