/**
 * The session-presence hook card.
 *
 * Phase Console learns that a Claude session is live, still live or ended from
 * a user-scope Claude Code hook (`scripts/session-hook.sh`) — the channel an
 * interactive `claude`, a console agent and an autopilot lane did not have.
 * With it installed, a hand-run session shows on the Pulse, the autopilot
 * queues behind its lock while it lives, and the lock is debris the moment the
 * session ends. The server edits `~/.claude/settings.json` itself (merge,
 * never clobber — every other key keeps its bytes); this card only asks it to,
 * and says what is there. The terminal spelling of the same act is
 * `phase-console install-hooks`.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { keys, useConsoleState, useHooksStatus } from '@/lib/queries';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip, toast } from '@/components/ui';

export function SessionHookCard() {
  const { data: status } = useHooksStatus();
  const { data: state } = useConsoleState();
  const client = useQueryClient();
  const [busy, setBusy] = useState<'install' | 'uninstall' | null>(null);

  const shownPath = status?.path && state?.home && status.path.startsWith(`${state.home}/`)
    ? `~${status.path.slice(state.home.length)}`
    : status?.path;

  const act = (action: 'install' | 'uninstall') => {
    setBusy(action);
    api.hooksInstall(action)
      .then((outcome) => {
        client.setQueryData(keys.hooksStatus(), outcome.status);
        toast(action === 'install'
          ? (outcome.changed ? 'Session hook installed — sessions started from now on report to this console.' : 'The session hook was already installed.')
          : (outcome.changed ? 'Session hook removed.' : 'No session hook to remove.'), 'ok');
      })
      .catch((error: Error) => toast(String(error.message ?? error), 'error'))
      .finally(() => setBusy(null));
  };

  const writesOff = state?.allowWrites !== true;
  const tone = !status ? 'neutral'
    : status.parseError ? 'danger'
      : status.installed ? 'ok'
        : status.partial ? 'warn'
          : 'neutral';
  const word = !status ? 'checking…'
    : status.parseError ? 'settings file does not parse'
      : status.installed ? 'installed'
        : status.stale ? 'points at another checkout'
          : status.partial ? 'partially installed'
            : 'not installed';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session presence</CardTitle>
        <Chip tone={tone as never} data-testid="hook-status">{word}</Chip>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="m-0 text-sm text-ink-muted">
          A user-scope Claude Code hook tells this console when any Claude session in its
          repository starts, finishes a turn or ends — a hand-run <code>claude</code>, a console
          agent, an autopilot lane. The Pulse shows them, the autopilot queues behind a live
          session&rsquo;s lock, and the lock is released the moment its session ends instead of
          at the end of its lease.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {status?.installed && !status.stale ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null || writesOff}
              title={writesOff ? 'Restart with --allow-writes — this edits ~/.claude/settings.json.' : `Removes exactly the three entries the console wrote from ${shownPath ?? 'settings.json'}; nothing else in the file moves.`}
              onClick={() => act('uninstall')}
            >
              {busy === 'uninstall' ? 'Removing…' : 'Remove the hook'}
            </Button>
          ) : (
            <Button
              variant="action"
              disabled={busy !== null || writesOff || Boolean(status?.parseError)}
              title={writesOff
                ? 'Restart with --allow-writes — this edits ~/.claude/settings.json.'
                : status?.parseError
                  ? `${shownPath ?? 'settings.json'} does not parse; fix or move it first — the console never overwrites a file it cannot read.`
                  : `Adds SessionStart, SessionEnd and Stop entries to ${shownPath ?? '~/.claude/settings.json'}; every other key keeps its bytes.`}
              onClick={() => act('install')}
            >
              {busy === 'install' ? 'Installing…' : status?.stale || status?.partial ? 'Repair the hook' : 'Install the hook'}
            </Button>
          )}
          {shownPath ? <code className="text-2xs text-ink-faint">{shownPath}</code> : null}
        </div>
        {status?.parseError ? (
          <Banner severity="warn">
            {shownPath} does not parse as JSON ({status.parseError}). The console will not write to a
            settings file it cannot read back — fix or move it, then install.
          </Banner>
        ) : null}
        <p className="m-0 text-2xs text-ink-faint">
          From a terminal: <code>phase-console install-hooks</code> / <code>uninstall-hooks</code> /{' '}
          <code>hooks-status</code>. Sessions already open do not report until they restart. A session
          claiming a phase lock by hand passes <code>--session &lt;id&gt;</code> to{' '}
          <code>phase-lock.sh</code> (the hook tells it its id at start); the autopilot&rsquo;s lanes
          carry theirs automatically. Off by default — installing is the operator&rsquo;s choice.
        </p>
      </CardBody>
    </Card>
  );
}
