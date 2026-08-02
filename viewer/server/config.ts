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

export const VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = dirname(VIEWER_DIR);

export type Flags = {
  root?: string;
  port: number;
  host: string;
  open: boolean;
  allowWrites: boolean;
  scriptsDir: string;
};

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    port: Number(process.env.PHASE_CONSOLE_PORT ?? 4123),
    host: '127.0.0.1',
    // Starting the console should show you the console. Opt out with --no-open
    // (or PHASE_CONSOLE_NO_OPEN=1, which scripts and tests use).
    open: process.env.PHASE_CONSOLE_NO_OPEN !== '1',
    allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'),
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
    else if (arg === '--scripts') flags.scriptsDir = resolve(expandHome(next() ?? ''));
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`Phase Console — local viewer for phased-execution plans

  node server/index.ts [options]

  --root <dir>      open this source directory immediately (skips the picker)
  --port <n>        port to listen on (default 4123)
  --host <addr>     interface to bind (default 127.0.0.1 — localhost only)
  --no-open         do not open the browser (it opens by default)
  --allow-writes    enable the guarded write verbs (scaffold, QA record, locks)
  --scripts <dir>   phased-execution scripts dir (default: the skill this lives in)
`);
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
};

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'phase-console');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_PREFS: Prefs = { recentRoots: [], theme: 'system', density: 'comfortable', sort: 'activity' };

export function loadPrefs(): Prefs {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...parsed, recentRoots: parsed.recentRoots ?? [] };
  } catch {
    return { ...DEFAULT_PREFS };
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
