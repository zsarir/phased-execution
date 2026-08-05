#!/usr/bin/env node
// Phase Console, as an npm / Homebrew bin.
//
//   phase-console                        pick the plan directory in the browser
//   phase-console ~/code/your-repo       open that directory straight away
//   phase-console --allow-writes         also enable the guarded write verbs
//
// The bash `bin/phase-console` next to this file serves the plugin route, where
// Claude Code puts the real bin/ directory on PATH. npm and Homebrew instead
// expose the command through a SYMLINK (or an exec script), and bash's
// $BASH_SOURCE resolves to the symlink's directory — the wrong place. This shim
// resolves the package root itself, in an order that keeps Homebrew's
// upgrade-stable opt path intact (so launchd plists written by --install-agent
// survive `brew upgrade`), and only then falls back to realpath for npm's
// global-bin symlink chain.

import { existsSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

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

// ---- agent verbs -----------------------------------------------------------
// System operations, owned by deploy/agent.sh — mirror viewer/run and hand
// them straight over rather than starting a server.
const args = process.argv.slice(2);
const AGENT_VERBS = {
  '--install-agent': 'install',
  '--uninstall-agent': 'uninstall',
  '--agent-status': 'status',
  '--agent-restart': 'restart',
  '--agent-update': 'update',
  '--agent-log': 'log',
};
if (args[0] in AGENT_VERBS) {
  const verb = AGENT_VERBS[args[0]];
  if (verb === 'update' && !existsSync(join(root, '.git'))) {
    // A packaged install has no sources and no lockfile — there is nothing for
    // agent.sh to rebuild. The package manager owns updates.
    process.stderr.write(
      'phase-console: this is a packaged install — update it with\n'
      + '  npm update -g phase-console     (npm)\n'
      + '  brew upgrade phase-console      (Homebrew)\n'
      + 'then restart the agent: phase-console --agent-restart\n',
    );
    process.exit(1);
  }
  const rest = verb === 'install' || verb === 'log' ? args.slice(1) : [];
  const run = spawnSync('bash', [join(root, 'viewer', 'deploy', 'agent.sh'), verb, ...rest], {
    stdio: 'inherit',
  });
  process.exit(run.status === null ? 1 : run.status);
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
