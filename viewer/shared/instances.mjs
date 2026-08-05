/**
 * Which console is this, and where does it keep its things.
 *
 * One install, N consoles — one per project. Until now a machine ran exactly
 * one: a fixed port, a fixed state directory, a fixed unit label. Everything
 * that made that true was a constant computed at module load, so a second
 * console on the same machine did not fail loudly — it quietly shared the first
 * one's log, inbox, push subscriptions and approvals queue, which is worse.
 *
 * The identity is a pure function of the project root, and it is deliberately
 * the SAME function `runDir()` already used to key run journals
 * (`server/runner/state.ts`). That was the precedent worth keeping: two
 * checkouts of one repository are two different things, and a hash of the path
 * plus its basename says so while staying readable to a person who goes looking
 * in `~/.local/state`. `state.ts` now imports `instanceId` from here rather
 * than computing its own copy, so run keying and instance keying cannot drift.
 *
 * Plain ESM with JSDoc rather than TypeScript, like `shared/scope.js`, because
 * it is loaded three ways: imported by the server, imported by tests, and
 * **executed as a CLI by bash**. That last one is the reason the hash lives
 * here and only here — `sha256sum` in a shell reads `echo`'s trailing newline
 * and answers a different digest, so the bash half never reimplements it. It
 * shells out to `node instances.mjs id <root>` and uses what it is told.
 *
 * Nothing here throws on bad input. A registry is a convenience that must not
 * be able to stop a console from booting: an unparseable file degrades to an
 * empty one and is rebuilt, a home directory that cannot be written is a
 * console with no memory of its port rather than a crash.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** The port a single-console machine has always used. The default keeps it. */
export const DEFAULT_PORT = 4123;

/**
 * Where derived ports live: 100 slots immediately above the default.
 *
 * Bounded on purpose. A derived port has to be predictable — `phase-console
 * open` prints a URL without asking the server — and it has to stay out of the
 * ephemeral range the OS hands to everything else. A hundred slots is more
 * projects than anyone opens at once, and probing covers the collisions.
 */
export const PORT_RANGE_START = 4124;
export const PORT_RANGE_SIZE = 100;

/** Project-local, committed, shareable: `{name?, port?}` and nothing else. */
export const PROJECT_FILE = '.phase-console.json';

const REGISTRY_VERSION = 1;

/** A lock older than this belonged to a process that is not coming back. */
const LOCK_STALE_MS = 10_000;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The id of the console that serves this project root.
 *
 * `sha256(root)[:8]-basename(root)` — the hash keeps two checkouts of the same
 * repository apart, the basename keeps the directory name readable to whoever
 * is reading `~/.local/state/phase-console/instances/` at 2am.
 *
 * The path is resolved first so `/p/repo`, `/p/repo/` and `/p/sub/../repo` are
 * one instance rather than three. Resolution is lexical (never `realpath`), so
 * a symlinked path stays its own identity — which is what someone who
 * deliberately keeps two symlinks to one tree is asking for.
 */
export function instanceId(root) {
  const path = resolve(String(root ?? '.'));
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `${hash}-${basename(path) || 'root'}`;
}

/**
 * The port a non-default instance lands on before any probing.
 *
 * Derived from the id rather than assigned in order, so the same project gets
 * the same port on every machine and after every registry loss — a URL an
 * operator has bookmarked keeps working. Collisions are real (a hundred slots)
 * and are resolved by probing upward, not by making this cleverer.
 */
export function derivePort(id) {
  const hash = String(id ?? '').slice(0, 8);
  const n = parseInt(hash, 16);
  const offset = Number.isFinite(n) ? Math.abs(n) % PORT_RANGE_SIZE : 0;
  return PORT_RANGE_START + offset;
}

/** `http://127.0.0.1:<port>` — the one form every message prints. */
export function instanceUrl(port, host = '127.0.0.1') {
  return `http://${host}:${port}`;
}

/* ------------------------------------------------------------------ *
 * Where the registry lives
 * ------------------------------------------------------------------ */

/**
 * Where this machine keeps console configuration.
 *
 * `XDG_CONFIG_HOME` falls through to the real process environment when the
 * caller's `env` does not define it, and that fallback is load-bearing. Callers
 * pass a partial environment all the time — a test asking "what if
 * `PHASE_CONSOLE_PORT` were set", a resolver threading one variable through —
 * and taking those objects literally would answer `$HOME/.config` for every one
 * of them. That is not a wrong-looking path; it is the operator's REAL registry,
 * read (and eventually written) by a process that believed it was sandboxed.
 *
 * So the rule is: the config *location* belongs to the process, and only an
 * `env` that explicitly names `XDG_CONFIG_HOME` moves it.
 */
