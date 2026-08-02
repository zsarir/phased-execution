/**
 * Approvals: pausing an unattended run to ask a person.
 *
 * ## What actually holds, measured rather than assumed
 *
 * Claude Code's `http` PreToolUse hook **fails open**. Probed against a real
 * session with nothing listening on the hook URL: the tool call went straight
 * through, no error, no block. Probed with the broker answering `deny`: the
 * call was blocked and the session adapted. Both are true, and the first one
 * decides the architecture.
 *
 * So this module builds settings in two layers that must not be confused:
 *
 *   **`permissions.deny` — the wall.** Evaluated inside the CLI with no
 *   network involved, verified to hold with the broker unreachable. Everything
 *   that must never happen unattended lives here. Nothing can approve past it;
 *   a person runs those commands themselves, deliberately.
 *
 *   **`ask` + the HTTP hook — the workflow.** For work that *may* proceed with
 *   a human's say-so. The hook parks the session, shows evidence, and waits.
 *   It is a convenience with a nice phone interface, and if the console dies it
 *   silently stops existing — which is exactly why nothing dangerous may depend
 *   on it alone.
 *
 * A bare "Deploy? [y/n]" would automate the ceremony of approval and delete its
 * substance, so every card carries the evidence a person would have gone and
 * looked up: the command, the phase, the diff, the verification output.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { STATE_DIR } from '../config.ts';

/* ------------------------------------------------------------------ *
 * The two lists
 * ------------------------------------------------------------------ */

/**
 * Never, whatever anyone clicks. These reach a remote, spend money, destroy
 * data, or take the guard rails off — and an unattended agent has no business
 * doing any of them at 3am on the strength of a tap on a phone.
 *
 * Deliberately conservative and deliberately generic: this file ships in a
 * public skill, so repository-specific rules belong in the operator's own
 * `autopilot.json` rather than here.
 */
export const DEFAULT_DENY = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean:*)',
  'Bash(sudo:*)',
  'Bash(terraform apply:*)',
  'Bash(terraform destroy:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(docker push:*)',
  'Bash(kubectl delete:*)',
  'Bash(kubectl apply:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
  'Bash(mkfs:*)',
  'Bash(dd:*)',
];

/**
 * Allowed, but only with a person in the loop. These are the everyday
 * irreversible-ish steps of real work — a commit, a migration, a dependency
 * install — that a run should be able to reach, but not on its own.
 */
export const DEFAULT_ASK = [
  'Bash(git commit:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(npm install:*)',
  'Bash(pnpm add:*)',
  'Bash(alembic upgrade:*)',
  'Bash(psql:*)',
  'Bash(ssh:*)',
  'WebFetch',
  // The hook matcher has always covered WebSearch; the ask list did not, so it
  // was silently auto-allowed while its sibling raised a card.
  'WebSearch',
];

/**
 * Read-only work a phase does constantly, pre-approved so it never round-trips
 * to the hook.
 *
 * These ride at CLI scope, and permission rules **merge** across scopes rather
 * than override — so this adds to whatever the repository already allows, never
 * replaces it. That matters because a repository's own `.claude/settings.json`
 * allow rules are ignored until someone has accepted the workspace trust prompt
 * there, and a session that has lost them still has to be able to look around.
 */
export const DEFAULT_ALLOW = [
  'Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git branch:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(find:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(jq:*)', 'Bash(pwd:*)',
  'Bash(echo:*)', 'Bash(which:*)', 'Bash(node --version:*)', 'Bash(python3 --version:*)',
];

export type AutopilotPolicy = {
  deny: string[];
  ask: string[];
  allow: string[];
  /**
   * Rules the operator explicitly allowed — from a card's "Always…" button or
   * the Settings editor — which outrank `ask`.
   *
   * Evaluation is otherwise deny → ask → allow with first match winning and
   * specificity irrelevant, so a plain `allow` rule can never cancel an `ask`
   * rule: `Bash(git commit:*)` is on both lists and `ask` is reached first.
   * That would make "Always allow this" a button that writes a rule and
   * changes nothing, which is worse than not offering it. These are checked
   * immediately after `deny`, so the operator's own decision wins over the
   * built-in ask list and still loses to the wall.
   */
  always?: string[];
};

/* ------------------------------------------------------------------ *
 * The rule taxonomy
 * ------------------------------------------------------------------ */

/**
 * The tools whose calls actually reach the PreToolUse hook — the `matcher` in
 * `buildSettings` below. A rule about anything else is real, but it is enforced
 * by the CLI's own permission engine and this console never sees it, which is
 * a distinction the editor has to be able to show.
 */
export const HOOK_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

/** Tools whose *path* rules Claude Code does not consult at all. */
const PATH_RULES_IGNORED = ['Write', 'NotebookEdit', 'Glob'];

