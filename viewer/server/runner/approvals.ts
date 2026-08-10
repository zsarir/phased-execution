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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { INSTANCE, INSTANCE_STATE_DIR } from '../config.ts';

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

/** How many words deep to look inside a wrapper. Long enough for any real one. */
const WRAPPED_WORDS = 40;

/**
 * Candidate payloads hidden inside a wrapper `stripWrappers` refuses to peel.
 *
 * `watch`, `setsid`, `flock` and `find -exec` are deliberately not peelable:
 * their arguments vary enough that a formal strip would be a guess, and a guess
 * that answers "safe" is the worst possible answer. But refusing to guess left
 * the wall unable to see a denied command hidden one word in — `flock /tmp/l
 * git push` matched no deny rule, because rules match the START of a command.
 *
 * So this does the one thing that cannot make the wall weaker: it offers every
 * suffix of the line as a candidate. A rule matching any of them is a rule that
 * would have matched the payload had it been written on its own. It can only
 * ever turn an allow into a deny — never the reverse.
 */
export function wrappedPayloads(command: string): string[] {
  const words = command.trim().split(/\s+/).slice(0, WRAPPED_WORDS);
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) out.push(words.slice(i).join(' '));
  return out;
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
  profile: PermissionProfile = 'guarded',
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
  // never a default yes — but only where a person is what this run asked for.
  //
  // `profilePolicy` empties the ask list for trusted and bypass, and this
  // fallback sat below it answering 'ask' regardless: on a bypass run, where
  // nobody is watching by definition, the card went up, waited out the hook's
  // full hour, and timed out into a deny. The CLI renders that deny with its
  // own canned wording — "The user doesn't want to proceed with this tool use"
  // — so a standing configuration read as a person refusing the work, and the
  // run parked. A profile that says "stop asking me" has to reach here too.
  if (typeof command === 'string' && neverAutoApproves(command)) {
    if (profile === 'guarded') return 'ask';
    // Letting the wrapper run is a decision about who is watching, never about
    // the wall — so before the benefit of the doubt is given, the deny list gets
    // a second look at what the wrapper is carrying. See `wrappedPayloads`.
    if (hitsHidden(command, toolName, policy.deny)) return 'deny';
  }
  return 'allow';
}

/** Whether any rule matches something a wrapper is carrying. See `wrappedPayloads`. */
function hitsHidden(command: string, toolName: string, rules: string[]): boolean {
  const payloads = wrappedPayloads(command);
  return rules.some((rule) => payloads.some((c) => ruleMatches(rule, toolName, { command: c })));
}

/**
 * The deny rule that stopped a call, for saying so out loud.
 *
 * `classifyTool` answers what to do; this answers which line of policy decided
 * it, which is what turns "not approved" into something an operator can go and
 * edit. Returns null when nothing in the deny list matches.
 */
export function matchedDenyRule(
  toolName: string, input: unknown, policy: AutopilotPolicy,
): string | null {
  const subjects: unknown[] = [input];
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    for (const segment of commandSegments(command)) subjects.push({ command: segment });
  }
  const direct = policy.deny.find(
    (rule) => subjects.some((subject) => ruleMatches(rule, toolName, subject)),
  );
  if (direct) return direct;
  // A deny reached by looking inside a wrapper still has to be able to name
  // itself, or the reply says "blocked by the deny list" and cannot say which
  // line — the one thing the operator will ask next.
  if (typeof command !== 'string') return null;
  const payloads = wrappedPayloads(command);
  return policy.deny.find(
    (rule) => payloads.some((c) => ruleMatches(rule, toolName, { command: c })),
  ) ?? null;
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
 *
 * `alwaysAsk` survives the emptying: the openPr carve-out (below) needs its
 * two rules to raise a card even under `trusted`, because a push and a PR are
 * the run's one world-visible act and the deal is one human tap.
 */
export function profilePolicy(
  policy: AutopilotPolicy, profile: PermissionProfile,
  opts?: { alwaysAsk?: readonly string[] },
): AutopilotPolicy {
  if (profile === 'guarded') return policy;
  const kept = opts?.alwaysAsk?.length
    ? policy.ask.filter((rule) => opts.alwaysAsk!.includes(rule))
    : [];
  return { ...policy, ask: kept };
}

/* ------------------------------------------------------------------ *
 * The openPr carve-out: the one deliberate hole in the push wall
 * ------------------------------------------------------------------ */

