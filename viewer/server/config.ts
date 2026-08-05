/**
 * Runtime configuration: CLI flags, the persisted preferences file, and root
 * validation.
 *
 * Preferences live in `~/.config/phase-console/config.json` — never inside the
 * skill repo, which stays free of machine-local state.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT, PORT_RANGE_SIZE, PORT_RANGE_START,
  defaultInstance, getInstance, instanceId, instancePrefsPath, isDefaultRoot,
  listInstances, preferredPort, readProjectFile, registerInstance, reservedPorts,
} from '../shared/instances.mjs';
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

/* ------------------------------------------------------------------ *
 * Which console is this?
 * ------------------------------------------------------------------ */

/**
 * The identity of this process, resolved once — before anything computes a path.
 *
 * It has to be this early, and that is the whole reason this block sits above
 * everything else rather than beside the preferences it feels related to. The
 * log file, the notification inbox, the push keys and the approvals queue are
 * all module-level constants in their own files, computed the moment those
 * modules load. Resolving the instance any later would mean those constants had
 * already been computed from the shared directory, and a second console would
 * be writing into the first one's state while reporting its own id — the exact
 * failure this phase exists to remove, made invisible.
 *
 * So the argv is pre-scanned here rather than waiting for `parseFlags()`. The
 * duplication with `parseFlags` is deliberate and small: two readings of
 * `--root` that could disagree would be a bug, so this one reads the same two
 * spellings and the same environment variable, and `parseFlags` remains the
 * only reading anything else uses.
 */
export type Instance = {
  id: string;
  name: string;
  /** The project this console serves — `null` until someone picks one. */
  root: string | null;
  /**
   * The instance that keeps the legacy footprint: flat `STATE_DIR`, port 4123,
   * the bare unit label. Exactly one machine-wide, and on a machine that has
   * only ever run one console it is that console — which is what makes the
   * upgrade to a multi-instance build a no-op for a single-project user.
   */
  default: boolean;
  /**
   * A non-default console serves one project and refuses to be repointed. The
   * default keeps the picker, because it is also the console someone opens with
   * no root at all to go looking for one.
   */
  pinned: boolean;
};

/** `--root`/`-r`, `--instance`, and the environment — read before flags exist. */
function preScanIdentity(argv: string[], env: NodeJS.ProcessEnv): { root: string | null; selector: string | null } {
  let root: string | null = null;
  let selector: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--root' || arg === '-r') && argv[i + 1]) root = resolve(expandHome(argv[++i]));
    else if (arg === '--instance' && argv[i + 1]) selector = argv[++i];
  }
  if (!root && env.PHASE_CONSOLE_ROOT) root = resolve(expandHome(env.PHASE_CONSOLE_ROOT));
  if (!selector && env.PHASE_CONSOLE_INSTANCE) selector = env.PHASE_CONSOLE_INSTANCE;
  return { root, selector };
}

/**
 * Work out who we are from argv, the environment and the registry.
 *
 * Exported and parameterised so a test can ask the question without spawning a
 * console; `INSTANCE` below is this function applied to the real process.
 *
 * A console started with no root is the default one. That is not a fallback so
 * much as the honest reading: with no project named there is nothing to derive
 * an identity from, and the thing an operator is looking at is the picker — the
 * single-console experience that predates instances entirely.
 */
