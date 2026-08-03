/**
 * The off switch.
 *
 * The console has always had a Restart button and never a Stop one, and the
 * reason is the same fact that makes Restart possible: under launchd
 * `KeepAlive`, exiting IS restarting. There was no way to say "stop" from a page
 * whose server's every exit is a comeback — so the only way to end a console was
 * a terminal and `launchctl`, which is exactly the situation a browser UI is
 * supposed to remove.
 *
 * Two things make this honest rather than a button that hopes:
 *
 *  - **The server does the right thing per supervisor** — `bootout` under
 *    launchd, a graceful exit anywhere else (`server/lifecycle.ts`).
 *  - **The dialog is an inventory, not a warning.** It lists what will stop:
 *    the run (checkpointed), each live agent session, each terminal. "Are you
 *    sure?" is not a question anyone can answer; "this will stop 2 agent
 *    sessions and the demo run" is.
 *
 * And it is deliberately not behind `--allow-run`, unlike Restart: a read-only
 * console is the common case, and the one thing every console must be able to do
 * is stop.
 */

import { useMutation } from '@tanstack/react-query';
import { Power } from 'lucide-react';
import { api, type SessionInventory } from '@/lib/api';
import { useShutdownReadiness } from '@/lib/queries';
import { markConsoleStopped } from '@/lib/shutdown';
import { plural } from '@/lib/format';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Button, toast } from '@/components/ui';

/**
 * Everything this button is about to end, in a sentence a person can check
 * against what they believe is running.
 *
 * Exported because Restart shows the same list: it has always killed every pty
 * on its way through `shutdown()` and has never said so, which is the same
 * defect in a different dialog.
 */
export function stopList(
  sessions: SessionInventory | undefined,
  run: { slug: string; status: string } | null | undefined,
): string[] {
  const items: string[] = [];
  if (run) items.push(`the ${run.slug} run (${run.status}) — checkpointed first, and it resumes when the console comes back`);
  if (sessions?.agent) items.push(`${plural(sessions.agent, 'agent session')}`);
  if (sessions?.terminal) items.push(`${plural(sessions.terminal, 'terminal')}`);
  return items;
}

/**
 * The list itself, shared by both dialogs so they cannot drift into telling
 * different stories about the same act.
 */
export function StopInventory({ items, hint }: { items: string[]; hint?: string }) {
  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {items.length ? (
        <>
          <span className="text-ink">This stops:</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </>
      ) : (
        <span className="text-ink-muted">Nothing is running — no session, no run.</span>
      )}
      {hint && (
        <p className="text-2xs text-ink-faint">
          To start it again: <code className="font-mono">{hint}</code>
        </p>
      )}
    </div>
  );
}

export function ShutdownButton() {
  const { data: readiness, refetch } = useShutdownReadiness();

  const stop = useMutation({
    mutationFn: () => api.shutdown(),
    onSuccess: () => {
      // Recorded before the socket dies: from here on, a stream that stops is
      // this, and the shell must say so rather than "Reconnecting…".
      markConsoleStopped({
        hint: readiness?.restartHint ?? 'start it again from a terminal',
        via: readiness?.stop.via ?? 'exit',
      });
      toast('Shutting down — this is the last thing this console will say.', 'ok');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (!readiness) return null;

  const stopping = stopList(readiness.sessions, readiness.run);

  return (
    <div className="flex flex-col items-start gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="danger"
            disabled={stop.isPending}
            // Read again on the way in: the inventory is only worth showing if
            // it is the inventory as of now, not as of when the page loaded.
            onClick={() => { void refetch(); }}
          >
            <Power size={14} aria-hidden /> {stop.isPending ? 'Shutting down…' : 'Shut down'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title="Shut the console down?"
          description={readiness.stop.detail}
          confirmLabel="Shut down"
          destructive
          onConfirm={() => stop.mutate()}
        >
          <StopInventory items={stopping} hint={readiness.restartHint} />
        </AlertDialogContent>
      </AlertDialog>
      <span className="text-2xs text-ink-faint">
        Stops this process and everything it owns — every session, and the run it is driving.
        {readiness.stop.via === 'launchctl' && ' The launchd job is unloaded, so it stays off.'}
      </span>
    </div>
  );
}
