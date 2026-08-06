/**
 * The start command, with every capability — composed from the console's own
 * facts, never typed from memory.
 *
 * The question this card answers arrives right after a refusal: "Runs are
 * disabled. Restart with --allow-run" names one flag, and the operator who
 * wants all of it then assembles a command by hand, misspells a flag, and
 * gets a console that looks right and refuses one page. So the card renders
 * the exact line for THIS instance — its root, its port, all five switches —
 * and a copy button.
 *
 * It also says which capabilities the RUNNING console lacks, because the
 * command changes nothing until something restarts with it: on a supervised
 * console the flags live in the launchd plist (the Desktop launcher card
 * beside this one manages that copy), and this line is the foreground /
 * terminal way to the same place.
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

/** POSIX-quote a path for display in a command the operator will paste. */
const sh = (value: string) => (/^[\w./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

export function StartCommandCard() {
  const { data: state } = useConsoleState();

  // The skill root is one directory above the scripts dir the server reports —
  // derived rather than hard-coded, so a clone, an npm install and a Homebrew
  // install each render their own real path.
  const skillRoot = state?.scriptsDir?.replace(/\/scripts\/?$/, '');
  const launcher = skillRoot ? `${sh(skillRoot)}/start` : 'phase-console start';
  const root = state?.root?.path;
  const port = state?.port;

  const command = [
    launcher,
    ...(root ? [sh(root)] : []),
    ...(port ? [`--port ${port}`] : []),
    ...CAPABILITIES.map(([, flag]) => flag),
  ].join(' ');

  const missing = CAPABILITIES.filter(([key]) => state && state[key] !== true).map(([, , label]) => label);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start with every capability</CardTitle>
        <CopyButton text={command} label="Copy command" />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          The exact line for this console — its source directory, its port, and all five switches
          (writes, runs, terminal, agent, accounts). Run it in a terminal; Ctrl-C stops it.
        </p>

        <pre className="m-0 overflow-x-auto rounded bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
          {command}
        </pre>

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
          below manages that copy (its knobs now include ACCOUNTS), and re-running it re-installs
          the agent with the full set.
        </p>
      </CardBody>
    </Card>
  );
}