export function resolveInstance(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Instance {
  const { root: argRoot, selector } = preScanIdentity(argv, env);

  // `--instance <id-or-name>` names a console that has been registered before,
  // and supplies its root. `--root` still wins if both are given: naming a path
  // is more specific than naming a bookmark.
  let root = argRoot;
  let named: ReturnType<typeof getInstance> = null;
  if (selector) {
    const entries = listInstances(env);
    named = entries.find((entry) => entry.id === selector)
      ?? entries.find((entry) => entry.name === selector)
      ?? null;
    if (named && !root) root = named.root;
  }

  if (!root) {
    const fallback = named ?? defaultInstance(env);
    return {
      id: fallback?.id ?? 'default',
      name: fallback?.name ?? 'default',
      root: fallback?.root ?? null,
      default: true,
      pinned: false,
    };
  }

  const id = instanceId(root);
  const registered = getInstance(id, env);
  const isDefault = isDefaultRoot(root, env);
  return {
    id,
    name: registered?.name ?? readProjectFile(root, env).name ?? (basename(root) || id),
    root,
    default: isDefault,
    pinned: !isDefault,
  };
}

/**
 * This process's instance.
 *
 * A read, never a write. Persisting the entry is `claimInstance()`, called once
 * the server knows what port it actually bound — writing at import time would
 * mean every tool that merely reads this module minted a registry entry.
 *
 * The one race that leaves: two consoles starting within the same instant on a
 * machine whose registry is completely empty would both read "no default yet"
 * and both claim it. It survives exactly one start — from the second onward the
 * registry answers — and the cost is two consoles sharing a log, which is what
 * they did in every version before this one.
 */
export const INSTANCE: Instance = resolveInstance();

/**
 * Where this instance's machine-local state lives.
 *
 * The default instance returns the flat legacy directory unchanged — no moves,
 * no renames, no migration step. That is the promise the whole design is built
 * around: an operator upgrading into a multi-instance console keeps their
 * running agent, their log path and, most importantly, their existing phone
 * push subscriptions, because the files those live in never moved.
 */
export function instanceStateDir(instance: Instance = INSTANCE): string {
  return instance.default ? STATE_DIR : join(STATE_DIR, 'instances', instance.id);
}

/** This instance's state directory, resolved once for the module-level consts. */
export const INSTANCE_STATE_DIR = instanceStateDir(INSTANCE);

export function defaultLogFile(): string {
  return join(INSTANCE_STATE_DIR, 'console.log');
}

/**
 * The unit labels a console installed before instances existed answers to.
 *
 * `deploy/agent.sh` bakes these in (`LABEL`, `UNIT`), and the default instance
 * keeps them — P6 generates `com.phase-console.<id>` for the others. An adopted
 * entry records the bare label so the lifecycle verbs can find the agent that
 * is already loaded rather than installing a second one beside it.
 */
export const LEGACY_UNIT = process.platform === 'darwin' ? 'com.phase-console' : 'phase-console.service';

/**
 * Has this machine been running a console since before instances existed?
 *
 * Any one of these is proof: a preferences file, a log where the flat layout
 * put it, or a loaded agent announcing itself through the environment. The
 * question is worth asking because the answer decides whether the first
 * registry entry is an *adoption* — inheriting a footprint, a port and a unit
 * that already exist — or simply the first instance on a clean machine. Both
 * become the default; only the first has anything to inherit.
 */
export function legacyFootprint(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(CONFIG_FILE)
    || existsSync(join(STATE_DIR, 'console.log'))
    || Boolean(env.PHASE_CONSOLE_UNIT);
}

/**
 * Record this instance in the registry, now that its port is a fact.
 *
 * Called from `index.ts` on `listen`, with the port the OS actually gave us
 * rather than the one we asked for. Those differ whenever a probe walked past a
 * busy port, and the registry is only useful if it holds the port that would
 * actually answer.
 *
 * This is also where adoption happens, and it is deliberately not a migration
 * step: nothing moves, nothing is renamed, nothing is copied. A machine that
 * has been running one console simply gains a registry entry *describing* the
 * console it already had — same paths, same port, same unit label. The
 * subscriptions on the operator's phone keep working because the files behind
 * them were never touched. Re-running it is a no-op beyond the pid and clock.
 */
export function claimInstance(port: number, extra: { unit?: string } = {}): void {
  if (!INSTANCE.root) return;
  const adopting = INSTANCE.default && legacyFootprint();
  registerInstance(INSTANCE.root, {
    name: INSTANCE.name,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unit: extra.unit ?? process.env.PHASE_CONSOLE_UNIT ?? (adopting ? LEGACY_UNIT : undefined),
    default: INSTANCE.default ? true : undefined,
  });
}

export function parseFlags(argv: string[], instance: Instance = INSTANCE): Flags {
  // Sentinel rather than a default, because "the operator did not say" and "the
  // operator said 4123" are different answers: the first defers to the project
  // file and the registry, the second beats both.
  let explicitPort: number | undefined;
  const flags: Flags = {
    port: 0,
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
    else if (arg === '--port' || arg === '-p') explicitPort = Number(next());
    else if (arg === '--instance') next();   // read by resolveInstance() before flags exist
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
  // Last, because the whole chain below `--port` depends on which project this
  // is, and `--root` may have been anywhere in the argv.
  flags.port = preferredPort(instance.root ?? flags.root ?? '.', {
    flagPort: explicitPort,
    isDefault: instance.default,
  });
  return flags;
}

/**
 * A port that is actually free, starting from the one we would prefer.
 *
 * Two different reasons to walk past a port, and both matter: it is *bound*
 * (something is listening, ours or not), or it is *spoken for* (another
 * instance registered it and merely is not running this second). Skipping only
 * the first would let a stopped console lose its port to a sibling and come
 * back to an EADDRINUSE it did nothing to deserve.
 *
 * An explicit `--port` is never probed past. Someone who names a port wants
 * that port, and silently serving a different one is how you spend twenty
 * minutes reloading a URL that was answering all along.
 */
export async function resolvePort(
  preferred: number, host: string, instance: Instance = INSTANCE, explicit = false,
): Promise<number> {
  if (explicit || preferred === DEFAULT_PORT) return preferred;
  const taken = reservedPorts(instance.root ?? undefined);
  const limit = PORT_RANGE_START + PORT_RANGE_SIZE;
  for (let port = preferred; port < limit; port++) {
    if (taken.has(port)) continue;
    if (await portIsFree(port, host)) return port;
  }
  return preferred;   // nothing free in the range: fail loudly on bind, not here
}

function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, host, () => probe.close(() => resolveFree(true)));
  });
}

