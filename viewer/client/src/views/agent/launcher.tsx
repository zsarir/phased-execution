/**
 * The launch form: every choice that must exist before the pty does.
 *
 * The fields are `RunSetup` in `session` mode — the same component the run
 * page, the launch dialog and Settings ▸ Automation render, so "Permissions"
 * means one thing across the console instead of a run profile here and a CLI
 * `--permission-mode` there. The mapping between those two spellings lives in
 * `features/run-setup/modes.ts` (`permissionModeFor`) rather than in two
 * option lists that drifted.
 *
 * The server re-validates every field against the runner's own lists
 * (`server/agent.ts`), so this form is convenience, never the wall.
 * `bypassPermissions` is deliberately not offered here and refused there.
 */

import { RunSetup } from '@/features/run-setup/run-setup';

export interface LaunchBody {
  model?: string;
  effort?: string;
  permissionMode?: string;
  prompt?: string;
  skills?: string[];
  resume?: string;
  /** Which registered account the session spends. Absent = the machine login. */
  accountId?: string;
}

export function Launcher({
  root,
  disabled,
  skillsEnabled,
  onLaunch,
}: {
  /** Where the session will run — the open source directory, when there is one. */
  root?: string;
  /** True at the shared session cap; the form stays visible but cannot start. */
  disabled?: boolean;
  /** `/api/skills` needs an open root; without one the picker hides, never 409s. */
  skillsEnabled: boolean;
  onLaunch(body: LaunchBody): void | Promise<void>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
        <div>
          <h2 className="font-display text-xl">New Claude session</h2>
          <p className="mt-1 text-sm text-ink-muted">
            An interactive Claude Code CLI in a terminal
            {root ? (
              <>
                {' '}
                — running in <span className="font-mono">{root}</span>
              </>
            ) : (
              ' — running in your home directory'
            )}
            . You approve its actions in the terminal itself.
          </p>
        </div>

        <RunSetup
          mode="session"
          skillsEnabled={skillsEnabled}
          blocked={Boolean(disabled)}
          {...(disabled ? { blockedReason: 'Session limit reached — close one first.' } : {})}
          onLaunch={(body) => onLaunch(body as LaunchBody)}
        />

        {!skillsEnabled && (
          <p className="text-sm text-ink-faint">Open a source directory to pick skills for the session.</p>
        )}
      </div>
    </div>
  );
}
