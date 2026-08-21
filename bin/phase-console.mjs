#!/usr/bin/env node
// Phase Console, as an npm / Homebrew bin.
//
//   phase-console                        pick the plan directory in the browser
//   phase-console ~/code/your-repo       open that directory straight away
//   phase-console --allow-writes         also enable the guarded write verbs
//   phase-console start                  start the console for THIS project
//   phase-console list                   every console on this machine
//   phase-console open [instance]        open one in a browser
//   phase-console start | stop | restart | status | logs [-f]  [instance]
//                                        drive the background agent (start falls
//                                        back to a foreground run if none is installed)
//   phase-console remove [instance]      forget a STOPPED console's registry row
//                                        (its state directories stay put)
//   phase-console install-skill          copy the skill where Claude Code reads it
//   phase-console install-hooks          add the session-presence hook to ~/.claude/settings.json
//   phase-console uninstall-hooks        take it out again · hooks-status: is it there?
//
// [instance] is an id, a name, or a project's directory name — or `--instance
// <sel>`. With none, the console for the directory you are standing in.
//
// The bash `bin/phase-console` next to this file serves the plugin route, where
// Claude Code puts the real bin/ directory on PATH. npm and Homebrew instead
// expose the command through a SYMLINK (or an exec script), and bash's
// $BASH_SOURCE resolves to the symlink's directory — the wrong place. This shim
// resolves the package root itself, in an order that keeps Homebrew's
// upgrade-stable opt path intact (so launchd plists written by --install-agent
// survive `brew upgrade`), and only then falls back to realpath for npm's
// global-bin symlink chain.

import {
  cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- node version gate -----------------------------------------------------
// First, before anything imports server code: the server is TypeScript run
// directly, which needs node >= 22.18 (or >= 23.6 — 23.0-23.5 still kept type
// stripping behind a flag). This file itself stays plain JS so an old node can
// parse far enough to print the refusal instead of a syntax-error stack.
const parts = process.versions.node.split('.').map(Number);
const ok = parts[0] >= 24
  || (parts[0] === 23 && parts[1] >= 6)
  || (parts[0] === 22 && parts[1] >= 18);
if (!ok) {
  process.stderr.write(
    `phase-console: node ${process.version} is too old — needs >=22.18 or >=23.6 (runs TypeScript directly)\n`,
  );
  process.exit(1);
}

// ---- package root ----------------------------------------------------------
// Candidates, in order:
//   1. PHASE_CONSOLE_HOME — an explicit override always wins.
//   2. argv[1] un-realpathed — what Homebrew's exec script passes is the
//      opt_libexec path, which survives upgrades; realpathing it would pin a
//      versioned Cellar directory into anything the server writes down.
//   3. argv[1] realpathed — npm's global bin is a symlink into node_modules,
//      and only its target sits inside the package.
const isRoot = (dir) => Boolean(dir) && existsSync(join(dir, 'viewer', 'server', 'index.ts'));
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
let root = null;
for (const candidate of [
  process.env.PHASE_CONSOLE_HOME,
  invoked && dirname(dirname(invoked)),
  invoked && dirname(dirname(safeRealpath(invoked))),
]) {
  if (isRoot(candidate)) { root = candidate; break; }
}
function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}
if (!root) {
  process.stderr.write(
    'phase-console: could not locate the package root (looked for viewer/server/index.ts).\n'
    + 'Set PHASE_CONSOLE_HOME to the phased-execution install directory.\n',
  );
  process.exit(1);
}

// ---- the skill, where Claude Code reads it ---------------------------------
// An npm or brew install puts the console on PATH but Claude Code discovers
// SKILLS from ~/.claude/skills (or CLAUDE_CONFIG_DIR). `install-skill` closes
// that gap: it copies the skill's files — never the viewer — into place, and
// stamps the copy so only its own copies are ever overwritten or removed.
const args = process.argv.slice(2);
const SKILL_STAMP = '.installed-by-phase-console';
const SKILL_FILES = ['SKILL.md', 'USAGE.md', 'scripts', 'templates', 'references', 'assets'];

function skillDest() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude');
  return join(base, 'skills', 'phased-execution');
}

