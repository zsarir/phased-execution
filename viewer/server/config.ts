/**
 * Runtime configuration: CLI flags, the persisted preferences file, and root
 * validation.
 *
 * Preferences live in `~/.config/phase-console/config.json` — never inside the
 * skill repo, which stays free of machine-local state.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitiseCategories, type CategoryId } from './push/catalogue.ts';

export const VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = dirname(VIEWER_DIR);

/**
 * Lanes allowed live at once, before anyone says otherwise. See `Flags.maxSessions`.
 *
 * Lives here rather than in `scheduler.ts` only because of the import graph —
 * `log.ts` reads this module, so a config that reached back into the scheduler
 * would close a cycle. The scheduler imports it from here instead.
 */
export const DEFAULT_MAX_SESSIONS = 3;

export type Flags = {
  root?: string;
  port: number;
  host: string;
  open: boolean;
  allowWrites: boolean;
  /**
   * Separate from `allowWrites` on purpose. A write scaffolds a file; a run
   * spawns agent sessions that edit a repo for hours. Same server, very
   * different blast radius, so they are two decisions.
   */
  allowRun: boolean;
  /**
   * A third decision again, not a wider reading of the other two. `--allow-run`
   * spawns a supervised agent inside a policy this console enforces;
   * `--allow-terminal` hands over an unsupervised shell, where the policy is
   * whatever the person typing knows. Same machine, different promise.
   */
  allowTerminal: boolean;
  /**
   * A fourth decision. An agent session is an interactive `claude` in the
   * browser terminal: supervised by the person watching it, not by this
   * console's policy. It is less than `--allow-terminal` (the argv is built
   * server-side from allowlisted fields, and the CLI asks before it acts) but
   * more than `--allow-run` (no deny-list settings file, no approval hook in
   * front of it) — so it is its own flag, not a reading of either.
   */
  allowAgent: boolean;
  /**
   * Hostnames this console answers to besides localhost, reached through an
   * authenticating proxy that puts the caller's identity in a header.
   *
   * Empty — the default — means the console is local-only and every Host is
   * treated exactly as it was before this existed. Naming even one turns on
   * strict Host validation, so an unknown Host is refused rather than served.
   */
  remoteHosts: string[];
  /** Logins allowed to arrive through `remoteHosts`. See `server/api/access.ts`. */
  remoteUsers: string[];
  scriptsDir: string;
  /**
   * How many phase sessions may be live across the whole console at once.
   *
   * A ceiling on the machine, not on the scheduler's judgement: scope decides
   * whether two phases *may* overlap, and this decides how many the laptop
   * running them can actually stand. Three is a deliberate default — each lane
   * is a full `claude` process with its own context, and the account's usage
   * window is shared between them, so the fourth lane usually buys throttling
   * rather than throughput. `--max-sessions`, or `PHASE_CONSOLE_MAX_SESSIONS`.
   */
  maxSessions: number;
  /**
   * Skills every run of every plan starts with, unless the operator says
   * otherwise when starting it.
   *
   * A MACHINE-level default, which is the level the need actually lives at: a
   * skill that maintains state about the repositories on this machine (a
   * knowledge graph, an index) is wanted by every phase of every plan, and
   * saying so once in the launch environment beats naming it in eighty-six
   * plans. It seeds `RunState.skills` at start and then stops mattering — the
   * run's own list is the single truth from that moment, so unchecking one in
   * the console is a real "off" and not a preference the next tick overrides.
   * `--default-skills a,b`, or `PHASE_CONSOLE_DEFAULT_SKILLS`.
   */
  defaultSkills: string[];
  /** Where the structured log goes. `null` disables file logging entirely. */
  logFile: string | null;
};

/**
 * Machine-local state that is neither preference nor repo content: the log,
 * and (once the runner lands) run journals and checkpoints. XDG puts this under
 * `~/.local/state`, which is exactly the "survives a reboot, means nothing on
 * another machine" category these files belong to.
 */
export const STATE_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'phase-console',
);