export function configDir(env = process.env) {
  const home = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(home, 'phase-console');
}

export function registryPath(env = process.env) {
  return join(configDir(env), 'instances.json');
}

/** Per-instance preferences: `~/.config/phase-console/instances/<id>.json`. */
export function instancePrefsPath(id, env = process.env) {
  return join(configDir(env), 'instances', `${safeId(id)}.json`);
}

/**
 * An id as a filename component, and never anything else.
 *
 * `instanceId` cannot produce a separator, but this is also handed ids that
 * came off a CLI argument or an HTTP body, and a value that decides a path is
 * checked where it is used rather than where it was born.
 */
function safeId(id) {
  return String(id ?? '')
    .replace(/[^\w.-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'unnamed';
}

/* ------------------------------------------------------------------ *
 * Reading and writing the registry
 * ------------------------------------------------------------------ */

/** An empty registry — the shape every reader can rely on getting. */
function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: {} };
}

/**
 * The registry as it is on disk, or an empty one.
 *
 * Every failure mode lands in the same place deliberately: missing, truncated
 * mid-write, hand-edited into invalid JSON, or written by a future version with
 * a shape this code does not know. None of those is worth refusing to boot
 * over, and all of them are fixed by the next `register()` rewriting the file.
 */
export function readRegistry(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.instances !== 'object' || !parsed.instances) {
      return emptyRegistry();
    }
    const instances = {};
    for (const [id, entry] of Object.entries(parsed.instances)) {
      if (entry && typeof entry === 'object' && typeof entry.root === 'string') instances[id] = entry;
    }
    return { version: REGISTRY_VERSION, instances };
  } catch {
    return emptyRegistry();
  }
}

/**
 * Replace the registry atomically.
 *
 * Temp file plus rename, so a reader never sees half a file — two consoles
 * starting at once is the normal case this exists for, not an edge one. The
 * pid in the temp name keeps two writers from colliding on the temp itself.
 */
export function writeRegistry(registry, env = process.env) {
  const file = registryPath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ version: REGISTRY_VERSION, instances: registry.instances ?? {} }, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* the temp file is not the point */ }
    return false;
  }
}

/**
 * Run `mutate` with the registry held, and write back what it returns.
 *
 * `O_EXCL` is the lock: it succeeds for exactly one process. A lock whose file
 * is older than `LOCK_STALE_MS` is reclaimed, because the alternative — a
 * console killed mid-register wedging every future one — is a worse failure
 * than two writers racing for one write. Returning `null` from `mutate` means
 * "nothing to write", which keeps read-modify-no-op cheap.
 */
export function withRegistry(mutate, env = process.env) {
  const lock = `${registryPath(env)}.lock`;
  let held = false;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2 && !held; attempt++) {
      try {
        closeSync(openSync(lock, 'wx'));
        held = true;
      } catch {
        // Someone holds it. If their file is stale they are gone; clear it and
        // try once more. If they are alive, proceed unlocked rather than block
        // a boot — the write itself is still atomic.
        let age = 0;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = LOCK_STALE_MS + 1; }
        if (age > LOCK_STALE_MS) { try { rmSync(lock, { force: true }); } catch { /* raced */ } }
        else break;
      }
    }
    const registry = readRegistry(env);
    const next = mutate(registry);
    if (next === null || next === undefined) return registry;
    writeRegistry(next, env);
    return next;
  } catch {
    return readRegistry(env);
  } finally {
    if (held) { try { rmSync(lock, { force: true }); } catch { /* released by expiry */ } }
  }
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

/** Every registered instance, with its id folded in, oldest entry first. */
export function listInstances(env = process.env) {
  const { instances } = readRegistry(env);
  return Object.entries(instances).map(([id, entry]) => ({ id, ...entry }));
}

/** One instance by id, or `null`. */
export function getInstance(id, env = process.env) {
  const entry = readRegistry(env).instances[id];
  return entry ? { id, ...entry } : null;
}

/** The instance registered for this root, or `null`. */
export function instanceForRoot(root, env = process.env) {
  return getInstance(instanceId(root), env);
}

/**
 * Which instance claims this port — the question an EADDRINUSE needs answered.
 *
 * A registry answer is a claim, not a proof: the entry says who registered the
 * port, and something else entirely may be holding it now. Callers that need
 * certainty probe the port as well; this is the half that can name a project.
 */
export function instanceForPort(port, env = process.env) {
  return listInstances(env).find((entry) => entry.port === port) ?? null;
}

/** The one instance marked `default`, or `null` if a machine has none yet. */
export function defaultInstance(env = process.env) {
  return listInstances(env).find((entry) => entry.default === true) ?? null;
}