function installSkill(force) {
  const dest = skillDest();
  if (safeRealpath(dest) === safeRealpath(root)) {
    process.stdout.write(`phase-console: the skill already lives where Claude Code reads it (${dest}).\n`);
    return 0;
  }
  if (existsSync(join(dest, '.git'))) {
    process.stderr.write(
      `phase-console: ${dest} is a git clone — update it with git pull, not by overwriting it.\n`,
    );
    return 1;
  }
  if (existsSync(dest) && !existsSync(join(dest, SKILL_STAMP)) && !force) {
    process.stderr.write(
      `phase-console: ${dest} exists and was not put there by this command.\n`
      + 'Re-run with --force to replace it.\n',
    );
    return 1;
  }
  mkdirSync(dest, { recursive: true });
  for (const f of SKILL_FILES) {
    cpSync(join(root, f), join(dest, f), { recursive: true, force: true });
  }
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version; } catch { /* stamp still written */ }
  writeFileSync(join(dest, SKILL_STAMP), `${version}\n`);
  process.stdout.write(
    `installed the skill at ${dest} (from phase-console ${version}).\n`
    + 'Restart Claude Code (or /reload-plugins) and it appears as /phased-execution.\n'
    + 'Re-run install-skill after a package update to refresh it.\n',
  );
  return 0;
}

function uninstallSkill() {
  const dest = skillDest();
  if (!existsSync(dest)) { process.stdout.write('phase-console: no skill copy to remove.\n'); return 0; }
  if (!existsSync(join(dest, SKILL_STAMP))) {
    process.stderr.write(
      `phase-console: ${dest} was not installed by this command — refusing to delete it.\n`,
    );
    return 1;
  }
  rmSync(dest, { recursive: true, force: true });
  process.stdout.write(`removed ${dest}.\n`);
  return 0;
}

if (['install-skill', '--install-skill'].includes(args[0])) {
  process.exit(installSkill(args.includes('--force')));
}
if (['uninstall-skill', '--uninstall-skill'].includes(args[0])) {
  process.exit(uninstallSkill());
}