export function defaultLogFile(): string {
  return join(STATE_DIR, 'console.log');
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    port: Number(process.env.PHASE_CONSOLE_PORT ?? 4123),
    host: '127.0.0.1',
    // Starting the console should show you the console. Opt out with --no-open
    // (or PHASE_CONSOLE_NO_OPEN=1, which scripts and tests use).
    open: process.env.PHASE_CONSOLE_NO_OPEN !== '1',
    allowWrites: false,
    allowRun: false,
    allowTerminal: false,
    allowAgent: false,
    remoteHosts: [],
    remoteUsers: splitList(process.env.PHASE_CONSOLE_REMOTE_USERS),
    scriptsDir: join(SKILL_DIR, 'scripts'),
    maxSessions: positive(process.env.PHASE_CONSOLE_MAX_SESSIONS) ?? DEFAULT_MAX_SESSIONS,
    defaultSkills: splitList(process.env.PHASE_CONSOLE_DEFAULT_SKILLS),
    logFile: process.env.PHASE_CONSOLE_LOG === '' ? null : (process.env.PHASE_CONSOLE_LOG ?? defaultLogFile()),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--root' || arg === '-r') flags.root = resolve(expandHome(next() ?? ''));
    else if (arg === '--port' || arg === '-p') flags.port = Number(next());
    else if (arg === '--host') flags.host = next() ?? flags.host;
    else if (arg === '--open') flags.open = true;
    else if (arg === '--no-open') flags.open = false;
    else if (arg === '--allow-writes') flags.allowWrites = true;
    else if (arg === '--allow-run') flags.allowRun = true;
    else if (arg === '--allow-terminal') flags.allowTerminal = true;
    else if (arg === '--allow-agent') flags.allowAgent = true;
    else if (arg === '--remote') flags.remoteHosts.push(...splitList(next()));
    else if (arg === '--remote-user') flags.remoteUsers.push(...splitList(next()));
    else if (arg === '--scripts') flags.scriptsDir = resolve(expandHome(next() ?? ''));
    else if (arg === '--max-sessions') flags.maxSessions = positive(next()) ?? flags.maxSessions;
    // Repeatable and additive to the environment, like --remote: an operator
    // adding one for a session should not have to restate what the plist bakes in.
    else if (arg === '--default-skills') flags.defaultSkills.push(...splitList(next()));
    else if (arg === '--log-file') flags.logFile = resolve(expandHome(next() ?? ''));
    else if (arg === '--no-log-file') flags.logFile = null;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  // Hostnames and logins are compared, never displayed, so they are folded once
  // here rather than at every comparison site.
  flags.remoteHosts = unique(flags.remoteHosts.map((h) => h.toLowerCase().replace(/\.$/, '')));
  flags.remoteUsers = unique(flags.remoteUsers.map((u) => u.toLowerCase()));
  // A skill id is what `/name` or `/plugin:name` accepts and nothing else: these
  // go straight into a child's boot prompt, so anything shaped wrong is dropped
  // here rather than named at a session that cannot invoke it.
  flags.defaultSkills = unique(flags.defaultSkills.filter((id) => SKILL_ID.test(id))).slice(0, 40);
  return flags;
}

/**
 * Whether agent sessions are enabled.
 *
 * Every consumer (the Terminals registry, `/api/state`, the route guard) asks
 * this function rather than reading the flag, so folding the capability into
 * `--allow-terminal` — if an operator ever prefers three flags to four — is
 * this one return expression: `flags.allowAgent || flags.allowTerminal`.
 */
export function agentEnabled(flags: Flags): boolean {
  return flags.allowAgent;
}

/**
 * A whole number of lanes, or nothing.
 *
 * `--max-sessions 0` and `--max-sessions banana` both mean the caller wanted
 * something this cannot give them, and the safe reading of both is "you did not
 * say" rather than "run nothing at all" — a console that silently admits no
 * phases looks exactly like a console whose scheduler is broken.
 */
function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A skill id: what `/name` or `/plugin:name` accepts, and nothing else.
 *
 * The same expression `api/routes.ts` checks a browser's list against — kept
 * separately rather than imported because routes reads config and not the other
 * way round, and one shared constant here would close an import cycle for a
 * regular literal.
 */
const SKILL_ID = /^[a-z0-9][\w.-]{0,63}(:[a-z0-9][\w.-]{0,63})?$/i;

/** `a,b, c` and `a` both mean the same thing, and neither may contain blanks. */
function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Refuse to start rather than start wrong.
 *
 * `--remote` widens who can reach a console that may be able to spawn agent
 * sessions. Doing that with no allowlist is never what anyone meant, and the
 * failure would be silent — the console would come up looking correct and let
 * the whole tailnet in. So it is a startup error, not a warning.
 *
 * Returns the message to print, or `null` when the flags are coherent.
 */
