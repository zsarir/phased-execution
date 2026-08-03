/**
 * Restarting the console from the console.
 *
 * The stale-code banner has said "restart it" since the day it was written and
 * could never do it, because the one thing a browser cannot do is relaunch a
 * process. What makes it possible is the supervisor: under launchd `KeepAlive`
 * a clean exit comes straight back within seconds, and under `./run` or the
 * desktop launcher nothing does. So the button asks the server first and says
 * which it is — pressing it where nothing is watching would not restart the
 * console, it would end it, from a page that then has no server to say so.
 *
 * Refused outright while a run is in flight, and that refusal is not overridable
 * from here: a restart aborts the child mid-phase and expires every pending
 * approval unanswerably.
 *
 * Ported from `web/components/restart.js`, with the native `confirm()` replaced
 * by a focus-trapped `AlertDialog` — the same change Phase 4 made to Stop.
 */

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useConsoleState, useRestartReadiness } from '@/lib/queries';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Button, toast } from '@/components/ui';

/** How long to wait before reloading. The server's own drain budget is 120s,
 *  but an idle console has nothing registered and comes back almost at once. */
const RELOAD_AFTER_MS = 4_000;

export function RestartButton({ verbose = false }: { verbose?: boolean }) {
  const { data: state } = useConsoleState();
  const { data: readiness, refetch } = useRestartReadiness();

  const restart = useMutation({
    mutationFn: () => api.restart(),
    onSuccess: () => {
      toast('Restarting — this page reloads by itself in a moment.', 'ok');
      // Nothing here can await the server coming back: the socket this request
      // arrived on is about to close. A reload after the drain is the honest
      // way to return.
      setTimeout(() => location.reload(), RELOAD_AFTER_MS);
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (!readiness) return null;

  if (!state?.allowRun) {
    return (
      <span className="text-2xs text-ink-muted">
        Restarting is a run-class action — this console was started without{' '}
        <code>--allow-run</code>.
      </span>
    );
  }

  if (!readiness.ok) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="text-2xs text-ink-muted">Cannot restart from here — {readiness.reason}</span>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>Check again</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" disabled={restart.isPending}>
            {restart.isPending ? 'Restarting…' : 'Restart the console'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title="Restart the console?"
          description="It exits and its supervisor starts it again — a few seconds with no server. This page reloads itself afterwards."
          confirmLabel="Restart"
          onConfirm={() => restart.mutate()}
        />
      </AlertDialog>
      {verbose && (
        <span className="text-2xs text-ink-muted">{readiness.supervisor?.detail}</span>
      )}
    </div>
  );
}
