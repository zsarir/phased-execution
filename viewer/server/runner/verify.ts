/**
 * Independent verification: the runner's answer to "did that phase actually
 * work?" that does not consult the session which claims it did.
 *
 * A plan's `**Verification:**` bullet is supposed to hold "the runnable
 * command/test that proves each exit criterion". In practice it is prose with
 * commands embedded in it, and the prose matters:
 *
 *   - **Verification:** `docker compose run … pytest tests/unit -q` (new tests)
 *     + full safe set `… -m "not slow and not soak" -q` + `task audit:schema`.
 *   - **Verification:** targeted pytest + safe set; `task contracts` byte-stable.
 *
 * The second span there is a continuation fragment — running it executes `…`.
 * The second bullet names two suites in English and no command at all. A
 * verifier that quietly ran what it could parse and reported success would be
 * worse than none: it would launder "I understood one of three things" into
 * "verified", which is the exact failure the runner exists to prevent.
 *
 * So: extract conservatively, run only what is recognisably a command and
 * demonstrably read-only, and **report every fragment left behind**. The runner
 * decides what an incomplete verification means — under the default autonomy it
 * parks for a human rather than advancing.
 *
 * ## Reading a command well enough to judge it
 *
 * The opposite failure is just as bad, and it is the one that actually bit. A
 * plan wrote this, which is two ordinary read-only commands:
 *
 *   cd …/viewer && PHASE_CONSOLE_TEST_ROOT=~/repo node --test "test/*.test.ts"
 *   cd … && git ls-files \
 *     | grep -v '^viewer/web/vendor' \
 *     | xargs grep -nliE 'secret|private-host' ; echo "scrub exit: $?"
 *
 * The old reader split the fence on newlines, so the backslash continuations
 * became three separate "commands" — two of them beginning with `|`. Then the
 * classifier looked at the first whitespace token of each and refused all four,
 * `cd` included. A person was asked to hand-confirm four checks that were two
 * commands this could have run in eleven seconds, and confirming them recorded
 * `ran: 0` as verified. Asking a human to do the machine's job is not caution;
 * it spends the one resource that does not scale and teaches them to click yes.
 *
 * So the reader now joins continuations, and the classifier splits a command
 * into the segments a shell would run — respecting quotes — and requires **every
 * segment** to pass. That is strictly safer than judging the first token, which
 * let `node --test x && curl -X POST …` through on the strength of `node`, and
 * `FOO=1 ./deploy.sh` through because the head token was an assignment. It is
 * also what the CLI's own Bash matcher does.
 *
 * Structure this cannot fully parse — an unbalanced quote, a substitution whose
 * inner command is unknowable — is refused rather than guessed at, and becomes a
 * card for a person. That direction is deliberate: an unparsed command must
 * never fall through to "looks fine".
 *
 * ## Reading the markdown well enough to find the command
 *
 * Two more ways a real plan defeated all of the above, both measured on run
 * `dc3d6d25`, where phases 1 and 2 each advanced on a person clicking "verified"
 * with `ran: 0`:
 *
 *   - **Verification:** `cd …/viewer && npm test && npm run test:client &&
 *     npm run typecheck:client && npm run build`. Manual: enable `changed`, …
 *
 * That is ONE command. It is wrapped because the file is wrapped at 100 columns
 * — markdown joins the lines back, and so does every reader of the rendered
 * page. The extractor did not, and refused its own best command as "spans
 * multiple lines". The same bullet then raised a second card for `changed`, a
 * notification category being named in a sentence.
 *
 * So: a span's line breaks are wrapping, not statement separators (a newline
 * separates statements in a *block*, and blocks are fenced — that path is
 * unchanged), and **a backticked name is a citation, not an unmet check**.
 * `test/terminal*.test.ts`, `changed` and `POST /api/prefs` name things the
 * prose is talking about; asking a person to hand-confirm them, beside commands
 * that did run, is exactly the "teaches them to click yes" failure again. Names
 * are dropped only when something runnable was found — a bullet whose entire
 * content is a name still says so, because then nothing was proven.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.ts';
import type { VerifyRun, VerifySkip, VerifySummary } from './state.ts';

/** Kept in step with `GATE_CMD_DENY` in scripts/phase-graph.sh — same intent. */
const MUTATION_DENY = new RegExp(
  '(^|[;&|\\s])(rm|mv|dd|mkfs|shutdown|reboot|kill|pkill|chown|chmod|sudo)(\\s|$)'
  + '|terraform\\s+(apply|destroy)'
  + '|git\\s+(push|reset|clean|checkout|commit|rebase|merge)'
  + '|docker\\s+(rm|rmi|kill|stop|system\\s+prune)'
  + '|task\\s+[a-z:]*(deploy|ship|update|apply|destroy)'
  + '|\\s(delete|put|create|set|modify|terminate|reboot)-'
  + '|>\\s*/|>>\\s*/',
  'i',
);