export function flagsRefusal(flags: Flags): string | null {
  if (flags.remoteHosts.length && !flags.remoteUsers.length) {
    return '--remote needs at least one --remote-user (or PHASE_CONSOLE_REMOTE_USERS).\n'
      + '  Without one, every request arriving at that hostname would be accepted.';
  }
  if (!flags.remoteHosts.length && flags.remoteUsers.length) {
    return '--remote-user does nothing without --remote <hostname>.';
  }
  const bad = flags.remoteHosts.find((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h));
  if (bad) return `--remote ${bad} is not a hostname. Give the name the proxy serves, with no scheme or port.`;
  return null;
}

function printHelp(): void {
  process.stdout.write(`Phase Console — local viewer for phased-execution plans

  node server/index.ts [options]

  --root <dir>      open this source directory immediately (skips the picker)
  --port <n>        port to listen on (default 4123)
  --host <addr>     interface to bind (default 127.0.0.1 — localhost only)
  --no-open         do not open the browser (it opens by default)
  --allow-writes    enable the guarded write verbs (scaffold, QA record, locks)
  --allow-run       enable the autopilot: spawn \`claude -p\` sessions per phase
  --allow-terminal  enable the Terminal page: a real shell over a WebSocket,
                    running as you, with no policy in front of it
  --allow-agent     enable the Agent page: interactive \`claude\` sessions in the
                    browser terminal, and the "New plan with AI" wizard
  --remote <host>   also answer to this hostname, fronted by an authenticating
                    proxy (e.g. \`tailscale serve\`). Repeatable. Turns on strict
                    Host checking, so any other Host is refused.
  --remote-user <l> a login allowed to arrive via --remote. Repeatable; also
                    PHASE_CONSOLE_REMOTE_USERS. Required by --remote.
  --default-skills <csv>
                    skills every new run starts with, on top of anything the
                    plan names. Repeatable; also PHASE_CONSOLE_DEFAULT_SKILLS.
                    Seeds the run at start — unchecking one in the console is
                    then a real "off" for that run.
  --scripts <dir>   phased-execution scripts dir (default: the skill this lives in)
  --log-file <p>    structured log (default ${defaultLogFile()})
  --no-log-file     log to stderr only
`);
}

/* ------------------------------------------------------------------ *
 * Which client is being served
 * ------------------------------------------------------------------ */

export const DIST_DIR = join(VIEWER_DIR, 'client', 'dist');

/**
 * Which client this console can serve, as a live fact rather than a startup one.
 *
 * The built client (`client/dist/`) is the only client — the legacy `web/`
 * retired with the rewrite. `dist` is gitignored, so every machine builds its
 * own copy (`npm ci && npm run build`; `deploy/agent.sh install|update` does it
 * for you). The check stays per request, so a build cuts a running console over
 * without a restart — which is exactly why it has to be reportable: with the
 * answer moving underneath a long-lived process, "which client am I actually
 * looking at" was otherwise only answerable by reading the startup log, and the
 * startup log records the answer from hours ago.
 */
export function staticRoot(): 'dist' | 'not-built' {
  return existsSync(join(DIST_DIR, 'index.html')) ? 'dist' : 'not-built';
}

/** The directory `staticRoot()` names — `null` until a build exists. */
export function staticRootDir(): string | null {
  return staticRoot() === 'dist' ? DIST_DIR : null;
}

/* ------------------------------------------------------------------ *
 * Is the code on disk newer than the code we are running?
 * ------------------------------------------------------------------ */

const BOOTED_AT = Date.now();
let mtimeCache: { at: number; newest: number } | null = null;

/**
 * Node reads the server once, at startup. Pulling the skill — or editing it —
 * under a running console leaves a process executing code that no longer exists
 * on disk, while the browser happily loads the new client from the same
 * directory. Every symptom of that is misleading: a route that 404s, a fix that
 * "did not work", an error that was corrected twenty minutes ago.
 *
 * So the console checks its own freshness and says so, because the alternative
 * is the operator debugging a version they are not running.
 */
export function serverIsStale(): boolean {
  const now = Date.now();
  if (mtimeCache && now - mtimeCache.at < 5_000) return mtimeCache.newest > BOOTED_AT;

  let newest = 0;
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    for (const name of safeList(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        const info = statSync(full);
        if (info.isDirectory()) walk(full, depth + 1);
        else if (name.endsWith('.ts')) newest = Math.max(newest, info.mtimeMs);
      } catch { /* a file that vanished mid-walk is not a signal */ }
    }
  };
  walk(join(VIEWER_DIR, 'server'));

  mtimeCache = { at: now, newest };
  return newest > BOOTED_AT;
}