export type RuleForm =
  | 'bare' | 'prefix' | 'glob' | 'literal' | 'param'
  | 'path' | 'domain' | 'mcp' | 'agent' | 'cd';

export type ParsedRule = {
  raw: string;
  tool: string;
  spec?: string;
  form: RuleForm;
  /** `hook` = this console classifies it. `cli-only` = real, but enforced by the
   *  CLI. `ignored` = accepted by the syntax and silently does nothing. */
  support: 'hook' | 'cli-only' | 'ignored';
  note?: string;
};

/** The part of a tool call a rule is written against. */
function subjectOf(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const key = toolName === 'Bash' ? 'command'
    : toolName === 'WebFetch' || toolName === 'WebSearch' ? 'url'
      : toolName === 'Agent' ? 'subagent_type'
        : toolName === 'Cd' ? 'path'
          : 'file_path';
  const value = record[key]
    ?? record.command ?? record.file_path ?? record.path ?? record.url ?? record.pattern;
  return typeof value === 'string' ? value : '';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `*` spans anything. Used for command globs, where there are no segments. */
function globPattern(glob: string): string {
  return glob.split('*').map(escape).join('.*');
}

/**
 * Path globs, where `**` crosses separators and `*` does not — `Cd(~/code/*)`
 * is one segment deep and `Cd(~/code/**)` is any depth, and conflating them
 * would silently widen every path rule anyone writes.
 */
function pathPattern(glob: string): string {
  return glob
    .split('**').map((part) => part.split('*').map(escape).join('[^/]*'))
    .join('.*');
}

/**
 * Normalise the documented path prefixes to something matchable.
 *
 * `//abs` is an absolute path, `~/x` is under home, `./x` is relative to the
 * working directory, and a bare name with no separator means the file anywhere
 * — `Read(.env)` is `Read(**​/.env)`, which is the form that actually protects
 * a secret. A single leading slash is "relative to the settings file", whose
 * location this console does not know, so it is matched as a suffix and
 * labelled approximate rather than silently treated as absolute.
 */
function normalisePath(spec: string, home: string): string {
  const path = spec.trim();
  if (path.startsWith('//')) return path.slice(1);
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  if (path.startsWith('./')) return `**/${path.slice(2)}`;
  if (!path.includes('/')) return `**/${path}`;
  if (path.startsWith('/')) return `**${path}`;
  return `**/${path}`;
}

function pathMatches(spec: string, subject: string, home: string): boolean {
  if (!subject) return false;
  const pattern = normalisePath(spec, home);
  return new RegExp(`^${pathPattern(pattern)}$`).test(subject);
}

/** A tool-name pattern, which may be a glob or an MCP server prefix. */
function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName || pattern === '*') return true;
  if (pattern.includes('*')) return new RegExp(`^${globPattern(pattern)}$`).test(toolName);
  // `mcp__server` covers every tool that server exposes.
  if (pattern.startsWith('mcp__') && !pattern.slice(5).includes('__')) {
    return toolName.startsWith(`${pattern}__`);
  }
  return false;
}

/** `key:value`, where the key is a real identifier — not a command prefix. */
const PARAM = /^([A-Za-z_][\w]*):(.*)$/s;

/**
 * Read one rule, or return null if it is not a rule at all.
 *
 * The form matters as much as the match: the editor has to be able to say "this
 * one is enforced here", "this one is the CLI's job", and "this one parses and
 * does nothing" — and the last category is the one that silently costs people
 * an afternoon.
 */
