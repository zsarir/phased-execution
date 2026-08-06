/**
 * Creating the desktop launcher — one click instead of a copy-and-edit ritual.
 *
 * The repo ships `deploy/desktop-launcher.command` with placeholder knobs,
 * because a public file must carry nobody's machine layout. What a person
 * actually wants on their Desktop is that file with THEIR root, THEIR port and
 * every capability switch on — which is exactly the substitution a program
 * does better than a human copying a file and hunting for line 58.
 *
 * Per platform, honestly:
 *   darwin  the shipped `.command`, knobs patched, executable — double-click.
 *   linux   an XDG `.desktop` entry running the start script in a terminal.
 *           Exec lines expand no environment variables, so the paths are baked
 *           absolute; GNOME additionally wants a right-click → Allow Launching
 *           the first time, which the answer says rather than hides.
 *   win32   not supported natively — the console itself only runs on
 *           darwin/linux (package.json `os`), so Windows means WSL, and a
 *           `.lnk` pointing into a WSL filesystem is a lie waiting to break.
 *
 * Everything filesystem-shaped is parameterised (home, platform, source) so
 * the tests never touch a real Desktop.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR, VIEWER_DIR } from './config.ts';

/** The five capability switches, the full set the launcher turns on. */
export const FULL_FLAGS = [
  '--allow-writes', '--allow-run', '--allow-terminal', '--allow-agent', '--allow-accounts',
] as const;

export type LauncherPlan = {
  platform: NodeJS.Platform;
  supported: boolean;
  /** Where the artifact would be written. Absent when unsupported. */
  path?: string;
  kind?: 'command' | 'desktop-entry';
  /** What to tell the operator — the WSL story on win32, Allow Launching on linux. */
  note: string;
};

export type LauncherOptions = {
  root: string;
  port: number;
  /** Distinguishes a second project's launcher from the default one's. */
  instanceName?: string;
  isDefault?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  /** The shipped template — injectable so tests patch a fixture, not the repo. */
  source?: string;
  skillDir?: string;
};

/** `$HOME`-relative when possible: the file stays honest if the user renames nothing but their disk. */
function homeRelative(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`)
    ? `$HOME${path.slice(home.length)}`
    : path;
}

export function launcherPlan(opts: {
  platform?: NodeJS.Platform; home?: string; instanceName?: string; isDefault?: boolean;
} = {}): LauncherPlan {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const suffix = opts.isDefault === false && opts.instanceName ? ` — ${opts.instanceName}` : '';
  if (platform === 'darwin') {
    return {
      platform,
      supported: true,
      kind: 'command',
      path: join(home, 'Desktop', `Phase Console${suffix}.command`),
      note: 'Double-click it. The first run may install the launchd agent, which builds the client once.',
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      supported: true,
      kind: 'desktop-entry',
      path: join(home, 'Desktop', `phase-console${suffix ? `-${opts.instanceName}` : ''}.desktop`),
      note: 'On GNOME, right-click it once and choose "Allow Launching" — new .desktop files start untrusted.',
    };
  }
  return {
    platform,
    supported: false,
    note: 'Phase Console runs on macOS and Linux. On Windows, install it inside WSL and run the '
      + 'start command in your WSL shell — a Windows shortcut into a WSL filesystem breaks on the '
      + 'first path it touches.',
  };
}

/** The shipped template with THIS machine's knobs baked in. Exported for tests. */
export function renderCommandFile(source: string, opts: { root: string; port: number; home: string }): string {
  if (!/^LAUNCHER_REV=\d+$/m.test(source)) {
    throw new Error('the launcher template has no LAUNCHER_REV — refusing to write a copy that cannot detect staleness');
  }
  let patched = source.replace(/^ROOT=.*$/m, `ROOT="${homeRelative(opts.root, opts.home)}"`);
  patched = patched.replace(/^PORT=.*$/m, `PORT=${opts.port}`);
  for (const line of ['WRITES="--allow-writes"', 'RUNS="--allow-run"', 'TERM_FLAG="--allow-terminal"',
    'AGENT="--allow-agent"', 'ACCOUNTS="--allow-accounts"']) {
    if (!patched.includes(line)) {
      throw new Error(`the launcher template is missing its ${line.split('=')[0]} knob — update the template first`);
    }
  }
  return patched;
}

/** The XDG entry. Exec expands no env vars, so every path is absolute. */
export function renderDesktopEntry(opts: { skillDir: string; root: string; port: number }): string {
  const command = [
    `"${opts.skillDir}/start"`,
    `"${opts.root}"`,
    `--port ${opts.port}`,
    ...FULL_FLAGS,
  ].join(' ');
  // Exec quoting per the spec: the whole argument double-quoted, embedded
  // double quotes and backslashes escaped.
  const exec = `bash -lc ${quoteExecArg(command)}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Phase Console',
    'Comment=Local console for phased-execution plans — starts with every capability',
    `Exec=${exec}`,
    'Terminal=true',
    'Icon=utilities-terminal',
    'Categories=Development;',
    '',
  ].join('\n');
}

function quoteExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function installDesktopLauncher(opts: LauncherOptions): { ok: true; path: string; note: string } {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const plan = launcherPlan({
    platform, home, instanceName: opts.instanceName, isDefault: opts.isDefault,
  });
  if (!plan.supported || !plan.path) throw new Error(plan.note);

  const skillDir = opts.skillDir ?? SKILL_DIR;
  mkdirSync(join(plan.path, '..'), { recursive: true });
  if (plan.kind === 'command') {
    const source = opts.source ?? readFileSync(join(VIEWER_DIR, 'deploy', 'desktop-launcher.command'), 'utf8');
    writeFileSync(plan.path, renderCommandFile(source, { root: opts.root, port: opts.port, home }), 'utf8');
  } else {
    writeFileSync(plan.path, renderDesktopEntry({ skillDir, root: opts.root, port: opts.port }), 'utf8');
  }
  // Executable either way: a `.command` needs it to run, and GNOME will not
  // even OFFER Allow Launching on a .desktop file without the bit.
  chmodSync(plan.path, 0o755);
  return { ok: true, path: plan.path, note: plan.note };
}