/**
 * Only these lead a command the runner will execute. An allowlist rather than a
 * pattern because the input is human prose: `docs/plans/x.md` and `main.py` are
 * both plausible-looking "commands" to a regex and neither is one.
 *
 * Case-sensitive on purpose. `NPM test` fails in bash too, and a classifier that
 * forgave the typo would be promising something the shell will not deliver.
 */
const VERBS = new Set([
  'task', 'make', 'just',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
  'python', 'python3', 'pytest', 'uv', 'poetry', 'ruff', 'mypy', 'black', 'tox', 'alembic',
  'go', 'cargo', 'rustc',
  'bash', 'sh', 'zsh', 'shellcheck',
  'docker', 'docker-compose', 'kubectl', 'gh',
  'git', 'terraform',
  'curl', 'dig', 'ssh', 'psql', 'redis-cli', 'jq',
  'grep', 'rg', 'diff', 'test', 'ls', 'cat', 'head', 'tail', 'wc', 'find', 'awk', 'sed',
  'echo', 'printf', 'true', 'false', 'pwd', 'env', 'which',
  // Read-only filters that appear mid-pipeline in real verification blocks.
  // `xargs` is here because the command it runs is judged separately, below.
  'xargs', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'stat', 'nl',
]);

/** `./run.sh`, `scripts/x.sh`, `./scripts/x.py`, `/abs/path/x.ts`. */
const SCRIPT_PATH = /^\.{0,2}\/?[\w.@-]+(\/[\w.@-]+)*\.(sh|bash|zsh|py|js|ts|mjs|cjs)$/;

/**
 * A script path is trusted on its name alone — there is no way to know what
 * `./run.sh` does short of running it. So the name has to carry the signal, the
 * same way `task deploy:x` does in `MUTATION_DENY`: a name that reads as a verb
 * of consequence goes to a person. `FOO=1 ./deploy.sh` used to run here.
 */
const MUTATING_SCRIPT =
  /(^|[_.-])(deploy|ship|publish|release|provision|migrate|destroy|install|bootstrap|reset|seed|sync|apply|update|upgrade|push|prune)([_.-]|\.[a-z]+$)/i;

/** Docker subcommands that only look. */
const DOCKER_READ_ONLY = new Set([
  'ps', 'logs', 'inspect', 'images', 'version', 'info', 'top', 'stats', 'port', 'diff', 'config',
]);

/**
 * Verbs that reach OUTSIDE this working tree, and are therefore only allowed in
 * a shape that is demonstrably read-only.
 *
 * `MUTATION_DENY` above is a denylist, and a denylist is the wrong instrument
 * for these: `curl -X POST https://…`, `ssh box 'systemctl restart api'` and
 * `psql -c 'DELETE FROM orders'` all sail past it, and every one of them is a
 * verification bullet somebody could plausibly write. The runner then executes
 * it, unattended, at 3am, because a markdown file said so.
 *
 * So for this handful the question is inverted: not "does it look dangerous?"
 * but "can I show it is safe?". Anything that cannot be shown safe goes to the
 * person who wrote the plan, with the reason — which is a card in the console,
 * not a dead end.
 *
 * These now run against a single SEGMENT rather than the whole line, which is
 * what closes the hole where a leading local verb hid a trailing remote write.
 */