// ---- the session-presence hook -----------------------------------------------
// `install-hooks` writes three entries (SessionStart, SessionEnd, Stop) into
// the user's ~/.claude/settings.json — merge, never clobber; idempotent — so
// every Claude session on this machine reports itself to the console that owns
// its directory; `uninstall-hooks` takes exactly those out; `hooks-status` says
// which is true (exit 0 installed, 1 not). The same module the Settings card
// uses, imported off `root` like instances.mjs; a packed install ships a
// type-stripped .js beside the .ts, and that one is preferred because node
// refuses to strip types under node_modules.
async function hooksVerb(verb, rest) {
  const js = join(root, 'viewer', 'server', 'hooks-install.js');
  const ts = join(root, 'viewer', 'server', 'hooks-install.ts');
  let mod;
  try {
    mod = await import(pathToFileURL(existsSync(js) ? js : ts).href);
  } catch (error) {
    process.stderr.write(`phase-console: could not load the hook installer (${error.message})\n`);
    return 1;
  }
  const at = rest.indexOf('--settings');
  const settingsPath = at >= 0 ? rest[at + 1] : undefined;
  const opts = { skillDir: root, ...(settingsPath ? { settingsPath } : {}) };
  const describe = (status) => {
    const events = Object.entries(status.events).map(([event, has]) => `${event} ${has ? 'yes' : 'no'}`).join(', ');
    return `${status.path}: ${status.installed ? 'installed' : status.partial ? 'partially installed' : 'not installed'}`
      + `${status.stale ? ' (points at another checkout)' : ''}${status.parseError ? ` (file does not parse: ${status.parseError})` : ''}`
      + ` — ${events}`;
  };
  try {
    if (verb === 'hooks-status') {
      const status = mod.hooksStatus(opts);
      process.stdout.write(`${describe(status)}\n`);
      return status.installed ? 0 : 1;
    }
    const out = verb === 'install-hooks' ? mod.installHooks(opts) : mod.uninstallHooks(opts);
    process.stdout.write(`${out.changed ? (verb === 'install-hooks' ? 'installed' : 'removed') : 'nothing to change'} — ${describe(out.status)}\n`);
    if (verb === 'install-hooks' && out.changed) {
      process.stdout.write('Sessions started from now on report to the console that owns their directory; open ones do not until they restart.\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`phase-console: ${error.message}\n`);
    return 1;
  }
}
if (['install-hooks', 'uninstall-hooks', 'hooks-status'].includes(args[0])) {
  process.exit(await hooksVerb(args[0], args.slice(1)));
}

// ---- agent + lifecycle verbs -----------------------------------------------
// System operations, owned by deploy/agent.sh — mirror viewer/run and hand
// them straight over rather than starting a server. The bare words are the
// daily set; the --agent-* flags are the long-standing spellings.
//
// One install now runs one console per project, so every verb takes an
// INSTANCE: `--instance <id|name>`, or a bare word after the verb, or — the
// case that has to work without being taught — nothing at all, meaning the
// console for the directory you are standing in.
const FLAG_VERBS = {
  '--install-agent': 'install',
  '--uninstall-agent': 'uninstall',
  '--agent-status': 'status',
  '--agent-start': 'start',
  '--agent-stop': 'stop',
  '--agent-restart': 'restart',
  '--agent-update': 'update',
  '--agent-log': 'log',
};
const WORD_VERBS = {
  start: 'start', stop: 'stop', restart: 'restart',
  status: 'status', log: 'log', logs: 'log', update: 'update',
  list: 'list', open: 'open', remove: 'remove',
};

// Resolved from the package root rather than imported by a static path: this
// file is reached through an npm symlink and a Homebrew exec script, and only
// `root` above knows where the package actually is.
const instances = await import(pathToFileURL(join(root, 'viewer', 'shared', 'instances.mjs')).href);

/**
 * A token is a PATH, not an instance name, when it looks like one.
 *
 * `phase-console start ~/code/repo` predates instances and still means "run
 * that directory", while `phase-console start alpha` means the instance called
 * alpha. Nothing distinguishes them but shape, so shape is what decides:
 * anything with a separator, a leading dot or tilde, or an existing directory
 * of that name is a path.
 */
function looksLikePath(token) {
  return token.includes('/') || token.startsWith('.') || token.startsWith('~')
    || existsSync(resolve(token));
}

/**
 * Console flags that take a VALUE, so the value is never mistaken for the
 * positional selector.
 *
 * Without this, `start --port 4123` reads `--port` as an unknown flag to
 * forward and then `4123` as the instance to act on — answering *no instance
 * called "4123"* to a command that named a port, and never reaching the server
 * that would have refused it by name. `--log-file /tmp/x` was worse: the value
 * looks like a path, so it became the ROOT. Kept in sync with the parser in
 * `viewer/server/config.ts`.
 */
const VALUE_FLAGS = new Set([
  '--port', '-p', '--host', '--max-sessions', '--remote', '--remote-user',
  '--scripts', '--default-skills', '--log-file', '--notify',
]);

/** Split a verb's arguments into "which console" and "everything else". */
function parseTarget(rest) {
  let selector;
  let rootArg;
  const keep = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--instance') { selector = rest[++i]; continue; }
    if (arg === '--root' || arg === '-r') { rootArg = rest[++i]; continue; }
    // Forward the flag AND its value together — consuming the value here is
    // what stops the loop below from reading it as a positional selector.
    if (VALUE_FLAGS.has(arg)) {
      keep.push(arg);
      if (i + 1 < rest.length) keep.push(rest[++i]);
      continue;
    }
    if (!arg.startsWith('-') && selector === undefined && rootArg === undefined) {
      if (looksLikePath(arg)) rootArg = arg; else selector = arg;
      continue;
    }
    keep.push(arg);
  }
  return { selector, rootArg, rest: keep };
}

/**
 * The instance a verb is about, with the two facts every verb then needs:
 * whether it is the default (which decides its unit name and its paths) and
 * where its unit file would be.
 */
function describe(found) {
  const isDefault = found.default === true
    || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
  const unit = instances.unitName({ id: found.id, default: isDefault });
  return { ...found, default: isDefault, generatedUnit: unit, unitFile: instances.unitPath(unit) };
}

function locate(selector, rootArg) {
  return rootArg
    ? instances.selectRoot(resolve(expandHome(rootArg)))
    : instances.selectInstance(selector, process.cwd());
}

/** Resolve, or explain the miss and stop. A verb never guesses. */
function target(selector, rootArg) {
  const found = locate(selector, rootArg);
  if (found.kind !== 'registered' && found.kind !== 'candidate') {
    process.stderr.write(`phase-console: ${instances.selectionError(found)}\n`);
    process.exit(1);
  }
  return describe(found);
}

function expandHome(input) {
  return input.startsWith('~') ? join(process.env.HOME ?? '', input.slice(1)) : input;
}

/** Is this instance's OWN agent installed — never "is any console installed". */
function agentInstalled(instance) {
  return existsSync(instance.unitFile);
}

/**
 * Ask a port whether a console is there, and which one.
 *
 * Short timeout on purpose: `list` asks this of every instance in turn, and a
 * port held by something that is not a console (or by nothing at all) must
 * cost a moment, not a hang.
 */
function probeConsole(port, timeoutMs = 2000) {
  return new Promise((done) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/state', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { done(JSON.parse(body)); } catch { done(null); }
        });
      },
    );
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

