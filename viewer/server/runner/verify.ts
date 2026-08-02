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
 */

import { execFile } from 'node:child_process';

import type { VerifyRun, VerifySummary } from './state.ts';

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
 */
const VERBS = new Set([
  'task', 'make', 'just',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
  'python', 'python3', 'pytest', 'uv', 'poetry', 'ruff', 'mypy', 'black', 'tox', 'alembic',
  'go', 'cargo', 'rustc',
  'bash', 'sh', 'zsh', 'shellcheck',
  'docker', 'docker-compose', 'kubectl',
  'git', 'terraform',
  'curl', 'dig', 'ssh', 'psql', 'redis-cli', 'jq',
  'grep', 'rg', 'diff', 'test', 'ls', 'cat', 'head', 'tail', 'wc', 'find', 'awk', 'sed',
  'echo', 'printf', 'true', 'false', 'pwd', 'env', 'which',
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
 */
const REACHES_OUT: Record<string, (command: string) => string | null> = {
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
  docker: (c) => (/^docker(-compose)?\s+(ps|logs|inspect|images|version|info|top|stats|port|diff)\b/.test(c)
    ? null
    : 'is not one of the read-only docker subcommands'),
  kubectl: (c) => (/^kubectl\s+(get|describe|logs|top|explain|version|api-resources)\b/.test(c)
    ? null
    : 'is not one of the read-only kubectl subcommands'),
  'redis-cli': (c) => (/\b(get|keys|scan|info|ping|ttl|type|llen|exists|dbsize)\b/i.test(c)
    ? null
    : 'runs a Redis command that is not demonstrably a read'),
};

export type Extraction = {
  commands: string[];
  notRun: { text: string; reason: string }[];
};

/**
 * Pull candidate commands out of a Verification bullet.
 *
 * Fenced blocks are taken line by line; inline spans are taken whole. Anything
 * that is not recognisably a command, or that would mutate something, comes
 * back in `notRun` with the reason — never dropped.
 */
export function extractCommands(text: string | undefined): Extraction {
  const out: Extraction = { commands: [], notRun: [] };
  if (!text || !text.trim()) return out;

  const candidates: string[] = [];
  let prose = text;

  // Fenced blocks first, and remove them so their content is not re-scanned.
  prose = prose.replace(/```[a-z]*\n([\s\S]*?)```/gi, (_all, body: string) => {
    for (const line of String(body).split('\n')) {
      const trimmed = line.trim().replace(/^\$\s+/, '');
      if (trimmed && !trimmed.startsWith('#')) candidates.push(trimmed);
    }
    return ' ';
  });

  for (const match of prose.matchAll(/`([^`]+)`/g)) {
    candidates.push(match[1].trim().replace(/^\$\s+/, ''));
  }

  // Prose with no code spans at all still states a requirement — say so rather
  // than reporting a phase with zero commands as cleanly verified.
  if (!candidates.length) {
    out.notRun.push({ text: condense(prose), reason: 'no command in the plan text — verify by hand' });
    return out;
  }

  for (const candidate of candidates) {
    const reason = refuse(candidate);
    if (reason) out.notRun.push({ text: condense(candidate), reason });
    else out.commands.push(candidate);
  }

  return out;
}

/** Why this candidate will not be run, or null when it will be. */
function refuse(candidate: string): string | null {
  if (!candidate) return 'empty';
  // A continuation of the command above it: running `…` is nonsense, and
  // guessing what it continues would be worse.
  if (/^(…|\.\.\.)/.test(candidate)) return 'a continuation fragment, not a whole command';
  if (candidate.length > 2_000) return 'implausibly long for a command';
  if (/\n/.test(candidate)) return 'spans multiple lines';

  const first = candidate.split(/\s+/)[0];
  const verb = first.replace(/^.*\//, ''); // ./scripts/x.sh → x.sh
  const known = VERBS.has(first) || VERBS.has(verb)
    || /^\.?\/?[\w.-]+\/[\w./-]*\.(sh|bash|py|js|ts)$/.test(first)
    || /^[A-Z_]+=/.test(first); // FOO=bar cmd …
  if (!known) return `not a recognised command (starts with "${first.slice(0, 32)}")`;

  if (MUTATION_DENY.test(candidate)) return 'looks like it mutates something — a human should run this';

  // For the verbs that reach outside this working tree, the denylist above is
  // the wrong test: `curl -X POST` and `psql -c 'DELETE …'` both pass it. These
  // must be shown safe instead.
  const gate = REACHES_OUT[verb] ?? REACHES_OUT[first];
  if (gate) {
    const objection = gate(candidate.trim());
    if (objection) return `${objection} — a person should run this, not an unattended runner`;
  }
  return null;
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
};

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

  const ran: VerifyRun[] = [];
  for (const [index, command] of commands.entries()) {
    if (opts.signal?.aborted) {
      notRun.push({ text: condense(command), reason: 'the run was stopped before this command' });
      continue;
    }
    opts.onStart?.(command, index, commands.length);
    const result = await runOne(command, opts);
    ran.push(result);
    // Stop at the first red: later commands usually depend on earlier ones, and
    // a wall of cascading failures buries the one that actually matters.
    if (!result.ok) {
      for (const rest of commands.slice(index + 1)) {
        notRun.push({ text: condense(rest), reason: 'skipped after an earlier command failed' });
      }
      break;
    }
  }

  const failed = ran.find((r) => !r.ok);
  return {
    ok: !failed,
    reason: failed
      ? `\`${condense(failed.command)}\` exited ${failed.code}`
      : `${ran.length} command${ran.length === 1 ? '' : 's'} green`,
    ran,
    notRun,
  };
}

function runOne(command: string, opts: VerifyOptions): Promise<VerifyRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      'bash', ['-c', command],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        signal: opts.signal,
        env: { ...(opts.env ?? process.env), NO_COLOR: '1', TERM: 'dumb', CI: '1' },
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