const REACHES_OUT: Record<string, (segment: string) => string | null> = {
  // Anything that is not a plain GET, or that carries a body, is a write.
  curl: (c) => (/\s-(X|-request)\s+(?!GET\b)/i.test(c) ? 'sends a non-GET request'
    : /\s-(d|F|T)\b|--data|--form|--upload-file/.test(c) ? 'sends a request body'
      : null),
  // The command run on the far end is the thing to judge, and we cannot judge
  // it: it is quoted prose on another machine. Only a bare connection check and
  // an explicitly read-only remote command pass.
  ssh: (c) => {
    const remote = /^ssh\s+(?:-\S+\s+|-\S+\s+\S+\s+)*\S+\s+(.+)$/.exec(c)?.[1]?.trim();
    if (!remote) return null; // `ssh host` alone connects and does nothing
    const bare = remote.replace(/^['"]|['"]$/g, '').trim();
    return /^(cat|ls|head|tail|grep|wc|stat|df|du|uptime|whoami|hostname|date|docker\s+(ps|logs|inspect)|systemctl\s+(status|is-active)|journalctl)\b/.test(bare)
      ? null
      : 'runs a command on another machine that cannot be shown to be read-only';
  },
  psql: (c) => (/-c\s*(['"])\s*(select|show|explain|\\d|\\l)/i.test(c) || !/-c\b|-f\b/.test(c)
    ? null
    : 'runs SQL that is not demonstrably a read'),
  // `run` and `exec` are judged by the command they carry (see `innerCommand`),
  // not by their own name: `docker compose run --rm api pytest -q` is a test
  // suite, and refusing it sends every containerised plan's verification to a
  // human. The hyphenated and spaced spellings are the same thing. Token-walked
  // rather than regexed: `docker compose -f infra/compose.yml config` used to
  // backtrack the optional `compose\s+` group and judge the subcommand as
  // `compose` — refusing a pure read ~5 times on one real plan.
  docker: (c) => {
    let rest = headOf(tokenize(c)).slice(1);
    if (rest[0] === 'compose') rest = rest.slice(1);
    rest = skipFlags(rest);
    const sub = rest[0];
    if (!sub) return null; // bare `docker` prints usage
    if (DOCKER_READ_ONLY.has(sub) || sub === 'run' || sub === 'exec') return null;
    return 'is not one of the read-only docker subcommands';
  },
  // GitHub's CLI: most of it writes, so the question is inverted like kubectl —
  // only demonstrably read-only subcommand pairs pass. `--watch` shapes wait on
  // an external clock (F16 warns at plan time; here they would hold a session
  // for the full CI duration). `gh api` passes only as a plain GET.
  gh: (c) => {
    if (/\s--watch\b/.test(c) || /^gh\s+run\s+watch\b/.test(c)) {
      return 'waits on an external clock the runner cannot bound';
    }
    const m = /^gh\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(c);
    if (!m) return 'is not a gh invocation the runner can judge';
    if (m[1] === 'api') {
      return /\s(-X|--method)\s+(?!GET\b)\S+/i.test(c) || /(^|\s)(-f|-F|--field|--raw-field|--input)\b/.test(c)
        ? 'sends a non-GET GitHub API request'
        : null;
    }
    const pair = `${m[1]} ${m[2] ?? ''}`.trim();
    const READ = /^(run (list|view|download)|pr (list|view|checks|status|diff)|issue (list|view)|release (list|view)|repo view|workflow (list|view)|search (repos|issues|prs|code)|status|auth status)$/;
    return READ.test(pair) ? null : 'is not one of the read-only gh subcommands';
  },
  kubectl: (c) => (/^kubectl\s+(get|describe|logs|top|explain|version|api-resources)\b/.test(c)
    ? null
    : 'is not one of the read-only kubectl subcommands'),
  'redis-cli': (c) => (/\b(get|keys|scan|info|ping|ttl|type|llen|exists|dbsize)\b/i.test(c)
    ? null
    : 'runs a Redis command that is not demonstrably a read'),
};
REACHES_OUT['docker-compose'] = REACHES_OUT.docker;

export type Extraction = {
  commands: string[];
  notRun: { text: string; reason: string }[];
};

/**
 * Pull candidate commands out of a Verification bullet.
 *
 * Fenced blocks are read with their line continuations joined; inline spans are
 * taken whole. Anything that is not recognisably a command, or that would mutate
 * something, comes back in `notRun` with the reason — never dropped.
 */
export function extractCommands(text: string | undefined): Extraction {
  const out: Extraction = { commands: [], notRun: [] };
  if (!text || !text.trim()) return out;

  const candidates: string[] = [];
  let prose = text;

  // Fenced blocks first, and remove them so their content is not re-scanned.
  // `~~~` fences, CRLF files and lang tags carrying attributes are all real and
  // all used to fall through here into the inline-span scanner, which then
  // paired the block's backticks arbitrarily.
  prose = prose.replace(/(?:```|~~~)[^\n]*\r?\n([\s\S]*?)(?:```|~~~)/g, (_all, body: string) => {
    candidates.push(...fencedCommands(String(body)));
    return ' ';
  });

  for (const match of prose.matchAll(/`([^`]+)`/g)) {
    // An inline span is one line however the source file wrapped it. Joining is
    // what the renderer does; not joining refused whole commands for the crime
    // of being longer than a hundred columns.
    candidates.push(match[1].replace(/\s*\r?\n\s*/g, ' ').trim().replace(/^\$\s+/, ''));
  }

  // Prose with no code spans at all still states a requirement — say so rather
  // than reporting a phase with zero commands as cleanly verified.
  if (!candidates.length) {
    out.notRun.push({ text: condense(prose), reason: 'no command in the plan text — verify by hand' });
    return out;
  }

  const refused: { text: string; reason: string; cited: boolean }[] = [];
  for (const candidate of candidates) {
    const reason = refuse(candidate);
    // Dropped from both lists — see `PREAMBLE`. Not run, and not reported.
    if (reason === PREAMBLE) continue;
    if (!reason) out.commands.push(candidate);
    else refused.push({ text: condense(candidate), reason, cited: namesAThing(candidate) });
  }

  // A name in backticks beside commands that ran is the prose talking about
  // something, not a check somebody owes. With nothing runnable in the bullet it
  // is reported like any other fragment — that phase really was not verified.
  for (const item of refused) {
    if (item.cited && out.commands.length) continue;
    out.notRun.push({ text: item.text, reason: item.reason });
  }

  return out;
}

/** `GET /api/state` — a route being named, and never a command. */
const HTTP_CALL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*$/;

/**
 * Source files that need an interpreter, cited by name: `server/terminal.ts`,
 * `test/agent.test.ts`. Written `./x.py` the author means "run this"; written
 * bare with a slash in it they mean "that file". `.sh` is excluded on purpose —
 * `scripts/check.sh` is a command in every plan that has one.
 */
const CITED_SOURCE = /^[\w.@-]+(\/[\w.@-]+)+\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

/**
 * Does this span name a thing rather than state an action?
 *
 * One word is the test that carries it: an instruction has a verb and an object.
 * `changed`, `test/terminal*.test.ts` and `SessionInfo` are things a sentence is
 * about. Anything with a space in it is treated as an attempted command and
 * still goes to a person — including `./deploy.sh`, which is one word but is
 * unmistakably an instruction, and whose whole point is that a human runs it.
 */
function namesAThing(candidate: string): boolean {
  const text = candidate.trim();
  if (HTTP_CALL.test(text)) return true;
  // `1`, `128 112 3 12 124` — an exit-code table's cells, backticked. Pure
  // numbers are the prose naming values; handing them to bash produced real
  // "a person will be asked: 1 …" cards. Before the whitespace test, since
  // the multi-number shape contains spaces.
  if (/^\d[\d\s.,]*$/.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (CITED_SOURCE.test(text)) return true;
  if (SCRIPT_PATH.test(text)) return false;
  return !VERBS.has(text.replace(/^.*\//, ''));
}

/**
 * Read a fenced block into whole commands.
 *
 * A command wrapped across lines is one command. Splitting the fence on `\n`
 * turned `git ls-files \` / `| grep …` into two, the second of which begins with
 * a pipe and is not a command at all — which is how a plan holding two runnable
 * commands produced four "checks only you can make".
 */
function fencedCommands(body: string): string[] {
  const out: string[] = [];
  let buffer = '';

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // A blank line or a comment ends nothing mid-command; it is only skipped
    // when we are not part-way through one.
    if (!buffer && (!line.trim() || line.trim().startsWith('#'))) continue;

    // An ODD number of trailing backslashes is a continuation; an even number is
    // an escaped backslash that happens to end the line.
    const continues = /(^|[^\\])(\\\\)*\\$/.test(line);
    const piece = (continues ? line.slice(0, -1) : line).trim().replace(/^\$\s+/, '');
    buffer = buffer ? `${buffer} ${piece}` : piece;

    // `foo |` and `foo &&` continue onto the next line too, with no backslash.
    if (continues || /(\||\|\||&&)$/.test(buffer)) continue;

    if (buffer) out.push(buffer);
    buffer = '';
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * Not a refusal — a candidate that is neither a check nor a chore.
 *
 * Distinct from `null` (run it) and from a reason string (tell a person about
 * it), because a plan's environment preamble belongs in NEITHER list: running
 * `export PATH=…` in its own subprocess accomplishes nothing, and reporting it
 * as "a check only you can make" is a false alarm about a line that is not a
 * check at all.
 *
 * It stays out of `commands` too, which is what keeps F14 honest: a
 * §Verification holding nothing but a preamble still has nothing runnable in
 * it, and must still warn.
 */
const PREAMBLE = ' preamble';

/** Why this candidate will not be run, or null when it will be. */
function refuse(candidate: string): string | null {
  if (!candidate) return 'empty';
  // A continuation of the command above it: running `…` is nonsense, and
  // guessing what it continues would be worse.
  if (/^(…|\.\.\.)/.test(candidate)) return 'a continuation fragment, not a whole command';
  if (candidate.length > 2_000) return 'implausibly long for a command';
  if (/\n/.test(candidate)) return 'spans multiple lines';
  return refuseCommand(candidate, 0);
}

const MAX_NESTING = 3;

/** Every segment a shell would run must pass, or the whole command is refused. */
function refuseCommand(command: string, depth: number): string | null {
  if (depth > MAX_NESTING) return 'nests commands more deeply than the runner will judge';

  const parts = segments(unwrap(command));
  if (!parts) {
    return 'could not be read with confidence — unbalanced quoting, or a substitution '
      + 'whose inner command the runner cannot judge';
  }
  if (!parts.length) return 'empty';

  // A preamble segment is skipped rather than returned, so that
  // `export PATH=… && npm test` stays the runnable command it obviously is —
  // returning on the first segment would have dropped the suite along with the
  // export. Only a command that is preamble the whole way down is one.
  let preambleOnly = true;
  for (const segment of parts) {
    const reason = refuseSegment(segment, depth);
    if (reason === PREAMBLE) continue;
    if (reason) return reason;
    preambleOnly = false;
  }
  return preambleOnly ? PREAMBLE : null;
}

function refuseSegment(segment: string, depth: number): string | null {
  const tokens = headOf(tokenize(segment));
  if (!tokens.length) return `\`${condense(segment)}\` sets a variable but runs nothing`;

  const raw = tokens[0];
  const verb = raw.replace(/^.*\//, ''); // /usr/bin/node → node

  // `cd` is navigation, not a verb: it is how a plan says "the tests live in
  // that other directory", and refusing it refuses the whole line. Substitution
  // is already rejected above, so the argument here is always a literal path.
  // Deliberately not confined to the working tree — a plan legitimately points
  // at a sibling repo.
  if (verb === 'cd') {
    if (tokens.length > 2) return '`cd` with more than one argument is not a path this can check';
    return null;
  }

  // `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"` is not a check
  // and not a chore for a person: it is the line a plan puts above its commands
  // so they can find their toolchain. `headOf` already walks past a bare
  // `FOO=bar cmd`, but an `export` on its own line kept its verb and fell all
  // the way to "is not a recognised command" — so every phase of a plan that
  // prefixed its §Verification this way reported a check only a human could
  // make, three phases at a time, about a line that runs nothing.
  //
  // `set -euo pipefail` is here for the same reason. `source`/`.` deliberately
  // is not: it executes a file whose contents this cannot see.
  if (verb === 'export' || verb === 'set') {
    // `export FOO=$(…)` never reaches here — substitution is refused upstream —
    // so an argument list that is all assignments (or all `set` flags) really
    // does change nothing but the environment. Anything else is a shape this
    // did not understand, and unrecognised is the safe answer.
    const rest = tokens.slice(1);
    const inert = verb === 'set'
      ? rest.every((t) => /^[-+][A-Za-z]+$/.test(t) || /^[-+]o$/.test(t) || /^[a-z]+$/.test(t))
      // Bare names beside the assignments are inert too: `export A=1 npm` marks
      // `npm` for export as a VARIABLE NAME and runs nothing — bash semantics,
      // not a command with a prefix.
      : rest.length > 0 && rest.every((t) => /^[A-Za-z_][A-Za-z0-9_]*(=|$)/.test(t));
    if (inert) return PREAMBLE;
  }

  // `test/agent.test.ts` alone is a file the prose is naming. Handing it to bash
  // gets exit 126 and a phase halted for a plan that was only being descriptive;
  // `./x.ts` and `node test/x.ts` are unaffected, being an instruction and a
  // command respectively.
  if (tokens.length === 1 && CITED_SOURCE.test(raw)) {
    return `\`${verb.slice(0, 32)}\` names a file rather than a command`;
  }

  const isScript = SCRIPT_PATH.test(raw);
  const known = VERBS.has(raw) || VERBS.has(verb) || isScript;
  if (!known) return `\`${verb.slice(0, 32)}\` is not a recognised command`;
  if (isScript && MUTATING_SCRIPT.test(verb)) {
    return `\`${verb.slice(0, 32)}\` is named for something that changes state — a human should run this`;
  }

  if (MUTATION_DENY.test(segment)) {
    return `\`${condense(segment)}\` looks like it mutates something — a human should run this`;
  }

  const gate = REACHES_OUT[verb] ?? REACHES_OUT[raw];
  if (gate) {
    const objection = gate(segment.trim());
    if (objection) return `\`${condense(segment)}\` ${objection} — a person should run this, not an unattended runner`;
  }

  // `xargs grep …`, `docker compose run … pytest`, `bash -c '…'` all run a
  // command of their own. Judging the wrapper and not the payload is how a
  // denylist gets walked straight past.
  const inner = innerCommand(verb, tokens);
  if (inner === UNREADABLE) {
    return `\`${condense(segment)}\` runs another command the runner could not read`;
  }
  if (inner) return refuseCommand(inner, depth + 1);

  return null;
}

/* ------------------------------------------------------------------ *
 * Reading shell syntax, without a dependency
 * ------------------------------------------------------------------ */

/**
 * Split on the control operators, respecting quotes.
 *
 * Returns null when the result would be a guess: an unbalanced quote, or any
 * substitution — `$(…)`, a backtick, `<(…)` — whose inner command cannot be
 * known without running it. Refusing sends it to a person, which is the safe
 * direction; the alternative is executing structure this did not understand.
 */
function segments(command: string): string[] | null {
  const out: string[] = [];
  let buffer = '';
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      // Inside single quotes a backslash is literal; inside double quotes it escapes.
      if (quote === '"' && ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
      if (ch === quote) quote = null;
      buffer += ch;
      continue;
    }

    if (ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === '`') return null;
    if (ch === '$' && next === '(') return null;
    if ((ch === '<' || ch === '>') && next === '(') return null;
    // A subshell anywhere but wrapping the whole command (already unwrapped) is
    // structure this will not take apart.
    if (ch === '(' || ch === ')') return null;

    if (ch === '&' && next === '&') { out.push(buffer); buffer = ''; i++; continue; }
    if (ch === '|' && next === '|') { out.push(buffer); buffer = ''; i++; continue; }
    if (ch === '|' || ch === ';' || ch === '&') { out.push(buffer); buffer = ''; continue; }

    buffer += ch;
  }

  if (quote) return null;
  out.push(buffer);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `(cd api && pytest -q)` is one command wearing parentheses. */
function unwrap(command: string): string {
  let text = command.trim();
  for (;;) {
    if (!(text.startsWith('(') && text.endsWith(')'))) return text;
    // Only when the opening paren is the one the final paren closes.
    let depth = 0;
    let wraps = true;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i !== text.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) return text;
    text = text.slice(1, -1).trim();
  }
}

/** Split a segment into words, respecting quotes and dropping the quote marks. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && i + 1 < segment.length) { current += segment[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) { current += segment[++i]; started = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) out.push(current);
  return out;
}

const BARE_WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin']);
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/**
 * Drop what a shell allows in front of the actual command, and return the
 * tokens from the verb onward.
 *
 * The env-assignment case is the one that mattered: the old classifier saw
 * `FOO=1 ./deploy.sh`, matched the assignment, declared the command "known", and
 * then looked up its gate under the name `FOO=1` — so nothing gated it and it
 * ran.
 */
function headOf(tokens: string[]): string[] {
  let rest = tokens;
  for (;;) {
    const head = rest[0];
    if (head === undefined) return [];

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { rest = rest.slice(1); continue; }
    if (BARE_WRAPPERS.has(head)) { rest = rest.slice(1); continue; }
    if (head === 'env') {
      rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
      continue;
    }
    if (head === 'nice') {
      rest = rest.slice(1);
      if (rest[0] === '-n') rest = rest.slice(2);
      else if (/^-\d+$/.test(rest[0] ?? '')) rest = rest.slice(1);
      continue;
    }
    if (head === 'timeout') {
      rest = rest.slice(1);
      while (rest.length && (rest[0].startsWith('-') || DURATION.test(rest[0]))) rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

/** A wrapper whose payload could not be located — refuse rather than assume. */
const UNREADABLE = Symbol('unreadable inner command');

/** Flags that swallow the following token, for the wrappers below. */
const VALUE_FLAGS = new Set([
  '-I', '-n', '-P', '-d', '-a', '-s', '-L', '-E', // xargs
  '-e', '--env', '-v', '--volume', '-w', '--workdir', '-u', '--user', '-p', '--publish',
  '--name', '--entrypoint', '-l', '--label', '--network', '--platform', '--env-file',
  // compose-level flags that sit before the subcommand.
  '-f', '--file', '--project-directory', '--project-name', '--profile',
]);

/**
 * The command a wrapper will itself run, or null when there is none.
 *
 * `xargs` with no command defaults to `echo`, which is why an empty tail is null
 * rather than unreadable.
 */
function innerCommand(verb: string, tokens: string[]): string | typeof UNREADABLE | null {
  if (verb === 'xargs') {
    const tail = skipFlags(tokens.slice(1));
    return tail.length ? quoteJoin(tail) : null;
  }

  if (verb === 'bash' || verb === 'sh' || verb === 'zsh') {
    const at = tokens.indexOf('-c');
    if (at === -1) return null;
    const script = tokens[at + 1];
    return script ? script : UNREADABLE;
  }

  if (verb === 'docker' || verb === 'docker-compose') {
    let rest = tokens.slice(1);
    if (rest[0] === 'compose') rest = rest.slice(1);
    // Compose-level flags (`-f infra/compose.yml`, `-p name`) sit BEFORE the
    // subcommand — the same walk the gate does, or `run`'s payload goes unjudged.
    rest = skipFlags(rest);
    const sub = rest[0];
    if (sub !== 'run' && sub !== 'exec') return null;
    const tail = skipFlags(rest.slice(1));
    // The first survivor is the service/container; the rest is its command.
    const inner = tail.slice(1);
    return inner.length ? quoteJoin(inner) : UNREADABLE;
  }

  return null;
}

function skipFlags(tokens: string[]): string[] {
  let rest = tokens;
  while (rest.length && rest[0].startsWith('-')) {
    const flag = rest[0];
    rest = rest.slice(1);
    // `--flag=value` carries its own value; a bare flag we know takes the next.
    if (!flag.includes('=') && VALUE_FLAGS.has(flag)) rest = rest.slice(1);
  }
  return rest;
}

/** Re-quote tokens that need it, so the rebuilt inner command re-parses. */
function quoteJoin(tokens: string[]): string {
  return tokens
    .map((t) => (/[\s'"|;&()$`\\]/.test(t) ? `'${t.replace(/'/g, `'\\''`)}'` : t))
    .join(' ');
}

function condense(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

export type VerifyOptions = {
  cwd: string;
  /** Per-command ceiling. A full suite is slow; a wedged one must still end. */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStart?: (command: string, index: number, total: number) => void;
  /** Leads never worth a resolution check (builtins, keywords). */
  preflightSkip?: ReadonlySet<string>;
  /** Test seam: overrides the on-disk executability probe. Production never sets it. */
  canExecute?: (lead: string) => boolean;
};

/** Fallback when the caller passes no skip set (mirrors scripts/verify.env;
 * the drift test pins it against the file). */
export const DEFAULT_PREFLIGHT_SKIP: ReadonlySet<string> = new Set([
  'cd', 'true', 'false', 'echo', 'printf', 'test', 'pwd', 'env', 'which',
  'bash', 'sh', 'command', 'export', 'set', 'time',
  'if', 'then', 'fi', 'elif', 'else', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
]);

/** The program a command starts with, past `FOO=1` prefixes — or null for
 * paths (judged elsewhere) and empty candidates. One extractor, three
 * consumers: the boarding preflight, the verify-time skip below, and (via
 * the same rules re-implemented in bash) lint F17. */
export function resolveLead(command: string): string | null {
  let rest = command.trim();
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (!assignment) break;
    rest = rest.slice(assignment[0].length);
  }
  const token = rest.split(/\s+/)[0] ?? '';
  if (!token || token.includes('/')) return null;
  return token;
}

/**
 * Which leads resolve to no executable on the (hardened) verification PATH —
 * `lead → reason`. The predicate the boarding preflight and verify-time skip
 * share, so "predicted missing" and "skipped" can never disagree.
 */
export function unresolvableLeads(
  commands: readonly string[],
  envPath: string | undefined,
  skip: ReadonlySet<string> = DEFAULT_PREFLIGHT_SKIP,
  canExecute?: (lead: string) => boolean,
): Map<string, string> {
  const missing = new Map<string, string>();
  const dirs = hardenedPath(envPath).path.split(':').filter(Boolean);
  const executable = canExecute ?? ((lead: string) => dirs.some((dir) => {
    try { accessSync(join(dir, lead), fsConstants.X_OK); return true; } catch { return false; }
  }));
  const seen = new Set<string>();
  for (const command of commands) {
    const lead = resolveLead(command);
    if (!lead || seen.has(lead) || skip.has(lead)) continue;
    seen.add(lead);
    if (!executable(lead)) missing.set(lead, `\`${lead}\` is not installed on the verification PATH here`);
  }
  return missing;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Enough tail to see which assertion failed, not a whole suite log. */
const KEEP_OUTPUT = 8_000;

export async function verifyPhase(
  verificationText: string | undefined, opts: VerifyOptions,
): Promise<VerifySummary> {
  const { commands, notRun } = extractCommands(verificationText);

  if (!verificationText || !verificationText.trim()) {
    return { ok: false, reason: 'the plan states no verification for this phase', ran: [], notRun: [] };
  }
  if (!commands.length) {
    return {
      ok: false,
      reason: `nothing runnable in this phase's verification (${notRun.length} fragment${notRun.length === 1 ? '' : 's'} left for a human)`,
      ran: [],
      notRun,
    };
  }

  // A lead the PATH cannot resolve would exit 127 — a fact about this MACHINE,
  // not about the work. 15 of 16 observed verify-failed halts were this shape
  // (`rg` a shell function elsewhere, `python` meaning python3), every one
  // predicted at boarding and run anyway. Skipped-with-reason, never failed;
  // PHASE_CONSOLE_VERIFY_NO_SKIP=1 restores the old behaviour for one release.
  const skipped: VerifySkip[] = [];
  let runnable: string[] = commands;
  if (process.env.PHASE_CONSOLE_VERIFY_NO_SKIP !== '1') {
    const missing = unresolvableLeads(
      commands, (opts.env ?? process.env).PATH,
      opts.preflightSkip ?? DEFAULT_PREFLIGHT_SKIP, opts.canExecute);
    if (missing.size) {
      runnable = [];
      for (const command of commands) {
        const lead = resolveLead(command);
        if (lead && missing.has(lead)) {
          skipped.push({
            command: condense(command),
            lead,
            reason: `\`${lead}\` is not installed on the verification PATH — confirm this check by hand, or fix the PATH`,
          });
        } else runnable.push(command);
      }
    }
  }

  if (!runnable.length && skipped.length) {
    // Everything the plan wrote is unrunnable HERE. Not a verdict — an
    // unanswered question: the skips ride `notRun` so the runner's existing
    // person-park (askHuman) owns it, never a verify-failed halt.
    const leads = [...new Set(skipped.map((s) => s.lead))].join(', ');
    return {
      ok: false,
      reason: `all ${commands.length} command(s) are unrunnable here — leads not on the verification PATH: ${leads}`,
      ran: [],
      notRun: [...notRun, ...skipped.map((s) => ({ text: s.command, reason: s.reason }))],
      skipped,
    };
  }

  const ran: VerifyRun[] = [];
  for (const [index, command] of runnable.entries()) {
    if (opts.signal?.aborted) {
      notRun.push({ text: condense(command), reason: 'the run was stopped before this command' });
      continue;
    }
    opts.onStart?.(command, index, runnable.length);
    const result = await runOne(command, opts);
    ran.push(result);
    // Stop at the first red: later commands usually depend on earlier ones, and
    // a wall of cascading failures buries the one that actually matters.
    if (!result.ok) {
      for (const rest of runnable.slice(index + 1)) {
        notRun.push({ text: condense(rest), reason: 'skipped after an earlier command failed' });
      }
      break;
    }
  }

  const failed = ran.find((r) => !r.ok);
  const skipNote = skipped.length
    ? `; ${skipped.length} skipped — unrunnable here (${[...new Set(skipped.map((s) => s.lead))].join(', ')})`
    : '';
  return {
    ok: !failed,
    reason: failed
      ? `\`${condense(failed.command)}\` exited ${failed.code}`
      : `${ran.length} command${ran.length === 1 ? '' : 's'} green${skipNote}`,
    ran,
    notRun,
    ...(skipped.length ? { skipped } : {}),
  };
}

/**
 * Directories a verification's PATH must be able to see.
 *
 * Under launchd the plist bakes the PATH of whatever shell ran the installer,
 * and a thin one turns a green suite into `"python": executable file not found`
 * at 3 a.m. — a halt that blames the code when only the environment failed
 * (that exact halt stopped a real run). APPENDED, never prepended: the existing
 * PATH keeps deciding which toolchain wins, and only otherwise-invisible
 * binaries are rescued. The amendment is logged once per process so the plist
 * defect stays visible instead of papered over — the durable fix is re-running
 * `deploy/agent.sh install` from a shell with a full PATH.
 */
const STANDARD_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
let pathAmendWarned = false;

export function hardenedPath(path: string | undefined): { path: string; added: string[] } {
  const current = (path ?? '').split(':').filter(Boolean);
  const have = new Set(current);
  const added = STANDARD_DIRS.filter((dir) => !have.has(dir) && existsSync(dir));
  return { path: [...current, ...added].join(':'), added };
}

function runOne(command: string, opts: VerifyOptions): Promise<VerifyRun> {
  const started = Date.now();
  const base = { ...(opts.env ?? process.env) };
  const hardened = hardenedPath(base.PATH);
  if (hardened.added.length && !pathAmendWarned) {
    pathAmendWarned = true;
    log.warn('verify.path-amended', { added: hardened.added });
  }
  return new Promise((resolve) => {
    execFile(
      'bash', ['-c', command],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        signal: opts.signal,
        env: { ...base, PATH: hardened.path, NO_COLOR: '1', TERM: 'dumb', CI: '1' },
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
        const killed = Boolean(failure?.killed) || opts.signal?.aborted;
        const code = failure && typeof failure.code === 'number' ? failure.code : failure ? 1 : 0;
        const output = `${stdout}${stderr}`.trim();
        resolve({
          command,
          // A killed command proves nothing — report it red, but say why.
          ok: !killed && code === 0,
          code: killed ? 124 : code,
          ms: Date.now() - started,
          output: (killed ? `[timed out or cancelled]\n${output}` : output).slice(-KEEP_OUTPUT),
        });
      },
    );
  });
}