/** The deny rule the carve-out moves to ask — and only this exact rule. */
export const PUSH_DENY = 'Bash(git push:*)';

/**
 * What replaces it. The destructive push shapes stay walled: the carve-out
 * exists so a finished plan can publish ONE new branch, not so anything can
 * rewrite or delete what a remote already has.
 */
export const PUSH_DENY_CARVED = [
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --delete:*)',
  'Bash(git push origin --delete:*)',
];

/** The asks that survive every profile while the carve-out is on. */
export const OPEN_PR_ASK = ['Bash(git push:*)', 'Bash(gh pr create:*)'];

/**
 * The effective policy for one run, carve-out and profile applied together.
 *
 * Scoped to a run, never to the console: only a run started with
 * `gitMode: 'new-branch'` and PR-on-completion gets it, which is the narrowest
 * shape that lets the final phase actually push its branch. The residual risk
 * is stated in the docs — with this console dead, that run's CLI-side deny no
 * longer contains bare `git push` — and force/delete pushes stay denied at
 * both layers regardless.
 */
export function carvedPolicy(
  policy: AutopilotPolicy, profile: PermissionProfile, openPrCarveOut: boolean,
): AutopilotPolicy {
  if (!openPrCarveOut) return profilePolicy(policy, profile);
  const carved: AutopilotPolicy = {
    ...policy,
    // Conditional on the wall actually standing: a carve-out narrows a rule
    // the policy holds, it never resurrects one the operator struck. With the
    // push wall struck, swapping in the force-push denials would quietly
    // re-add per run what a named, journaled edit removed for good.
    deny: policy.deny.includes(PUSH_DENY)
      ? [...policy.deny.filter((rule) => rule !== PUSH_DENY), ...PUSH_DENY_CARVED]
      : policy.deny,
    // The "one human tap to publish" asks are about the RUN shape, not the
    // wall — pinned whether or not the wall stands.
    ask: [...new Set([...policy.ask, ...OPEN_PR_ASK])],
  };
  return profilePolicy(carved, profile, { alwaysAsk: OPEN_PR_ASK });
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
export function planPolicyPath(slug: string, dir = POLICY_DIR, instance = INSTANCE.id): string {
  return join(dir, 'plans', pathSafe(instance), `${pathSafe(slug)}.json`);
}

/**
 * Where a plan's rules lived before consoles had identities.
 *
 * Read as a fallback, never written. Two projects that both have a plan called
 * `migration` used to share one policy file — "always allow this deploy verb"
 * said in one repository silently applied in the other, which is precisely the
 * kind of quiet widening a policy file exists to prevent. Keying by instance
 * fixes it going forward; reading the old path keeps every rule an operator has
 * already written working until they next edit it, at which point it is
 * rewritten to the keyed location and belongs to one project.
 */
export function legacyPlanPolicyPath(slug: string, dir = POLICY_DIR): string {
  return join(dir, 'plans', `${pathSafe(slug)}.json`);
}

/**
 * A slug or an instance id as one path segment, and nothing else.
 *
 * Both reach this from a URL or a registry file, so each decides a filename and
 * nothing more. Separators are gone before any dot handling, so nothing can
 * climb out of the directory; the dots are then collapsed as well, because a
 * name containing `..` invites the next reader to wonder whether it can.
 */
function pathSafe(value: string): string {
  return value
    .replace(/[^\w.-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'unnamed';
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

/**
 * Shipped defaults the operator has struck — recorded by name rather than by
 * replacing the default lists, so an upgrade that ships a NEW default rule
 * still applies it (a copied-then-edited list would freeze the defaults at
 * whatever version the first edit saw).
 *
 * `deny` is on this shape since 2026-08-06, a deliberate reversal: the shipped
 * deny list used to be unstrikeable from a browser ("the wall"), and what that
 * produced in practice was a parked plan behind a push the operator wanted
 * made, with no remedy on the screen that showed the problem. A deny strike is
 * still the widest edit this file can express, so it stays named, attributed,
 * scoped, journaled, and reversible — and the UI confirms it before writing.
 * What did NOT change: strikes are by name, so upgrades still land every
 * default they do not name, and profiles still never move deny.
 */
export type PolicyRemovals = { deny: string[]; ask: string[]; allow: string[] };

export type PolicyFileExtras = AutopilotPolicy & { removed: PolicyRemovals };

/** Just the operator's own edits, unmerged — what the file actually holds. */
export function policyExtras(file = POLICY_FILE): PolicyFileExtras {
  let extra: Partial<AutopilotPolicy & { removed?: Partial<PolicyRemovals> }> = {};
  try { extra = JSON.parse(readFileSync(file, 'utf8')) as typeof extra; }
  catch { /* no policy file is the normal case */ }
  return {
    deny: strings(extra.deny),
    ask: strings(extra.ask),
    allow: strings(extra.allow),
    removed: {
      deny: strings(extra.removed?.deny),
      ask: strings(extra.removed?.ask),
      allow: strings(extra.removed?.allow),
    },
  };
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
  if (slug) extras.push(policyExtras(effectivePlanPolicyPath(slug, dir)));
  return mergePolicy(extras);
}

/**
 * The plan-policy file actually in force: the keyed one if it exists, else the
 * legacy unkeyed one.
 *
 * Never both. Merging them would resurrect a rule the operator had already
 * edited away in the keyed copy, which is the one direction a policy file must
 * never move on its own.
 */
export function effectivePlanPolicyPath(slug: string, dir = POLICY_DIR): string {
  const keyed = planPolicyPath(slug, dir);
  return existsSync(keyed) ? keyed : legacyPlanPolicyPath(slug, dir);
}

function mergePolicy(extras: PolicyFileExtras[]): AutopilotPolicy {
  const flat = (pick: (e: PolicyFileExtras) => string[]) => extras.flatMap(pick);
  const written = flat((e) => e.allow);
  // Struck shipped defaults, at any contributing scope: a global strike hides
  // the default everywhere, a plan strike only where that plan's file was
  // merged in. All three lists filter the same way — a struck deny is the
  // widest of them, and everything downstream (profiles, the carve-out, the
  // settings handed to children) consumes this merge, so the strike holds
  // everywhere at once or nowhere at all.
  const struckDeny = new Set(flat((e) => e.removed.deny));
  const struckAsk = new Set(flat((e) => e.removed.ask));
  const struckAllow = new Set(flat((e) => e.removed.allow));
  return {
    deny: [...new Set([...DEFAULT_DENY.filter((r) => !struckDeny.has(r)), ...flat((e) => e.deny)])],
    ask: [...new Set([...DEFAULT_ASK.filter((r) => !struckAsk.has(r)), ...flat((e) => e.ask)])],
    allow: [...new Set([...DEFAULT_ALLOW.filter((r) => !struckAllow.has(r)), ...written])],
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
 * screen. Since 2026-08-06 that includes the shipped deny list — see
 * `PolicyRemovals` for the reversal and its terms. A struck deny rule is the
 * widest edit expressible here, because it also leaves the CLI-side settings
 * every child runs under: the layer that holds with the console dead moves
 * with it. That is the point, and the risk, in one sentence — which is why the
 * browser confirms a shipped-deny strike before sending it.
 */
export function editPolicy(
  edit: {
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /**
     * Return these parts to stock: the operator's own rules come out AND their
     * strikes against shipped defaults are forgiven, in one named act — for
     * all three lists alike.
     */
    reset?: ('deny' | 'ask' | 'allow')[];
    /**
     * Forgive individual strikes: the named shipped defaults apply again,
     * WITHOUT becoming file rules — an add would render them as the
     * operator's own, and a restored default is nobody's edit.
     */
    restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    by?: string;
  },
  file = POLICY_FILE,
): AutopilotPolicy {
  const current = policyExtras(file);
  const resets = new Set(strings(edit.reset));
  const drop = (list: string[], removals: string[]) => {
    const gone = new Set(removals.map((rule) => rule.trim()));
    return list.filter((rule) => !gone.has(rule.trim()));
  };

  /**
   * A removal means one of two things, decided here so the × on a chip is one
   * gesture: a rule the FILE holds is dropped from it; a rule that is a
   * SHIPPED default is struck by name instead — recorded in `removed`,
   * filtered out at merge time, resurrected by `restore` or `reset`. The same
   * two branches for all three lists; deny joined them in the 2026-08-06
   * reversal (see `PolicyRemovals`).
   */
  const removedDeny = strings(edit.remove?.deny).map((r) => r.trim());
  const removedAsk = strings(edit.remove?.ask).map((r) => r.trim());
  const removedAllow = strings(edit.remove?.allow).map((r) => r.trim());
  const strikes = {
    deny: removedDeny.filter((r) => DEFAULT_DENY.includes(r) && !current.deny.includes(r)),
    ask: removedAsk.filter((r) => DEFAULT_ASK.includes(r) && !current.ask.includes(r)),
    allow: removedAllow.filter((r) => DEFAULT_ALLOW.includes(r) && !current.allow.includes(r)),
  };
  // Two ways back from a strike, both forgiving it: `restore` names the
  // default and nothing else changes; an `add` of the same rule also
  // un-strikes, because a strike sitting beside an add would win silently.
  const unstruckDeny = new Set([
    ...validRules(strings(edit.add?.deny)),
    ...strings(edit.restore?.deny).map((r) => r.trim()),
  ]);
  const unstruckAsk = new Set([
    ...validRules(strings(edit.add?.ask)),
    ...strings(edit.restore?.ask).map((r) => r.trim()),
  ]);
  const unstruckAllow = new Set([
    ...validRules(strings(edit.add?.allow)),
    ...strings(edit.restore?.allow).map((r) => r.trim()),
  ]);

  const removed: PolicyRemovals = {
    deny: resets.has('deny')
      ? []
      : [...new Set([...current.removed.deny, ...strikes.deny])].filter((r) => !unstruckDeny.has(r)),
    ask: resets.has('ask')
      ? []
      : [...new Set([...current.removed.ask, ...strikes.ask])].filter((r) => !unstruckAsk.has(r)),
    allow: resets.has('allow')
      ? []
      : [...new Set([...current.removed.allow, ...strikes.allow])].filter((r) => !unstruckAllow.has(r)),
  };

  const part = (
    name: 'deny' | 'ask' | 'allow',
  ): string[] => {
    if (resets.has(name)) return validRules(strings(edit.add?.[name]));
    return [...new Set([
      ...drop(current[name], strings(edit.remove?.[name])),
      ...validRules(strings(edit.add?.[name])),
    ])];
  };

  const next: AutopilotPolicy & { removed?: PolicyRemovals } = {
    deny: part('deny'),
    ask: part('ask'),
    allow: part('allow'),
    // Written only when it says something — most policy files never strike a
    // default, and an empty key would read as a feature they used.
    ...(removed.deny.length || removed.ask.length || removed.allow.length ? { removed } : {}),
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
    struckDefaults: { deny: strikes.deny.length, ask: strikes.ask.length, allow: strikes.allow.length },
    ...(resets.size ? { reset: [...resets] } : {}),
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

const PENDING_FILE = join(INSTANCE_STATE_DIR, 'approvals', 'pending.json');

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

/**
 * The two moments worth telling somebody about, and they are not the same one.
 *
 * `notify` fires when a card is **raised** — before any decision exists, which
 * is exactly what makes it useful and what `test/approvals.test.ts` pins.
 * `resolved` fires when the question is **answered**, by whatever answered it:
 * a click here, a tap on a phone, the timeout, or the run ending underneath it.
 *
 * Without the second one a decision was true only in the browser that made it.
 * Every other client kept showing a card that had already been settled, and
 * pressing it produced a 404 — a phantom that outlived the thing it referred
 * to. Broadcasting resolution is what makes one queue seen from three places
 * one queue.
 */
export type ApprovalHooks = {
  notify?: (approval: Approval) => void;
  resolved?: (approval: Approval) => void;
};

export class Approvals {
  private waiting = new Map<string, Waiting>();
  private history: Approval[] = [];
  /**
   * One token per live run, keyed by run id.
   *
   * A single token was correct while a single run could exist. With a pool it
   * is a fail-open hole and a quiet one: run A finishing called `disarm()`,
   * which cleared the only token there was, and run B's next hook call arrived
   * unauthorised — and an unauthorised hook call is a failed hook call, and
   * this hook fails open. Run B would have carried on with no supervisor at
   * all, showing nothing wrong anywhere.
   */
  private tokens = new Map<string, { bytes: Buffer; text: string }>();
  private counter = 0;
  private notify: (approval: Approval) => void;
  private resolved: (approval: Approval) => void;
  private file: string;

  /**
   * The bare-function form is the original contract and still means "notify on
   * creation", so every existing caller and test reads unchanged.
   */
  constructor(hooks: ((approval: Approval) => void) | ApprovalHooks = {}, file = PENDING_FILE) {
    const resolved = typeof hooks === 'function' ? {} : hooks;
    this.notify = (typeof hooks === 'function' ? hooks : hooks.notify) ?? (() => {});
    this.resolved = resolved.resolved ?? (() => {});
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
    this.tokens.set(runId, { bytes: Buffer.from(token), text: token });
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
  liveToken(runId?: string | null): string | null {
    if (runId) return this.tokens.get(runId)?.text ?? null;
    // No id: the one armed run, if there is exactly one. Ambiguity answers
    // null rather than guessing — handing run B's token to run A's settings
    // file would authorise its hook calls under the wrong run.
    return this.tokens.size === 1 ? [...this.tokens.values()][0].text : null;
  }

  /**
   * Retire one run's token, and answer the cards it left up.
   *
   * Scoped to a run: disarming A must leave B verifying. Called with no id it
   * still means everything, which is what a console shutdown wants.
   */
  disarm(runId?: string | null): void {
    if (runId) this.tokens.delete(runId);
    else this.tokens.clear();
    // Anything still waiting is answered rather than left hanging: a session
    // blocked on a dead broker would sit there until the hook timed out. Only
    // this run's cards, though — another run's are still answerable, and
    // settling them would deny a live session's work on its neighbour's behalf.
    for (const [id, entry] of [...this.waiting]) {
      if (runId && entry.approval.runId !== runId) continue;
      this.settle(id, 'deny', 'run ended', 'the run ended before this was decided');
    }
  }

  /** Constant-time, so a wrong token leaks nothing about the right one. */
  verify(header: string | undefined): boolean {
    return this.runIdFor(header) !== null;
  }

  /**
   * WHICH run a hook call belongs to, rather than merely whether it is genuine.
   *
   * The whole point under a pool: two live runs, one hook endpoint, and a call
   * classified under the wrong run's profile is a bug that appears only when
   * two things run at once and is close to unreadable when it does.
   *
   * Every token is compared even after a match, and each comparison is
   * constant-time. Returning early on the first hit would make the reply time
   * a measure of *which* run matched — a weaker leak than the token itself,
   * but a free one to avoid.
   */
  runIdFor(header: string | undefined): string | null {
    if (!header || !this.tokens.size) return null;
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    let found: string | null = null;
    for (const [runId, token] of this.tokens) {
      if (presented.length !== token.bytes.length) continue;
      if (timingSafeEqual(presented, token.bytes)) found ??= runId;
    }
    return found;
  }

  armed(): boolean { return this.tokens.size > 0; }

  /** Which runs currently have a token. Used by the restart/shutdown inventory. */
  armedRuns(): string[] { return [...this.tokens.keys()]; }

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
        // Inside the settle closure on purpose: this is the ONE place every
        // ending passes through — a click, a tap on another device, the
        // timeout, and `disarm()` when a run ends with cards still up. Hanging
        // it off `settle(id, …)` instead would silently miss the last two,
        // which are precisely the endings nobody is watching for.
        try { this.resolved(approval); } catch { /* a listener must never block a decision */ }
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
  /** New-branch runs that will open a PR: bare `git push` moves deny → ask. */
  openPrCarveOut?: boolean;
};

export function buildSettings(opts: SettingsOptions): Record<string, unknown> {
  const policy = carvedPolicy(
    opts.policy ?? loadPolicy(), opts.profile ?? 'guarded', opts.openPrCarveOut ?? false,
  );
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
      // The closeout contract, enforced at the one moment it can still be
      // acted on: a session about to end its turn with neither a handoff on
      // the board nor a declared outcome is told exactly what to do instead
      // of exiting into a halt. Same fail-open philosophy as the hook above —
      // the console being unreachable means the CLI proceeds, and the
      // runner's own exit-time check remains the load-bearing layer. Never a
      // safety mechanism: `deny` above is that, and profiles still never
      // move it.
      Stop: [
        {
          hooks: [
            {
              type: 'http',
              url: `${opts.origin}/hooks/stop`,
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
  const dir = join(INSTANCE_STATE_DIR, 'settings');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-${runId}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is only applied on create; an existing file keeps its
  // own, so set it explicitly rather than trusting the happy path.
  chmodSync(path, 0o600);
  return path;
}