/**
 * Add or update the entry for a root, and return it.
 *
 * `default` is exclusive: setting it here clears it everywhere else in the same
 * write, so a machine can never have two defaults — which would make "the
 * default instance keeps the legacy paths" ambiguous, and the legacy paths are
 * exactly the ones with the operator's real push subscriptions in them.
 */
export function registerInstance(root, patch = {}, env = process.env) {
  const path = resolve(String(root ?? '.'));
  const id = instanceId(path);
  withRegistry((registry) => {
    const previous = registry.instances[id] ?? {};
    const entry = {
      ...previous,
      ...stripUndefined(patch),
      root: path,
      name: patch.name ?? previous.name ?? (basename(path) || id),
    };
    const instances = { ...registry.instances, [id]: entry };
    if (entry.default === true) {
      for (const [other, value] of Object.entries(instances)) {
        if (other !== id && value.default) instances[other] = { ...value, default: false };
      }
    }
    return { ...registry, instances };
  }, env);
  return getInstance(id, env);
}

/** Patch one entry in place. Unknown ids are a no-op, not an error. */
export function updateInstance(id, patch = {}, env = process.env) {
  withRegistry((registry) => {
    const previous = registry.instances[id];
    if (!previous) return null;
    return { ...registry, instances: { ...registry.instances, [id]: { ...previous, ...stripUndefined(patch) } } };
  }, env);
  return getInstance(id, env);
}

/** Forget an instance. Its state directory is left alone — see `remove` in the CLI. */
export function removeInstance(id, env = process.env) {
  let removed = false;
  withRegistry((registry) => {
    if (!registry.instances[id]) return null;
    const instances = { ...registry.instances };
    delete instances[id];
    removed = true;
    return { ...registry, instances };
  }, env);
  return removed;
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object ?? {}).filter(([, value]) => value !== undefined));
}

/* ------------------------------------------------------------------ *
 * Answering "which console serves where I am standing?"
 * ------------------------------------------------------------------ */

/**
 * The instance that owns `cwd`, walking up until something claims it.
 *
 * Two answers, and the difference matters to the caller: a `registered` hit is
 * a console that exists and has a port; a `candidate` is a directory that looks
 * like a project (`docs/plans`, or a committed project file) but has never been
 * started. `phase-console start` in a fresh checkout is the second case, and
 * telling it apart from "you are nowhere near a project" is the whole point.
 */
export function resolveInstance(cwd = process.cwd(), env = process.env) {
  const start = resolve(String(cwd ?? '.'));
  const { instances } = readRegistry(env);
  let candidate = null;

  for (let dir = start; ; dir = dirname(dir)) {
    const id = instanceId(dir);
    if (instances[id]) return { kind: 'registered', id, root: dir, ...instances[id] };
    if (!candidate && looksLikeProject(dir)) candidate = { kind: 'candidate', id, root: dir, name: basename(dir) || id };
    if (dirname(dir) === dir) break;
  }
  return candidate ?? { kind: 'none', root: start };
}

/** A directory the console could open: it has plans, or it says it is one. */
export function looksLikeProject(dir) {
  return existsSync(join(dir, 'docs', 'plans'))
    || existsSync(join(dir, 'plans'))
    || existsSync(join(dir, PROJECT_FILE));
}

/* ------------------------------------------------------------------ *
 * The project file
 * ------------------------------------------------------------------ */

/**
 * `.phase-console.json` at a project root: `{name?, port?}`, nothing else.
 *
 * Committed and shared with a team, so the allowlist is the feature. No paths
 * (they mean nothing on a colleague's machine), no secrets, no flags that widen
 * what the console may do — a file that could turn on `--allow-run` by being
 * checked into a repository would make cloning a repository a security
 * decision. Unknown keys are dropped in silence: a newer version's file must
 * not break an older console.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name?: string, port?: number }}
 */