export function expandHome(input: string): string {
  return input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
}

/* ------------------------------------------------------------------ *
 * Persisted preferences
 * ------------------------------------------------------------------ */

export type Prefs = {
  recentRoots: string[];
  lastRoot?: string;
  theme?: 'dark' | 'light' | 'system';
  density?: 'comfortable' | 'compact';
  model?: string;
  sort?: string;
  /**
   * Which categories the console is allowed to announce **at all** — the switch
   * an operator actually means when they turn a notification off.
   *
   * This lives here, in the console's own config, rather than on a push device,
   * because the previous home for it was wrong in a way that made the toggles
   * lie: categories were stored per subscribed device, so they filtered the push
   * leg and nothing else. Turning "Plans changed on disk" off still wrote an
   * inbox record, still emitted over SSE, still ran `PHASE_CONSOLE_NOTIFY` — and
   * a console with no device subscribed had nowhere to store the preference at
   * all. One global map, consulted at the top of `Service.announce()`, is what
   * makes a disabled category mean silence on every leg.
   *
   * Never partial: `loadPrefs` sanitises it to a complete map so a category
   * added in a later version takes its catalogue default instead of reading
   * `undefined` (and being suppressed by accident).
   */
  notify: Record<CategoryId, boolean>;
};

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'phase-console');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_PREFS: Prefs = {
  recentRoots: [], theme: 'system', density: 'comfortable', sort: 'activity', notify: sanitiseCategories(undefined),
};

export function loadPrefs(): Prefs {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Prefs>;
    // `notify` is rebuilt rather than spread: a stored map missing a key must
    // take that category's default, not inherit `undefined`.
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      recentRoots: parsed.recentRoots ?? [],
      notify: sanitiseCategories(parsed.notify),
    };
  } catch {
    return { ...DEFAULT_PREFS, notify: sanitiseCategories(undefined) };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  } catch {
    /* preferences are a convenience; a read-only home must not break the app */
  }
}

export function rememberRoot(prefs: Prefs, root: string): Prefs {
  const recentRoots = [root, ...prefs.recentRoots.filter((r) => r !== root)].slice(0, 12);
  const next = { ...prefs, recentRoots, lastRoot: root };
  savePrefs(next);
  return next;
}

/* ------------------------------------------------------------------ *
 * Root validation
 * ------------------------------------------------------------------ */

export type RootCheck = {
  path: string;
  ok: boolean;
  reason?: string;
  docsDir?: string;
  plansDir?: string;
  handoffsDir?: string;
  planCount: number;
  handoffCount: number;
  label: string;
};

/**
 * A source directory is valid when it holds `docs/plans` (the plan store).
 * Pointing straight at a `docs/` directory works too — that is what someone
 * typing a path from muscle memory usually does.
 */
export function checkRoot(input: string): RootCheck {
  const path = resolve(expandHome(input || '.'));
  const empty: RootCheck = { path, ok: false, planCount: 0, handoffCount: 0, label: basename(path) };

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { ...empty, reason: 'No such directory' };
  }

  const docsDir = existsSync(join(path, 'docs', 'plans')) ? join(path, 'docs')
    : existsSync(join(path, 'plans')) ? path
      : undefined;

  if (!docsDir) return { ...empty, reason: 'No docs/plans directory here' };

  const plansDir = join(docsDir, 'plans');
  const handoffsDir = join(docsDir, 'handoffs');
  const planCount = safeList(plansDir).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
  const handoffCount = existsSync(handoffsDir)
    ? safeList(handoffsDir).filter((f) => statSync(join(handoffsDir, f)).isDirectory()).length
    : 0;

  return {
    path, ok: true, docsDir, plansDir,
    handoffsDir: existsSync(handoffsDir) ? handoffsDir : undefined,
    planCount, handoffCount,
    label: basename(path) || path,
  };
}

export function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Directory listing for the source picker — directories only, dotfiles hidden. */
export function listDirs(input: string): { path: string; parent?: string; entries: { name: string; path: string; hasDocs: boolean }[] } {
  const path = resolve(expandHome(input || homedir()));
  const entries = safeList(path)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, full: join(path, name) }))
    .filter(({ full }) => { try { return statSync(full).isDirectory(); } catch { return false; } })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, full }) => ({ name, path: full, hasDocs: existsSync(join(full, 'docs', 'plans')) }));

  const parent = dirname(path);
  return { path, parent: parent === path ? undefined : parent, entries };
}
