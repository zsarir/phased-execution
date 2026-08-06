/**
 * The start command, with every capability — composed from the console's own
 * facts, never typed from memory.
 *
 * Two rules shape the text. Paths render as `"$HOME/…"`, not absolute: the
 * line works pasted on any account, and a screenshot of this page carries no
 * username. And the command is stated PER PLATFORM, because "it works" is a
 * per-OS claim: macOS and Linux run the same shell line (shown under this
 * server's own OS), while Windows has no native console at all — the honest
 * Windows answer is the same line inside WSL, said as such rather than a
 * `cmd.exe` incantation that would fail on its first path.
 *
 * It also says which capabilities the RUNNING console lacks, because the
 * command changes nothing until something restarts with it — on a supervised
 * console the flags live in the launchd plist, which the Desktop-launcher
 * card beside this one manages.
 */

import { useConsoleState } from '@/lib/queries';
import { Card, CardBody, CardHeader, CardTitle, Chip, CopyButton } from '@/components/ui';

/** The five capability switches, in the order every doc lists them. */
const CAPABILITIES = [
  ['allowWrites', '--allow-writes', 'writes'],
  ['allowRun', '--allow-run', 'runs'],
  ['allowTerminal', '--allow-terminal', 'terminal'],
  ['allowAgent', '--allow-agent', 'agent'],
  ['allowAccounts', '--allow-accounts', 'accounts'],
] as const;

/**
 * A path as a paste-anywhere shell word: under the server's home it becomes
 * `"$HOME/…"` (double-quoted so $HOME still expands), elsewhere it is quoted
 * verbatim. Exported for the test that pins "no absolute home paths leak".
 */
export function portablePath(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `"$HOME${path.slice(home.length)}"`;
  }
  return /^[\w./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The console's default session ceiling — a non-default value is worth pinning. */
const DEFAULT_MAX_SESSIONS = 3;

/** The full-options start line for one console. Exported for the test. */
export function composeStartCommand(state: {
  scriptsDir?: string; root?: { path?: string }; port?: number; home?: string;
  remoteHosts?: string[]; remoteUsers?: string[];
  concurrency?: { max?: number }; defaultSkills?: string[];
}): string {
  const skillRoot = state.scriptsDir?.replace(/\/scripts\/?$/, '');
  const launcher = skillRoot ? `${portablePath(`${skillRoot}/start`, state.home)}` : 'phase-console start';
  return [
    launcher,
    ...(state.root?.path ? [portablePath(state.root.path, state.home)] : []),
    ...(state.port ? [`--port ${state.port}`] : []),
    ...CAPABILITIES.map(([, flag]) => flag),
    // Everything else this console was started with — remote access, the
    // session ceiling, default skills. A pasted line that silently dropped
    // `--remote` disabled someone's phone access; "the exact line" means all
    // of it. Defaults stay unspoken so a plain console composes the plain line.
    ...(state.remoteHosts ?? []).flatMap((host) => ['--remote', host]),
    ...(state.remoteUsers ?? []).flatMap((user) => ['--remote-user', user]),
    ...(typeof state.concurrency?.max === 'number' && state.concurrency.max !== DEFAULT_MAX_SESSIONS
      ? [`--max-sessions ${state.concurrency.max}`] : []),
    ...(state.defaultSkills?.length ? [`--default-skills ${state.defaultSkills.join(',')}`] : []),
  ].join(' ');
}

export function StartCommandCard() {
  const { data: state } = useConsoleState();

  const command = composeStartCommand(state ?? {});
  const missing = CAPABILITIES
    .filter(([key]) => state && state[key] !== true)
    .map(([, , label]) => label);
  const os = state?.platform === 'darwin' ? 'macOS' : state?.platform === 'linux' ? 'Linux' : 'this machine';
  const otherUnix = state?.platform === 'darwin' ? 'Linux' : 'macOS';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start with every capability</CardTitle>
        <CopyButton text={command} label="Copy command" />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          The exact line for this console — its source directory, its port, all five switches
          (writes, runs, terminal, agent, accounts), and every setting it was started with
          (remote access, session ceiling, default skills). Paths are <code>$HOME</code>-relative,
          so the line is portable and screenshots carry no username.
        </p>

        <div>
          <div className="text-2xs uppercase tracking-wide text-ink-faint">{os} — run it in a terminal, Ctrl-C stops it</div>
          <pre className="m-0 mt-1 overflow-x-auto rounded bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
            {command}
          </pre>
        </div>

        <div className="flex flex-col gap-1 text-2xs text-ink-faint">
          <span>
            <strong className="text-ink-muted">{otherUnix}:</strong> the same line works — the paths
            it shows are this machine's install, so run it where the console is installed.
          </span>
          <span>
            <strong className="text-ink-muted">Windows:</strong> Phase Console runs on macOS and
            Linux only — on Windows, install it inside WSL and run the line above in your WSL shell
            (<code>wsl</code>, then paste it). There is no native <code>cmd.exe</code> form.
          </span>
        </div>

        {state ? (
          missing.length ? (
            <p className="text-sm text-ink-muted">
              This console is currently missing{' '}
              {missing.map((label) => <Chip key={label} className="mr-1">{label}</Chip>)}
              — the command changes nothing until a console restarts with it.
            </p>
          ) : (
            <p className="text-sm text-ink-muted">
              This console already runs with every capability.
            </p>
          )
        ) : null}

        <p className="text-2xs text-ink-faint">
          Supervised by launchd? The flags live in the agent's plist — the Desktop launcher card
          below writes a launcher with the full set, and re-running it re-installs the agent.
          Deliberately not composed: <code>--host</code> (the console binds localhost, always),{' '}
          <code>--instance</code>, <code>--scripts</code> and <code>--log-file</code> — install-shaped
          flags the guide's reference table covers.
        </p>
      </CardBody>
    </Card>
  );
}