export function readProjectFile(root, env = process.env) {
  void env;
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(String(root ?? '.')), PROJECT_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    /** @type {{ name?: string, port?: number }} */
    const out = {};
    if (typeof parsed.name === 'string' && parsed.name.trim()) out.name = parsed.name.trim().slice(0, 60);
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port;
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

/**
 * The port this root should try, before anything checks whether it is free.
 *
 * The precedence chain, highest first: an explicit `--port`, then
 * `PHASE_CONSOLE_PORT`, then the project's committed file, then whatever this
 * instance actually bound last time, then the derived slot (or 4123 for the
 * default instance). Each step is "someone said so" outranking "we worked it
 * out", which is the only ordering that lets an operator win an argument with
 * the registry.
 */
export function preferredPort(root, options = {}, env = process.env) {
  const { flagPort, isDefault } = options;
  if (Number.isInteger(flagPort) && flagPort > 0) return flagPort;

  const fromEnv = Number(env.PHASE_CONSOLE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;

  const project = readProjectFile(root, env);
  if (project.port) return project.port;

  const entry = instanceForRoot(root, env);
  if (entry && Number.isInteger(entry.port) && entry.port > 0) return entry.port;

  const fallbackDefault = isDefault ?? isDefaultRoot(root, env);
  return fallbackDefault ? DEFAULT_PORT : derivePort(instanceId(root));
}

/**
 * Is this root the default instance — the one that keeps the legacy footprint?
 *
 * A machine with no registry at all answers `true`: the first console to start
 * on a fresh machine is the default, and so is the single console that has been
 * running since before instances existed. That is the migration promise, stated
 * as a predicate.
 */
export function isDefaultRoot(root, env = process.env) {
  const entries = listInstances(env);
  if (!entries.length) return true;
  const current = entries.find((entry) => entry.id === instanceId(root));
  if (current) return current.default === true;
  return !entries.some((entry) => entry.default === true);
}

/**
 * Ports already spoken for by *other* roots.
 *
 * Consulted before probing so a second console does not settle on a port its
 * sibling merely happens not to be listening on this second — a stopped
 * console still owns its port, and stealing it turns a restart into a
 * confusing EADDRINUSE later rather than a clear one now.
 */
export function reservedPorts(exceptRoot, env = process.env) {
  const skip = exceptRoot === undefined ? null : instanceId(exceptRoot);
  const taken = new Set();
  for (const entry of listInstances(env)) {
    if (entry.id === skip) continue;
    if (Number.isInteger(entry.port) && entry.port > 0) taken.add(entry.port);
  }
  return taken;
}

/* ------------------------------------------------------------------ *
 * CLI — what bash and the P6 lifecycle verbs shell out to
 * ------------------------------------------------------------------ */

/**
 * One argv, one answer on stdout, exit 0 or 1. No colour, no prose.
 *
 * Kept deliberately dumb: every consumer is a shell script capturing stdout, so
 * a stray progress line is a parse bug in someone else's code. Anything that
 * fails prints to stderr and exits 1.
 */
export function runCli(argv, env = process.env) {
  const [op, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  const num = (value) => (value === undefined ? undefined : Number(value));

  switch (op) {
    case 'id':
      return { out: instanceId(positional[0] ?? '.'), code: 0 };

    case 'register': {
      const entry = registerInstance(positional[0] ?? '.', {
        name: flag('name'),
        port: num(flag('port')),
        unit: flag('unit'),
        pid: num(flag('pid')),
        startedAt: flag('started-at'),
        default: rest.includes('--default') ? true : undefined,
      }, env);
      return { out: JSON.stringify(entry), code: entry ? 0 : 1 };
    }

    case 'update': {
      const entry = updateInstance(positional[0] ?? '', {
        name: flag('name'),
        root: flag('root'),
        port: num(flag('port')),
        unit: flag('unit'),
        pid: num(flag('pid')),
        startedAt: flag('started-at'),
        default: rest.includes('--default') ? true : undefined,
      }, env);
      if (!entry) return { err: `no such instance: ${positional[0] ?? ''}`, code: 1 };
      return { out: JSON.stringify(entry), code: 0 };
    }

    case 'remove':
      return removeInstance(positional[0] ?? '', env)
        ? { out: positional[0], code: 0 }
        : { err: `no such instance: ${positional[0] ?? ''}`, code: 1 };

    case 'list': {
      const entries = listInstances(env);
      if (rest.includes('--json')) return { out: JSON.stringify(entries), code: 0 };
      // Tab-separated so `cut -f` and `while read` both work without quoting.
      return { out: entries.map((e) => [e.id, e.name ?? '', e.port ?? '', e.default ? 'default' : '', e.root].join('\t')).join('\n'), code: 0 };
    }

    case 'resolve':
      return { out: JSON.stringify(resolveInstance(positional[0] ?? process.cwd(), env)), code: 0 };

    case 'port':
      return { out: String(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    case 'url':
      return { out: instanceUrl(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    default:
      return {
        err: 'usage: instances.mjs id|register|update|remove|list|resolve|port|url [<path>] [--name n] [--port p] [--unit u] [--pid n] [--started-at s] [--default] [--json]',
        code: 2,
      };
  }
}

// Executed directly (`node viewer/shared/instances.mjs id <root>`) rather than
// imported. `process.argv[1]` is compared against this file's own URL so that
// importing the module never runs the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { out, err, code } = runCli(process.argv.slice(2));
  if (out) process.stdout.write(`${out}\n`);
  if (err) process.stderr.write(`${err}\n`);
  process.exit(code);
}