/**
 * Ask whatever is on this port whether it is a console, and whose.
 *
 * The registry can only say who *registered* a port; a stale entry and a
 * process that never released it look identical from there. `/api/state`
 * answers from the process actually holding the socket, which turns "port 4123
 * is in use" from a guess into a fact — and distinguishes the two cases an
 * operator cares about: their own other console (open it) versus something
 * unrelated squatting the port (move).
 *
 * One second, then give up: this runs on the failure path of a start, and a
 * hung probe would turn a clear error into a hang.
 */
export async function probeConsole(
  port: number, host: string,
): Promise<{ root: string | null; instance?: { id: string; name: string } } | null> {
  try {
    const response = await fetch(`http://${host}:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const state = await response.json() as { root?: { path?: string }; instance?: { id: string; name: string } };
    return { root: state.root?.path ?? null, instance: state.instance };
  } catch {
    return null;   // not a console, not answering, or not ours to read
  }
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
   * Automation defaults — the opening values for every launch surface. Each
   * launch can override them for itself; these are what the dialogs open on.
   *
   * - `attachDefaultSkills`: seed the machine's default skills (the
   *   `--default-skills` / `PHASE_CONSOLE_DEFAULT_SKILLS` list) into new runs
   *   and pre-check them in launch dialogs. Off by default: attaching extra
   *   skills to every session is an opt-in, not a side effect of installing.
   * - `qaByDefault`: open launch surfaces with the QA gate ticked, so starting
   *   a run turns QA on for the plan unless the operator unticks it.
   * - `gitMode`: 'new-branch' puts each run on one plan-wide work branch
   *   (`pe/<slug>`); 'default-branch' keeps today's behaviour — sessions work
   *   on whatever is checked out and never create branches.
   * - `openPrOnComplete`: when a new-branch run finishes its last phase, the
   *   final session is instructed to push the branch and open a PR. Meaningful
   *   only with `gitMode: 'new-branch'`.
   * - `repoGuard`: queue runs whose repository scopes overlap (the scheduler's
   *   cross-run serialization). Turning it off admits overlapping runs; a
   *   new-branch run that overlaps a live one is steered into a git worktree.
   */
  attachDefaultSkills?: boolean;
  qaByDefault?: boolean;
  gitMode?: 'default-branch' | 'new-branch';
  openPrOnComplete?: boolean;
  repoGuard?: boolean;
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
  recentRoots: [], theme: 'system', density: 'comfortable', sort: 'activity',
  attachDefaultSkills: false, qaByDefault: false, gitMode: 'default-branch', openPrOnComplete: true, repoGuard: true,
  notify: sanitiseCategories(undefined),
};

/**
 * Coerce the automation keys to values the rest of the app can trust: booleans
 * stay booleans (anything else takes the default), and `gitMode` is
 * 'new-branch' only when it says exactly that — a typo in config.json must
 * never mint branches.
 */
export function sanitiseAutomation(parsed: Partial<Prefs>): Pick<Prefs,
  'attachDefaultSkills' | 'qaByDefault' | 'gitMode' | 'openPrOnComplete' | 'repoGuard'> {
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  return {
    attachDefaultSkills: bool(parsed.attachDefaultSkills, false),
    qaByDefault: bool(parsed.qaByDefault, false),
    gitMode: parsed.gitMode === 'new-branch' ? 'new-branch' : 'default-branch',
    openPrOnComplete: bool(parsed.openPrOnComplete, true),
    repoGuard: bool(parsed.repoGuard, true),
  };
}

/**
 * Preferences about the PERSON, not the project.
 *
 * These follow an operator between consoles: someone who likes a compact dark
 * theme likes it in every project, and having to set it once per instance would
 * be an obvious bug rather than isolation. Everything not on this list is about
 * one project — which repositories are recent, whether QA is on, which
 * notifications matter — and belongs to the instance.
 */
const USER_GLOBAL_KEYS = ['theme', 'density', 'sort', 'model'] as const;

/**
 * Where this instance's own preferences live.
 *
 * The default instance answers `config.json` itself, exactly as
 * `instanceStateDir()` answers the flat state directory: it does not get a
 * keyed file, it keeps the one it has always had. That is not just symmetry —
 * a keyed file for the default would fragment its settings across two names
 * (`instances/default.json` when started with no root, `instances/<id>.json`
 * when started with one) and an operator would watch their preferences appear
 * to reset depending on how the console was launched. One store per instance,
 * and the default's store is the file that predates instances.
 */
export function instancePrefsFile(instance: Instance = INSTANCE): string {
  return instance.default ? CONFIG_FILE : instancePrefsPath(instance.id);
}

function readJson(file: string): Partial<Prefs> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Partial<Prefs> : {};
  } catch {
    return {};
  }
}

/**
 * The preferences this instance runs under: the person's, plus its own.
 *
 * A missing keyed file reads the shared one instead — that is the adoption
 * path, and it is what makes a second console open with the operator's existing
 * automation defaults rather than a blank slate. It stops mattering the first
 * time that instance saves anything, because writes always go to the keyed
 * file.
 */
export function loadPrefs(instance: Instance = INSTANCE): Prefs {
  const shared = readJson(CONFIG_FILE);
  const file = instancePrefsFile(instance);
  const own = file === CONFIG_FILE ? shared : readJson(file);
  // Absent, not merely empty: an instance that has deliberately emptied its
  // recent roots must not have the shared file's list handed back to it.
  const scoped = existsSync(file) ? own : shared;

  // `notify` is rebuilt rather than spread: a stored map missing a key must
  // take that category's default, not inherit `undefined`. The automation
  // keys are rebuilt for the same reason, plus type coercion.
  return {
    ...DEFAULT_PREFS,
    ...scoped,
    ...pick(shared, USER_GLOBAL_KEYS),
    recentRoots: scoped.recentRoots ?? [],
    lastRoot: scoped.lastRoot,
    ...sanitiseAutomation(scoped),
    notify: sanitiseCategories(scoped.notify),
  };
}

function pick<K extends keyof Prefs>(source: Partial<Prefs>, keys: readonly K[]): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * Persist both halves.
 *
 * Two writes for a non-default instance and one for the default, which is the
 * whole split made concrete: the person's choices land in the shared file where
 * the next console will find them, the project's land beside that project's id.
 * The shared file is read-modify-written rather than replaced, so an instance
 * saving its own preferences cannot delete another's.
 */
export function savePrefs(prefs: Prefs, instance: Instance = INSTANCE): void {
  const file = instancePrefsFile(instance);
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (file === CONFIG_FILE) {
      writeFileSync(CONFIG_FILE, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
      return;
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
    const shared = { ...readJson(CONFIG_FILE), ...pick(prefs, USER_GLOBAL_KEYS) };
    writeFileSync(CONFIG_FILE, `${JSON.stringify(shared, null, 2)}\n`, 'utf8');
    const own: Partial<Prefs> = { ...prefs };
    for (const key of USER_GLOBAL_KEYS) delete own[key];
    writeFileSync(file, `${JSON.stringify(own, null, 2)}\n`, 'utf8');
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
