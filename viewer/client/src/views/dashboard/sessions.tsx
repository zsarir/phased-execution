/**
 * Everything this console is running, in one place.
 *
 * Sessions were only ever discoverable from their own pages' tab strips, each
 * filtered to a single kind — so a shell opened on a phone was invisible from
 * the laptop, an agent session left running overnight was invisible from
 * everywhere, and the only way to find out what was alive was to visit two pages
 * and count tabs. Making sessions durable (they now stop only when you kill them
 * or the console goes down) makes that gap worse, not better: the longer a thing
 * survives, the more it matters that something lists it.
 *
 * So: one card, both kinds, live and ended, on the page that answers "now".
 *
 * The ended ones are here on purpose. An agent session's `claude --resume <id>`
 * is the most valuable thing it leaves behind and it used to vanish with the
 * record; keeping the row until it is dismissed is what makes "the CLI exited"
 * recoverable rather than final.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, TerminalSquare, X } from 'lucide-react';
import { api, type ConsoleState, type TerminalSession } from '@/lib/api';
import { keys, useSessions } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { navigate } from '@/router';
import {
  AlertDialog, AlertDialogContent, AlertDialogTrigger, Button, Card, CardBody, CardHeader,
  CardTitle, Chip, toast,
} from '@/components/ui';

export function SessionsCard({ state }: { state: ConsoleState | undefined }) {
  const client = useQueryClient();
  const { data } = useSessions(state);
  const [busy, setBusy] = useState<string | null>(null);

  const sessions = data?.sessions ?? [];
  // Nothing to say, and nothing to explain — a permanently empty card on every
  // console that never turns the terminal on is noise on the busiest page.
  if (!sessions.length) return null;

  const live = sessions.filter((session) => !session.exited);
  const ended = sessions.filter((session) => session.exited);

  async function act(id: string, what: 'close' | 'dismiss') {
    setBusy(id);
    try {
      const result = what === 'close' ? await api.terminalClose(id) : await api.sessionDismiss(id);
      if ('ok' in result && result.ok === false) { toast(String(result.reason ?? 'refused'), 'error'); return; }
      // The DELETE answers with the list as it now is — authoritative, so there
      // is nothing to race against the `sessions` event that follows it.
      if (result.state) client.setQueryData(keys.terminal(), result.state);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitle>Sessions</CardTitle>
        <span className="text-2xs text-ink-faint">
          {live.length
            ? `${live.length} running of ${data?.limit ?? 8}`
            : 'none running'}
          {ended.length ? ` · ${ended.length} ended` : ''}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-1.5">
        {[...live, ...ended].map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            busy={busy === session.id}
            onAct={act}
          />
        ))}
        <p className="mt-1 text-2xs text-ink-faint">
          A session keeps running when you close the tab — it stops only here, on its own page, or
          when the console shuts down.
        </p>
      </CardBody>
    </Card>
  );
}

function SessionRow({
  session,
  busy,
  onAct,
}: {
  session: TerminalSession;
  busy: boolean;
  onAct: (id: string, what: 'close' | 'dismiss') => void;
}) {
  const agent = session.kind === 'claude';
  const page = agent ? 'agent' : 'terminal';
  const dead = Boolean(session.exited);
  const failed = dead && (session.exited?.code !== 0 || session.exited?.signal != null);

  return (
    <div className="flex items-center gap-2 rounded border border-rule bg-surface px-2 py-1.5">
      {agent
        ? <Bot size={14} className="shrink-0 text-ink-faint" aria-hidden />
        : <TerminalSquare size={14} className="shrink-0 text-ink-faint" aria-hidden />}

      <button
        type="button"
        onClick={() => navigate(`${page}/${session.id}`)}
        className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-action"
      >
        {session.label}
        <span className="ml-2 text-2xs text-ink-faint">
          {dead
            ? `ended ${relativeTime(session.exitedAt)}`
            : session.clients
              ? `${session.clients} attached`
              : 'running, detached'}
        </span>
      </button>

      {failed && (
        <Chip tone="bad">
          {session.exited?.signal ? `signal ${session.exited.signal}` : `exit ${session.exited?.code}`}
        </Chip>
      )}
      {!dead && session.meta?.recovery && <Chip>recovery</Chip>}

      {dead ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onAct(session.id, 'dismiss')}
        >
          Dismiss
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Close ${session.label}`}>
              <X size={14} aria-hidden />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            title={`Close ${session.label}?`}
            description={agent
              ? 'The Claude CLI is killed. Its conversation stays resumable — the ended row keeps the resume command until you dismiss it.'
              : 'The shell is killed. Anything running in it goes with it.'}
            confirmLabel="Close"
            destructive
            onConfirm={() => onAct(session.id, 'close')}
          />
        </AlertDialog>
      )}
    </div>
  );
}