export function parseRule(raw: string): ParsedRule | null {
  const rule = raw.trim();
  if (!rule || rule.length > 200) return null;

  let tool = rule;
  let spec: string | undefined;
  const open = rule.indexOf('(');
  if (open !== -1) {
    if (!rule.endsWith(')')) return null;
    tool = rule.slice(0, open).trim();
    spec = rule.slice(open + 1, -1);
  }
  if (!/^[A-Za-z_*][\w*]*$/.test(tool)) return null;

  const isMcp = tool.startsWith('mcp__');
  const hooked = HOOK_TOOLS.includes(tool);
  const at = (form: RuleForm, support: ParsedRule['support'], note?: string): ParsedRule =>
    ({ raw: rule, tool, spec, form, support, note });

  if (spec === undefined || spec === '*') {
    if (isMcp) return at('mcp', 'cli-only', 'MCP calls do not reach this console’s hook');
    return at('bare', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook`);
  }

  // The documented trap: it looks like a parameter rule and is simply dropped.
  if (tool === 'Bash' && /^command:/.test(spec)) {
    return at('param', 'ignored', 'Bash(command:…) is not a rule Claude Code honours — write Bash(<prefix>:*)');
  }
  if (PATH_RULES_IGNORED.includes(tool) && !PARAM.test(spec)) {
    return at('path', 'ignored', `${tool}(…) path rules are never consulted — only Read(…) and Edit(…) are`);
  }

  // Before the `:*` prefix form, which `domain:*` would otherwise satisfy —
  // and a domain rule read as a command prefix matches nothing at all.
  if ((tool === 'WebFetch' || tool === 'WebSearch') && spec.startsWith('domain:')) {
    return at('domain', 'hook');
  }
  // `:*` is a command prefix and is only meaningful at the end.
  if (spec.endsWith(':*') && !isMcp) {
    return at('prefix', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook`);
  }
  if (tool === 'Read' || tool === 'Edit') {
    return at('path', tool === 'Edit' ? 'hook' : 'cli-only',
      tool === 'Read' ? 'Read calls do not reach this console’s hook' : undefined);
  }
  if (tool === 'Cd') return at('cd', 'cli-only', 'Cd is enforced by the CLI, not by this hook');
  if (tool === 'Agent' && !PARAM.test(spec)) {
    return at('agent', 'cli-only', 'Agent calls do not reach this console’s hook');
  }
  if (PARAM.test(spec)) {
    return at('param', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook`);
  }
  if (isMcp) return at('mcp', 'cli-only', 'MCP calls do not reach this console’s hook');
  return at(spec.includes('*') ? 'glob' : 'literal', hooked ? 'hook' : 'cli-only',
    hooked ? undefined : `${tool} calls do not reach this console’s hook`);
}

/**
 * Does a permission rule cover this call?
 *
 * `Tool` matches every use of that tool; `Tool(prefix:*)` matches on a command
 * prefix — at a word boundary, because `Bash(ls:*)` is `Bash(ls *)` and `lsof`
 * is not `ls`. Getting that wrong silently widens the built-in allow list,
 * which is the direction that matters.
 */
export function ruleMatches(
  rule: string, toolName: string, input: unknown, home = homedir(),
): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.support === 'ignored') return false;
  if (!toolNameMatches(parsed.tool, toolName)) return false;
  if (parsed.form === 'bare' || parsed.form === 'mcp') return true;

  const spec = parsed.spec as string;

  if (parsed.form === 'param') {
    const found = PARAM.exec(spec);
    if (!found) return false;
    const value = (input as Record<string, unknown> | null)?.[found[1]];
    if (value === undefined || value === null) return false;
    return new RegExp(`^${globPattern(found[2])}$`).test(String(value));
  }

  if (parsed.form === 'domain') {
    const subject = subjectOf(toolName, input);
    if (!subject) return false;
    let host: string;
    try { host = new URL(subject).hostname; } catch { return false; }
    const want = spec.slice('domain:'.length).trim();
    if (want === '*') return true;
    if (want.startsWith('*.')) return host.endsWith(want.slice(1));
    return host === want;
  }

  const subject = subjectOf(toolName, input);
  if (!subject) return false;

  if (parsed.form === 'path' || parsed.form === 'cd') return pathMatches(spec, subject, home);
  if (parsed.form === 'agent') return subject === spec;
  if (parsed.form === 'prefix') {
    const prefix = spec.slice(0, -2);
    return subject === prefix || subject.startsWith(`${prefix} `);
  }
  if (parsed.form === 'glob') return new RegExp(`^${globPattern(spec)}$`).test(subject);
  return subject === spec || subject.startsWith(`${spec} `);
}

/** Rules that parse but do nothing, so startup can say so once. */
export function inertRules(policy: AutopilotPolicy): ParsedRule[] {
  const seen = new Set<string>();
  const out: ParsedRule[] = [];
  for (const rule of [...policy.deny, ...policy.ask, ...policy.allow, ...(policy.always ?? [])]) {
    if (seen.has(rule)) continue;
    seen.add(rule);
    const parsed = parseRule(rule);
    if (!parsed) out.push({ raw: rule, tool: '', form: 'literal', support: 'ignored', note: 'not a rule this syntax accepts' });
    else if (parsed.support === 'ignored') out.push(parsed);
  }
  return out;
}

/**
 * Every command a shell line would actually run.
 *
 * Prefix rules match the start of a command, so `git add x && git commit -m y`
 * begins with `git add` and slips past a `Bash(git commit:*)` rule entirely.
 * That is not a corner case — it is how anyone naturally writes it, and a real
 * run committed straight through the ask list this way. Worse, the same hole
 * applies to the deny rules: `cd /tmp && git push` begins with `cd`.
 *
 * The CLI's own matching is what it is and we cannot change it. What we can do
 * is look at each segment ourselves, so the hook is stricter than the rule list
 * it was given rather than exactly as leaky.
 */
export function commandSegments(command: string): string[] {
  const segments = command
    .split(/&&|\|\||[;\n|]/)
    .map((part) => unwrapSubshell(part.trim()))
    .filter(Boolean);
  // A wrapped command is still that command: `nohup git push` must hit the
  // same deny rule `git push` does.
  const out = new Set(segments);
  for (const segment of segments) {
    const inner = stripWrappers(segment);
    if (inner) out.add(inner);
  }
  return [...out];
}

/**
 * Strip the parentheses a subshell leaves on a segment.
 *
 * `(cd sub && npm publish)` splits into `(cd sub` and `npm publish)`, and the
 * trailing bracket is not cosmetic: a prefix rule matched at a word boundary
 * sees `npm publish)`, which is not `npm publish`, and the deny rule misses.
 * Only *unbalanced* brackets are dropped, so `echo $(date)` keeps its own.
 */
function unwrapSubshell(segment: string): string {
  let text = segment.replace(/^\(\s*/, '');
  while (text.endsWith(')')) {
    const opens = (text.match(/\(/g) ?? []).length;
    const closes = (text.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    text = text.slice(0, -1).trimEnd();
  }
  return text;
}

/**
 * Wrappers Claude Code looks through when it matches a rule.
 *
 * The list is exactly the one it documents, and its edges are the point:
 * `npx`, `docker exec` and `devbox run` are NOT on it, so `npx some-publisher`
 * is matched as `npx` and a rule about the thing it runs never fires. Nothing
 * here can fix that — but the console can at least be honest about it, which is
 * what `WRAPPERS_NOT_STRIPPED` is for.
 */
const WRAPPERS = ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs'];
export const WRAPPERS_NOT_STRIPPED = ['npx', 'docker exec', 'devbox run'];

/**
 * Peel the wrappers off a command, or return null if there were none.
 *
 * `xargs` only when bare: `xargs rm` runs `rm`, but `xargs -I{} sh -c …` is a
 * different animal and pretending to see through it would be a guess.
 */
export function stripWrappers(command: string): string | null {
  let rest = command.trim();
  let peeled = false;
  for (;;) {
    const found = /^([A-Za-z_][\w-]*)\s+(.*)$/s.exec(rest);
    if (!found) break;
    const [, head, tail] = found;
    if (!WRAPPERS.includes(head)) break;
    // `timeout 30s cmd` / `nice -n 5 cmd`: drop the wrapper's own arguments.
    if (head === 'xargs' && /^-/.test(tail)) break;
    let next = tail;
    while (/^-\S*\s+/.test(next) || /^\d+[smhd]?\s+/.test(next)) next = next.replace(/^\S+\s+/, '');
    if (!next) break;
    rest = next;
    peeled = true;
  }
  return peeled ? rest : null;
}

/**
 * Shapes that must never resolve to a silent yes.
 *
 * Each one runs a command this console cannot see: `watch` re-runs it forever,
 * `setsid` detaches it from the session, `flock` hands it a lock and a shell,
 * and `find -exec` runs it once per matched file. Matching the outer command
 * tells you nothing about what actually executes, so they get a card rather
 * than the benefit of the doubt.
 */
const NEVER_AUTO = /^(watch|setsid|flock)\b|(^|\s)find\s+.*\s-exec\b/;

export function neverAutoApproves(command: string): boolean {
  return commandSegments(command).some((segment) => NEVER_AUTO.test(segment));
}

/**
 * What to do with one tool call, before any human is involved.
 *
 * The filter the first real run proved was missing. The PreToolUse hook fires
 * on every matching tool, so without it a phase parks on `find docs -type f`
 * and waits for someone to tap Allow on a read-only listing. A supervisor that
 * asks about everything is one nobody reads, and a queue nobody reads is worse
 * than no queue: it trains the answer "yes".
 */
export function classifyTool(
  toolName: string, input: unknown, policy: AutopilotPolicy,
): 'deny' | 'ask' | 'allow' {
  const subjects: unknown[] = [input];
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    for (const segment of commandSegments(command)) subjects.push({ command: segment });
  }
  const hits = (rules: string[]) =>
    rules.some((rule) => subjects.some((subject) => ruleMatches(rule, toolName, subject)));

  // The wall first, and nothing gets past it — not an operator's own rule, not
  // a profile, not a tap on a phone.
  if (hits(policy.deny)) return 'deny';
  // Then what this operator deliberately allowed, which is the only thing that
  // can outrank the built-in ask list. See `AutopilotPolicy.always`.
  if (hits(policy.always ?? [])) return 'allow';
  if (hits(policy.ask)) return 'ask';
  // A command whose real payload is hidden inside a wrapper gets a person,
  // never a default yes.
  if (typeof command === 'string' && neverAutoApproves(command)) return 'ask';
  return 'allow';
}

/* ------------------------------------------------------------------ *
 * Profiles: how much this run may do without being asked
 * ------------------------------------------------------------------ */

export const PERMISSION_PROFILES = ['guarded', 'trusted', 'bypass'] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === 'string' && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

export const PROFILE_LABELS: Record<PermissionProfile, string> = {
  guarded: 'Guarded — ask about the irreversible',
  trusted: 'Trusted — only the deny list stops it',
  bypass: 'Bypass — the CLI stops asking too',
};

/**
 * The policy one profile actually runs under.
 *
 * Only the ask list moves. `deny` is the wall and is identical in all three —
 * a profile that could widen it would make the wall a preference, and the whole
 * reason `deny` is trustworthy is that it is enforced by the CLI with this
 * console unreachable.
 */
export function profilePolicy(policy: AutopilotPolicy, profile: PermissionProfile): AutopilotPolicy {
  if (profile === 'guarded') return policy;
  return { ...policy, ask: [] };
}

const POLICY_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'phase-console',
);
const POLICY_FILE = join(POLICY_DIR, 'autopilot.json');

/**
 * One plan's own rules, beside the global ones.
 *
 * "Always allow this" almost always means "in this plan" — a repository's
 * deploy verb is safe to commit through in the plan that owns it and is not
 * safe everywhere. A per-plan file makes that the cheap answer instead of
 * making the global list the only place to say anything.
 */
export function planPolicyPath(slug: string, dir = POLICY_DIR): string {
  // The slug reaches this from a URL, so it decides a filename and nothing
  // else. Separators are gone before any dot handling, so nothing can climb
  // out of the directory; the dots are then collapsed as well, because a name
  // containing `..` invites the next reader to wonder whether it can.
  const safe = slug
    .replace(/[^\w.-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return join(dir, 'plans', `${safe || 'unnamed'}.json`);
}

export type PolicyScope = 'plan' | 'global';

/**
 * The operator's own rules, merged on top of the defaults. A repository with
 * its own dangerous verbs — a deploy task, a box-mutating Taskfile target —
 * adds them here; the public skill never needs to know about them.
 *
 * Merged, never replaced: a policy file that forgot `git push` must not
 * quietly become a policy that permits it.
 */
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/** Just the operator's own additions, unmerged — what the file actually holds. */
export function policyExtras(file = POLICY_FILE): AutopilotPolicy {
  let extra: Partial<AutopilotPolicy> = {};
  try { extra = JSON.parse(readFileSync(file, 'utf8')) as Partial<AutopilotPolicy>; }
  catch { /* no policy file is the normal case */ }
  return { deny: strings(extra.deny), ask: strings(extra.ask), allow: strings(extra.allow) };
}

export function loadPolicy(file = POLICY_FILE): AutopilotPolicy {
  return mergePolicy([policyExtras(file)]);
}

/**
 * The rules one plan runs under: the defaults, the operator's global file, then
 * the plan's own — the later ones only ever adding.
 */
export function loadPolicyFor(
  slug: string | null, globalFile = POLICY_FILE, dir = POLICY_DIR,
): AutopilotPolicy {
  const extras = [policyExtras(globalFile)];
  if (slug) extras.push(policyExtras(planPolicyPath(slug, dir)));
  return mergePolicy(extras);
}

function mergePolicy(extras: AutopilotPolicy[]): AutopilotPolicy {
  const flat = (pick: (e: AutopilotPolicy) => string[]) => extras.flatMap(pick);
  const written = flat((e) => e.allow);
  return {
    deny: [...new Set([...DEFAULT_DENY, ...flat((e) => e.deny)])],
    ask: [...new Set([...DEFAULT_ASK, ...flat((e) => e.ask)])],
    allow: [...new Set([...DEFAULT_ALLOW, ...written])],
    // Only what a person actually wrote outranks the ask list — never the
    // built-in allow list, which exists so a phase can look around and would
    // cancel half the ask rules if it were given that power.
    always: [...new Set(written)],
  };
}

export const POLICY_PATH = POLICY_FILE;
export const POLICY_DIRECTORY = POLICY_DIR;

/** A rule the syntax accepts. Anything else never reaches a file. */
const validRules = (list: string[]) => list
  .map((rule) => rule.trim())
  .filter((rule) => parseRule(rule) !== null);

/**
 * Edit one policy file: add rules, remove rules, at one scope.
 *
 * **This widens as well as tightens, which reverses an earlier choice.** The
 * old rule was that a browser could only ever make a run more careful, and the
 * reasoning was sound: the worst case of a stray click should be a run that
 * stops to ask about something it needn't have. What that produced in practice
 * was ten `git commit` cards in one run and a person tapping Allow without
 * reading — which is the failure the strict version was supposed to prevent,
 * arriving by a different road. A queue nobody reads trains the answer "yes".
 *
 * So widening is allowed, and every widening is: named (the exact rule string
 * is shown before it is written), attributed (`by`), scoped (this plan by
 * default, everywhere only if asked), journaled, and reversible from the same
 * screen. What it still cannot do is touch `deny` — that list is the wall, and
 * removing from it here would make the wall a preference.
 */
export function editPolicy(
  edit: {
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    by?: string;
  },
  file = POLICY_FILE,
): AutopilotPolicy {
  const current = policyExtras(file);
  const drop = (list: string[], removals: string[]) => {
    const gone = new Set(removals.map((rule) => rule.trim()));
    return list.filter((rule) => !gone.has(rule.trim()));
  };

  const next: AutopilotPolicy = {
    deny: [...new Set([
      ...drop(current.deny, strings(edit.remove?.deny)),
      ...validRules(strings(edit.add?.deny)),
    ])],
    ask: [...new Set([
      ...drop(current.ask, strings(edit.remove?.ask)),
      ...validRules(strings(edit.add?.ask)),
    ])],
    allow: [...new Set([
      ...drop(current.allow, strings(edit.remove?.allow)),
      ...validRules(strings(edit.add?.allow)),
    ])],
  };

  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log.info('policy.updated', {
    file,
    by: edit.by ?? 'unknown',
    added: {
      deny: strings(edit.add?.deny).length,
      ask: strings(edit.add?.ask).length,
      allow: strings(edit.add?.allow).length,
    },
    removed: {
      deny: strings(edit.remove?.deny).length,
      ask: strings(edit.remove?.ask).length,
      allow: strings(edit.remove?.allow).length,
    },
    now: { deny: next.deny.length, ask: next.ask.length, allow: next.allow.length },
  });
  return next;
}

/**
 * Add rules to the operator's policy file — the tightening-only path, kept
 * because it is what the existing `POST /api/policy` contract promises.
 */
export function addPolicyRules(
  rules: { deny?: string[]; ask?: string[] }, file = POLICY_FILE,
): AutopilotPolicy {
  return editPolicy({ add: { deny: strings(rules.deny), ask: strings(rules.ask) } }, file);
}

/**
 * The rule a card should offer to write.
 *
 * Derived from the ask rule that actually stopped the call, so accepting it
 * cancels exactly the thing that just interrupted — no more, and nothing that
 * merely resembles it. Only when nothing matched (a profile switch, a rule
 * edited underneath a live card) does it fall back to naming the tool and the
 * first two words of the command, which is the narrowest honest guess.
 */
export function suggestedRule(toolName: string, input: unknown, policy: AutopilotPolicy): string {
  const subjects: unknown[] = [input];
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    for (const segment of commandSegments(command)) subjects.push({ command: segment });
  }
  for (const rule of policy.ask) {
    if (subjects.some((subject) => ruleMatches(rule, toolName, subject))) return rule;
  }
  if (typeof command === 'string') {
    const head = commandSegments(command)[0] ?? command;
    const words = head.trim().split(/\s+/).slice(0, 2).join(' ');
    return words ? `Bash(${words}:*)` : 'Bash';
  }
  return toolName;
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

/**
 * Only two, on purpose. The docs also describe `defer`, but this hook fails
 * open, and an unrecognised decision is indistinguishable from no answer at
 * all — the difference between "wait for me" and "go ahead unsupervised" would
 * come down to a spelling. `deny` is the behaviour actually measured against a
 * live session, so a timeout denies and says it timed out.
 */
export type Decision = 'allow' | 'deny';

export type Evidence = { label: string; body: string };

export type Approval = {
  id: string;
  runId: string;
  slug: string;
  phase: number | null;
  /**
   * `verify` is not a permission question. It asks a person to confirm a check
   * the runner could not make itself — a browser step, a look at a dashboard —
   * so no hook is blocked on the far end and it can afford to wait far longer.
   */
  kind: 'gate' | 'tool' | 'verify';
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: { name: string; input: unknown; cwd?: string };
  /**
   * The rule the card offers to write, shown before anything is written.
   * "Always allow this" without saying what "this" turns into is how a policy
   * file grows rules nobody can account for.
   */
  suggestedRule?: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | Decision | 'expired';
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
};

type Waiting = { approval: Approval; settle: (decision: Decision, by: string, reason?: string) => void; timer: NodeJS.Timeout };

/**
 * The hook's own timeout governs how long the session waits. Answer a little
 * before it, so the decision is ours and reads as a decision — not as the
 * silence that fails open.
 *
 * **An hour, not ten minutes.** At ten, a real overnight run put up ten `git
 * commit` cards and one of them was refused because nobody was awake — and a
 * denied commit at minute ten is the worst outcome available: the work is done,
 * the tree is dirty, and the session is told "no" for a reason that is really
 * "you were asleep". The limit is checked, not guessed: the CLI validates a
 * hook's `timeout` as `number().positive().optional()` **seconds with no upper
 * bound** (read out of the 2.1.220 binary), so an hour is honoured rather than
 * silently clamped back to a value we would then answer after.
 *
 * The socket has to survive it too, which is why `server/index.ts` sets its own
 * `requestTimeout`: Node would otherwise destroy a request this old, and a
 * destroyed hook request is silence, and silence fails open.
 */
export const HOOK_TIMEOUT_SECONDS = 3600;
const ANSWER_BY_MS = (HOOK_TIMEOUT_SECONDS - 20) * 1000;

/** Said to the session, and to the person, when a card ran out of time. */
export const TIMEOUT_REASON = 'nobody answered in time — the phase is parked, not failed; '
  + 'answer the card and retry the phase';

/* ------------------------------------------------------------------ *
 * Telling someone, when nobody is looking at the tab
 * ------------------------------------------------------------------ */

/**
 * Run the operator's own notifier, if they set one.
 *
 * The console can raise a browser notification, and that covers the case where
 * a tab is open somewhere. It does not cover the case the whole design is for:
 * the run is unattended and so is the operator. `PHASE_CONSOLE_NOTIFY` is a
 * command — `terminal-notifier`, a curl to a webhook, an `ntfy` publish — given
 * the title as `$1` and the body as `$2`.
 *
 * Deliberately an environment variable and NOT a browser-settable preference:
 * it runs a command on this machine, and nothing reachable from a web page
 * should be able to choose which. Failures are logged and never propagated —
 * a broken notifier must not be able to stop a run.
 */
export function notifyOutOfBand(title: string, body: string, env = process.env): void {
  const command = env.PHASE_CONSOLE_NOTIFY;
  if (!command) return;
  try {
    execFile(command, [title, body], { timeout: 10_000 }, (error) => {
      if (error) log.warn('notify.failed', { command, error: error.message });
    });
  } catch (error) {
    log.warn('notify.failed', { command, error });
  }
}

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

const PENDING_FILE = join(STATE_DIR, 'approvals', 'pending.json');

/**
 * Pending approvals, on disk.
 *
 * A card lived only in memory, so restarting the console with a phase parked
 * on "these checks need a person" erased the question and the evidence
 * gathered for it — the phase came back as `interrupted` and what it had been
 * asking was simply gone.
 *
 * What is restored is deliberately NOT answerable. The promise a decision
 * would have resolved died with the process, and so did the hook socket on the
 * far end; a card offering Allow and Deny to something nobody is listening to
 * would be the same lie as a Pause button that changes nothing. They come back
 * as what they are: questions that were never answered, with their evidence,
 * marked expired.
 */
function writePending(pending: Approval[], file: string): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn('approvals.persist', { error });
  }
}

export function readPending(file = PENDING_FILE): Approval[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Approval[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class Approvals {
  private waiting = new Map<string, Waiting>();
  private history: Approval[] = [];
  private token: Buffer | null = null;
  private tokenText: string | null = null;
  private runId: string | null = null;
  private counter = 0;
  private notify: (approval: Approval) => void;
  private file: string;

  constructor(notify: (approval: Approval) => void = () => {}, file = PENDING_FILE) {
    this.notify = notify;
    this.file = file;
    // Anything an earlier console was still asking about, recovered as record.
    for (const approval of readPending(file)) {
      this.history.push({
        ...approval,
        status: 'expired',
        reason: approval.reason
          ?? 'the console restarted before this was answered — the session it was asking for is gone',
      });
    }
    if (this.history.length) {
      log.info('approvals.recovered', { count: this.history.length });
      writePending([], file);
    }
  }

  /** Keep the on-disk copy in step with what is genuinely outstanding. */
  private flush(): void {
    writePending([...this.waiting.values()].map((w) => w.approval), this.file);
  }

  /* ---- the per-run token ---- */

  /**
   * Mint a token for one run. The hook endpoint is unauthenticated otherwise —
   * anything on this machine could POST to it — so the token is what ties a
   * request to the run we started, and it dies with the run.
   */
  arm(runId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.token = Buffer.from(token);
    this.tokenText = token;
    this.runId = runId;
    return token;
  }

  /**
   * The token this run is already using.
   *
   * Rewriting the settings file mid-run — which is how a profile change reaches
   * the next phase — must NOT mint a new one. The running child loaded its
   * `Authorization` header at startup and cannot reload it; a fresh token would
   * make its next hook call unauthorised, and an unauthorised hook call is a
   * failed hook call, and this hook fails open. The profile switch would
   * silently turn the supervisor off.
   */
  liveToken(): string | null {
    return this.tokenText;
  }

  disarm(): void {
    this.token = null;
    this.tokenText = null;
    this.runId = null;
    // Anything still waiting is answered rather than left hanging: a session
    // blocked on a dead broker would sit there until the hook timed out.
    for (const [id] of this.waiting) this.settle(id, 'deny', 'run ended', 'the run ended before this was decided');
  }

  /** Constant-time, so a wrong token leaks nothing about the right one. */
  verify(header: string | undefined): boolean {
    if (!this.token || !header) return false;
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    if (presented.length !== this.token.length) return false;
    return timingSafeEqual(presented, this.token);
  }

  armed(): boolean { return this.token !== null; }

  /* ---- the queue ---- */

  /**
   * Park until somebody decides, or until we are nearly out of the hook's
   * patience. Answering just before the hook's own timeout matters: our answer
   * is a decision, its timeout is silence, and silence lets the call through.
   */
  request(
    request: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    answerByMs = ANSWER_BY_MS,
  ): { approval: Approval; decided: Promise<{ decision: Decision; by: string; reason?: string }> } {
    const id = `${Date.now().toString(36)}-${++this.counter}`;
    const approval: Approval = {
      ...request,
      id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + answerByMs).toISOString(),
      status: 'pending',
    };

    const decided = new Promise<{ decision: Decision; by: string; reason?: string }>((resolve) => {
      const settle = (decision: Decision, by: string, reason?: string) => {
        const entry = this.waiting.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete(id);
        approval.status = decision;
        approval.decidedAt = new Date().toISOString();
        approval.decidedBy = by;
        approval.reason = reason;
        this.remember(approval);
        this.flush();
        resolve({ decision, by, reason });
      };
      // Unreferenced: the listening socket is what keeps this process alive, and
      // a pending approval must never be the reason it cannot exit.
      //
      // It still answers `deny`, and it has to: the hook fails open, so saying
      // nothing is saying yes, unsupervised, to the one call nobody watched.
      // What changes is what happens next — `by: 'timeout'` parks the run
      // instead of letting the session treat a refusal as a verdict and work
      // around it. See `Service.decideToolUse`.
      const timer = setTimeout(
        () => settle('deny', 'timeout', TIMEOUT_REASON),
        answerByMs,
      ).unref();
      this.waiting.set(id, { approval, settle, timer });
      this.flush();
    });

    log.info('approval.requested', { id, runId: approval.runId, phase: approval.phase, title: approval.title });
    try { this.notify(approval); } catch { /* a notifier must never block a decision */ }
    return { approval, decided };
  }

  settle(id: string, decision: Decision, by: string, reason?: string): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    log.info('approval.decided', { id, decision, by });
    entry.settle(decision, by, reason);
    return true;
  }

  pending(): Approval[] { return [...this.waiting.values()].map((w) => w.approval); }
  recent(limit = 50): Approval[] { return this.history.slice(-limit); }
  all(): Approval[] { return [...this.pending(), ...this.recent()]; }

  private remember(approval: Approval): void {
    this.history.push(approval);
    if (this.history.length > 200) this.history.shift();
  }
}

/* ------------------------------------------------------------------ *
 * The settings handed to each child
 * ------------------------------------------------------------------ */

export type SettingsOptions = {
  runId: string;
  token: string;
  /** Where this console is listening — the child posts its hook calls here. */
  origin: string;
  policy?: AutopilotPolicy;
  /** How much this run may do unasked. Only `bypass` changes the child's argv. */
  profile?: PermissionProfile;
};

export function buildSettings(opts: SettingsOptions): Record<string, unknown> {
  const policy = profilePolicy(opts.policy ?? loadPolicy(), opts.profile ?? 'guarded');
  return {
    permissions: {
      // `allow` rides along because permission rules merge across scopes: it
      // adds to what the repository already permits and cannot take anything
      // away. Only `deny` and `allow` go to the CLI.
      allow: policy.allow,
      // Only `deny` goes to the CLI. It is the layer that holds with the console
      // dead — verified, not assumed.
      //
      // `ask` deliberately does NOT: there is nobody at a terminal to prompt in
      // `-p` mode, so an ask rule resolves to a refusal the session cannot get
      // past. A real run stalled exactly there — `notes/one.md` written, commit
      // refused, the session politely waiting for a prompt that would never
      // appear. Asking a human is the hook's job, because the hook is the only
      // part of this that can actually reach one.
      deny: policy.deny,
    },
    hooks: {
      PreToolUse: [
        {
          // Only the tools that can reach outside this repo are worth a round
          // trip; matching everything would put a network hop in front of every
          // Read and turn a phase into a slideshow.
          matcher: 'Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch',
          hooks: [
            {
              type: 'http',
              url: `${opts.origin}/hooks/pre-tool-use`,
              headers: { Authorization: `Bearer ${opts.token}` },
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write the settings where only this user can read them.
 *
 * `--settings` takes a file or a JSON string, and a string would put the run
 * token in argv, which `ps` shows to every account on the machine. A 0600 file
 * in the state directory does not.
 */
export function writeSettingsFile(runId: string, settings: Record<string, unknown>): string {
  const dir = join(STATE_DIR, 'settings');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-${runId}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is only applied on create; an existing file keeps its
  // own, so set it explicitly rather than trusting the happy path.
  chmodSync(path, 0o600);
  return path;
}
