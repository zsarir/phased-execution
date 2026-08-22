/**
 * Freeze / Continue / Stop for ONE agent or shell session.
 *
 * The per-session twin of the run page's `LaneControls`. A recovery agent
 * mid-flight, a QA review, an interactive session — each is a process this
 * console owns, and until these existed its only verb was Close, which is a
 * kill with the record deleted. Freeze is SIGSTOP to the session's process
 * group, losing nothing; Stop is the polite ladder (SIGTERM, SIGKILL only
 * after a grace it ignored) and the record STAYS — a stopped recovery still
 * gets its outcome read against the board, and the `--resume` id survives.
 *
 * Self-contained like `LaneControls` (own busy state, own toasts, cache
 * written from the response) so it can mount in any keybar that has a session.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  ButtonGroup,
  toast,
} from '@/components/ui';
import { api, type TerminalSession, type TerminalState } from '@/lib/api';
import { elapsed } from '@/lib/format';
import { keys } from '@/lib/queries';

export function SessionControls({ session }: { session: TerminalSession }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (session.exited) return null;
  const frozen = session.frozen;
  const disabled = busy != null;

  const act = (
    label: string,
    fn: () => Promise<{ ok: boolean; reason?: string; state: TerminalState }>,
    said: string,
  ) => {
    setBusy(label);
    fn()
      .then((result) => {
        if (result.state) client.setQueryData(keys.terminal(), result.state);
        if (!result.ok) {
          toast(String(result.reason ?? 'refused'), 'error');
          return;
        }
        toast(said, 'ok');
      })
      .catch((error: Error) => toast(String(error?.message ?? error), 'error'))
      .finally(() => {
        setBusy(null);
        void client.invalidateQueries({ queryKey: keys.terminal() });
      });
  };

  // Thumb-sized on touch in both directions: the group's buttons are short
  // words ("Stop"), and height alone is not a tap target.
  const touch = '[@media(hover:none)]:min-w-(--tap-min)';

  return (
    <ButtonGroup aria-label={`${session.label} session controls`}>
      {frozen ? (
        <Button
          size="sm"
          variant="ghost"
          className={touch}
          disabled={disabled}
          title={`Frozen by ${frozen.by}, ${elapsed(Date.now() - frozen.at)} ago — continues mid-token, in the same process`}
          onClick={() =>
            act(
              'thaw',
              () => api.sessionThaw(session.id),
              `${session.label} continued — it picks up mid-token`,
            )
          }
        >
          {busy === 'thaw' ? 'Continuing…' : 'Continue'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className={touch}
          disabled={disabled || Boolean(session.stopping)}
          title={
            session.stopping
              ? 'A stop is already in flight'
              : 'Stops this session’s processes where they stand (SIGSTOP), losing nothing'
          }
          onClick={() =>
            act('freeze', () => api.sessionFreeze(session.id), `${session.label} frozen where it stood`)
          }
        >
          {busy === 'freeze' ? 'Freezing…' : 'Freeze'}
        </Button>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="danger"
            className={touch}
            disabled={disabled || Boolean(session.stopping)}
          >
            {busy === 'stop' || session.stopping ? 'Stopping…' : 'Stop'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title={`Stop ${session.label}?`}
          confirmLabel="Stop the session"
          cancelLabel="Keep running"
          destructive
          onConfirm={() => {
            setConfirming(false);
            act(
              'stop',
              () => api.sessionStop(session.id),
              `${session.label} asked to stop — force-ended only if it ignores the grace`,
            );
          }}
        >
          <p className="mt-2 text-sm text-ink-muted">
            The session gets SIGTERM first, so the CLI shuts down properly; a force-end follows only after a
            15-second grace it ignored. Unlike Close, the record stays in the list — a recovery or QA session
            stopped here still gets its outcome checked, and the{' '}
            <code className="rounded bg-surface-raised px-1 font-mono">--resume</code> id survives.
          </p>
        </AlertDialogContent>
      </AlertDialog>
    </ButtonGroup>
  );
}

/** The tab-strip marker: what a session is doing when it is not simply live. */
export function sessionStateNote(session: TerminalSession): string | null {
  if (session.exited) return 'ended';
  if (session.frozen) return 'frozen';
  if (session.stopping) return 'stopping…';
  return null;
}