function toAgent(verb, instance, extra = []) {
  // By id: agent.sh resolves selectors through the same module, and an id is
  // the one selector that cannot be ambiguous.
  const selector = instance.kind === 'registered' ? [instance.id] : ['--root', instance.root];
  const run = spawnSync(
    'bash',
    [join(root, 'viewer', 'deploy', 'agent.sh'), verb, ...selector, ...extra],
    { stdio: 'inherit' },
  );
  process.exit(run.status === null ? 1 : run.status);
}

/** NAME · ROOT · PORT · STATUS · UNIT, one line per registered console. */
async function cmdList() {
  const entries = instances.listInstances();
  if (!entries.length) {
    process.stdout.write('no consoles registered yet — cd to a project and run: phase-console start\n');
    return 0;
  }
  const rows = await Promise.all(entries.map(async (entry) => {
    const described = describe({ kind: 'registered', ...entry });
    const port = entry.port ?? instances.preferredPort(entry.root, { isDefault: described.default });
    const live = await probeConsole(port);
    return {
      name: `${entry.name ?? entry.id}${entry.default ? ' *' : ''}`,
      root: entry.root,
      port: String(port),
      // "running" is only claimed when a console answered AND said it is this
      // root. Something else on the port is a collision, not this instance.
      status: live ? (live.instance?.id === entry.id || live.root?.path === entry.root ? 'running' : 'port taken') : 'stopped',
      unit: agentInstalled(described) ? described.generatedUnit : '—',
    };
  }));
  const columns = ['name', 'root', 'port', 'status', 'unit'];
  const width = Object.fromEntries(columns.map((key) => [
    key, Math.max(key.length, ...rows.map((row) => row[key].length)),
  ]));
  const line = (cells) => columns.map((key) => cells[key].padEnd(width[key])).join('  ').trimEnd();
  process.stdout.write(`${line(Object.fromEntries(columns.map((k) => [k, k.toUpperCase()])))}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
  if (entries.some((entry) => entry.default)) process.stdout.write('\n* the default instance — it keeps the pre-1.3.0 port, paths and unit name.\n');
  if (rows.some((row) => row.status === 'stopped')) {
    process.stdout.write('a stopped console can be forgotten: phase-console remove <name>\n');
  }
  return 0;
}

/**
 * Forget a stopped console: its registry row (and the port it had spoken for)
 * frees up; its state directories stay put. Deliberately a named act rather
 * than a prune on `list` — "stopped" is a legitimate registry state for a
 * project you will start again tomorrow, and a registry that forgets projects
 * by itself forgets one someone wanted.
 */
async function cmdRemove(instance) {
  if (instance.kind !== 'registered') {
    process.stderr.write('phase-console: nothing registered by that name — see: phase-console list\n');
    return 1;
  }
  const port = instance.port ?? instances.preferredPort(instance.root, { isDefault: instance.default });
  const live = await probeConsole(port);
  if (live && (live.instance?.id === instance.id || live.root?.path === instance.root)) {
    process.stderr.write(
      `phase-console: ${instance.name} is running on ${port} — stop it first: phase-console stop ${instance.name}\n`,
    );
    return 1;
  }
  instances.removeInstance(instance.id);
  process.stdout.write(
    `forgot ${instance.name} (${instance.root}) — its state directories are untouched.\n`,
  );
  return 0;
}

/** Open an instance in a browser, or say why there is nothing to open. */
async function cmdOpen(instance) {
  const port = instance.port ?? instances.preferredPort(instance.root, { isDefault: instance.default });
  const live = await probeConsole(port);
  if (!live) {
    process.stderr.write(
      `phase-console: ${instance.name} is not running (nothing answered on ${port}).\n`
      + `Start it with: phase-console start ${instance.kind === 'registered' ? instance.name : ''}\n`,
    );
    return 1;
  }
  const url = instances.instanceUrl(port);
  // The same knob the server honours, for the same reason: a script (or a test
  // suite) asking which URL this instance is on must not fling a browser
  // window at whoever happens to be sitting in front of the machine.
  if (process.env.PHASE_CONSOLE_NO_OPEN === '1') { process.stdout.write(`${url}\n`); return 0; }
  const candidates = process.platform === 'darwin'
    ? ['open']
    : ['wslview', 'xdg-open', 'gio', 'explorer.exe'];
  for (const opener of candidates) {
    const run = spawnSync(opener, [url], { stdio: 'ignore' });
    // explorer.exe answers non-zero even when it worked; only outright absence
    // (ENOENT) means "try the next one".
    if (!run.error) { process.stdout.write(`${url}\n`); return 0; }
  }
  process.stdout.write(`${url}\n(no way to open a browser from here — open it yourself)\n`);
  return 0;
}

/**
 * Stop a console nobody is supervising.
 *
 * A foreground `phase-console start` records its pid, and that is the only
 * handle there is. SIGTERM rather than SIGKILL because the console's own drain
 * takes up to 120s for a live run, and the port is then re-probed rather than
 * trusted: a pid that has been recycled would otherwise report a stop that
 * never happened.
 */
async function stopByPid(instance) {
  const port = instance.port ?? instances.preferredPort(instance.root, { isDefault: instance.default });
  const live = await probeConsole(port);
  if (!live) {
    process.stdout.write(`${instance.name} is not running.\n`);
    return 0;
  }
  const pid = Number(instance.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stderr.write(
      `phase-console: ${instance.name} is answering on ${port} but has no supervisor and no recorded pid.\n`
      + 'It was started by something this registry did not see — stop it where it is running.\n',
    );
    return 1;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    process.stderr.write(`phase-console: could not signal pid ${pid} (${error.code ?? error.message}).\n`);
    return 1;
  }
  for (let waited = 0; waited < 15_000; waited += 500) {
    // eslint-disable-next-line no-await-in-loop -- a poll is a sequence by definition
    if (!await probeConsole(port, 500)) {
      process.stdout.write(`stopped ${instance.name} (pid ${pid}).\n`);
      return 0;
    }
  }
  process.stderr.write(`phase-console: ${instance.name} did not stop within 15s — it may be draining a run.\n`);
  return 1;
}

const verb = FLAG_VERBS[args[0]] ?? WORD_VERBS[args[0]];

if (verb) {
  const parsed = parseTarget(args.slice(1));

  if (verb === 'list') process.exit(await cmdList());

  // `status` with nothing named is the one verb whose honest answer is the
  // whole board, so it goes over unresolved and agent.sh reports every
  // instance. Resolving first would refuse to answer on exactly the machine
  // the question is most worth asking on.
  if (verb === 'status' && !parsed.selector && !parsed.rootArg) {
    const run = spawnSync('bash', [join(root, 'viewer', 'deploy', 'agent.sh'), 'status'], { stdio: 'inherit' });
    process.exit(run.status === null ? 1 : run.status);
  }

  if (verb === 'install') {
    // install keeps its own argv (--root, --port, --notify, --default-skills
    // and any extra console flags) and hands it over untouched.
    const run = spawnSync('bash', [join(root, 'viewer', 'deploy', 'agent.sh'), 'install', ...args.slice(1)], { stdio: 'inherit' });
    process.exit(run.status === null ? 1 : run.status);
  }

  // `start` from a directory nothing claims keeps its pre-instance meaning:
  // run the console with no root and let the browser pick one. Refusing there
  // would take away the way a first-time user opens this at all.
  if (verb === 'start' && !parsed.selector && !parsed.rootArg
      && locate().kind === 'none') {
    args.splice(0, args.length, ...parsed.rest);
  } else {
    const instance = target(parsed.selector, parsed.rootArg);
    await runVerb(verb, instance, parsed.rest);
  }
}

/**
 * Everything a verb does once it knows which console it is about.
 *
 * Split out so the one case that has NO instance — `start` with nothing to
 * start, which falls through to the picker — does not have to be threaded
 * through as a null.
 */
async function runVerb(verb, instance, rest) {
  if (verb === 'open') process.exit(await cmdOpen(instance));
  if (verb === 'remove') process.exit(await cmdRemove(instance));

  if (verb === 'update' && !existsSync(join(root, '.git'))) {
    // A packaged install has no sources and no lockfile — there is nothing for
    // agent.sh to rebuild. The package manager owns updates.
    process.stderr.write(
      'phase-console: this is a packaged install — update it with\n'
      + '  npm update -g phase-console     (npm)\n'
      + '  brew upgrade phase-console      (Homebrew)\n'
      + 'then restart the agent: phase-console restart\n',
    );
    process.exit(1);
  }

  if (agentInstalled(instance)) toAgent(verb, instance, verb === 'log' ? rest : []);

  // No supervisor for THIS instance. What that means depends on the verb.
  if (verb === 'stop') process.exit(await stopByPid(instance));
  if (verb === 'restart') {
    const code = await stopByPid(instance);
    if (code === 0) {
      process.stdout.write(
        `${instance.name} had no agent installed, so there is nothing to bring it back:\n`
        + `  phase-console start ${instance.kind === 'registered' ? instance.name : ''}\n`,
      );
    }
    process.exit(code);
  }
  if (verb === 'status' || verb === 'log' || verb === 'uninstall' || verb === 'update') {
    // agent.sh answers these honestly for an instance with no unit — "not
    // installed", or this instance's own log, which exists either way.
    toAgent(verb, instance, verb === 'log' ? rest : []);
  }

  // `start`, unsupervised: run it here, in the foreground.
  //
  // Registered before the server binds, in two steps and in this order. First
  // the ELECTION — `default: 'auto'` settles inside the registry lock whether
  // this is the machine's default instance. Only then is the port derived,
  // because the answer differs (4123 for the default, a derived slot for
  // everyone else) and deriving it from a guess is how a second console ends up
  // claiming the first one's port. Reserving it here also means a sibling
  // starting a moment later sees it as spoken for.
  const registered = instances.registerInstance(instance.root, {
    name: instance.name,
    default: 'auto',
  });
  const settled = registered?.default === true;
  instances.registerInstance(instance.root, {
    port: instances.preferredPort(instance.root, { isDefault: settled }),
  });
  process.stdout.write(`starting ${instance.name} — ${instance.root}\n`);
  // Deliberately NOT --port: naming a port turns off probing, so a busy
  // neighbour would become a refusal instead of the next free slot. The server
  // derives the same port from the root and prints the one it really bound.
  args.splice(0, args.length, '--root', instance.root, ...rest);
}

// ---- bare first argument is the directory to open (mirror ../start) --------
if (args.length > 0 && !args[0].startsWith('-')) {
  args.splice(0, 1, '--root', args[0]);
}

// ---- run the server, forwarding exit faithfully ----------------------------
// Node refuses to type-strip .ts under any node_modules directory — which is
// where npm global installs and the npx cache live. The tarball ships a
// pre-stripped server/index.js for that case; everywhere else the .ts is the
// truth (clones and Homebrew's libexec have no node_modules in their path).
const serverDir = join(root, 'viewer', 'server');
const underNodeModules = root.split('/').includes('node_modules');
const preferred = join(serverDir, underNodeModules ? 'index.js' : 'index.ts');
const alternate = join(serverDir, underNodeModules ? 'index.ts' : 'index.js');
const entry = existsSync(preferred) ? preferred : alternate;

// stdio inherit puts the child in our foreground group, so Ctrl-C reaches it
// directly; the handlers below cover kills aimed at this process alone.
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('close', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
