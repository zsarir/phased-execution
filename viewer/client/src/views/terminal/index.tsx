/**
 * The Terminal page.
 *
 * ## What this is not
 *
 * It is **not** the run console. `views/run/console.tsx` is a read-only,
 * folding view of what an agent session printed; it has no input and is not
 * supposed to gain one. This is the opposite object — an unsupervised shell
 * with no policy in front of it — and merging them would mean either giving the
 * run log a prompt or putting the shell behind the approval queue. Both are
 * wrong. They look similar because a terminal looks like a terminal.
 *
 * ## Why sessions are explicit
 *
 * Opening a shell is not a page-load side effect. The page attaches to the
 * newest session if one exists and otherwise offers a button — which is also
 * what makes it safe under StrictMode, where a mount that spawned a pty would
 * spawn two.
 *
 * The open session is in the URL (`#/terminal/<id>`), so a reload, a phone
 * locking its screen, or a tab killed by iOS all come back to the same shell.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TerminalSquare, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { keys, useConsoleState, useTerminals } from '@/lib/queries';
import { cn } from '@/lib/cn';
import { navigate, type Route } from '@/router';
import { Button, Chip, Empty, Spinner, toast } from '@/components/ui';
import { TerminalPane } from './pane';

export default function TerminalView({ route }: { route: Route }) {
  const client = useQueryClient();
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const { data: state } = useConsoleState();
  const allowed = state?.allowTerminal === true;
  const { data: terminals, isPending, isFetching } = useTerminals(allowed);

  const sessions = terminals?.sessions ?? [];
  const wanted = route.segments[1];
  const open = sessions.find((session) => session.id === wanted);

  // `void`, never `await`: awaiting an invalidation resolves only when the
  // refetch settles, and awaiting one inside a render path is how P3 deadlocked
  // a whole test file.
  const refresh = () => { void client.invalidateQueries({ queryKey: keys.terminal() }); };

  /**
   * A URL naming a session that has ended is not an error to shout about — the
   * session simply timed out while the phone was asleep. Fall back to whatever
   * is still open, or to the empty state.
   *
   * ⚠️ `isFetching` is load-bearing. Without it this fires against a list that
   * has been invalidated but not yet refetched, decides the session it is
   * looking at does not exist, and navigates off the page that was just opened
   * — a bounce whose only symptom is that nothing happens.
   */
  useEffect(() => {
    if (!allowed || isPending || isFetching) return;
    if (wanted && !open) navigate(sessions.length ? `terminal/${sessions[0].id}` : 'terminal');
  }, [allowed, isPending, isFetching, wanted, open, sessions]);

  async function openShell() {
    try {
      const ticket = await api.terminalTicket({});
      // Seeded from the response rather than waited for: the ticket carries the
      // session record, so the tab and the pane are correct on the very next
      // render instead of one network round trip later.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: typeof terminals) => (prev
          ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] }
          : prev));
      }
      refresh();
      navigate(`terminal/${ticket.sessionId}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function closeShell(id: string) {
    try {
      const result = await api.terminalClose(id);
      // The DELETE answers with the list as it now is — authoritative, so there
      // is nothing to race here either.
      if (result.state) client.setQueryData(keys.terminal(), result.state);
      const rest = sessions.filter((session) => session.id !== id);
      navigate(rest.length ? `terminal/${rest[0].id}` : 'terminal');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  /* ---------------- the two ways there is no terminal ---------------- */

  if (!allowed) {
    return (
      <Frame>
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="The terminal is off"
          body={
            <>
              A shell is a separate decision from the autopilot: it runs as you, with nothing
              between it and the machine. Restart the console with{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">--allow-terminal</code>{' '}
              to turn it on.
            </>
          }
        />
      </Frame>
    );
  }

  if (terminals?.available === 'no') {
    return (
      <Frame>
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="No shell available"
          body={
            <>
              <code className="rounded bg-surface-raised px-1 font-mono">node-pty</code> did not
              load, so this console cannot open a pty. Run{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">npm install</code> in the
              viewer directory and restart. Everything else on the console is unaffected.
            </>
          }
        />
      </Frame>
    );
  }

  if (isPending) {
    return <Frame><div className="grid flex-1 place-items-center"><Spinner /></div></Frame>;
  }

  /* ---------------- the page ---------------- */

  return (
    <Frame>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-rule bg-ground-deep px-2 py-1.5">
        {sessions.map((session) => {
          const active = session.id === open?.id;
          return (
            <span
              key={session.id}
              className={cn(
                'flex shrink-0 items-center rounded border',
                active ? 'border-rule-strong bg-surface-raised' : 'border-rule bg-surface',
              )}
            >
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(`terminal/${session.id}`)}
                className={cn(
                  'min-h-(--tap-min) px-3 text-sm',
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {session.label}
                {session.exited && <span className="ml-1.5 text-2xs text-ink-faint">ended</span>}
              </button>
              <button
                type="button"
                aria-label={`Close ${session.label}`}
                onClick={() => void closeShell(session.id)}
                className="flex size-(--tap-min) items-center justify-center text-ink-faint hover:text-ink"
              >
                <X size={14} aria-hidden />
              </button>
            </span>
          );
        })}

        <Button
          size="sm"
          className="ml-1 min-h-(--tap-min) shrink-0"
          disabled={sessions.length >= (terminals?.limit ?? 8)}
          title={sessions.length >= (terminals?.limit ?? 8)
            ? `The limit is ${terminals?.limit} sessions — close one first`
            : 'Open a new shell in the source directory'}
          onClick={() => void openShell()}
        >
          <Plus size={14} aria-hidden /> New
        </Button>

        {open && (
          <Chip mono className="ml-auto hidden shrink-0 md:inline-flex" title={open.cwd}>
            {(size ?? open).cols}×{(size ?? open).rows}
          </Chip>
        )}
      </div>

      {open ? (
        // Keyed by session: switching tabs must build a new xterm bound to the
        // new pty, not reuse one and replay someone else's scrollback into it.
        <TerminalPane
          key={open.id}
          sessionId={open.id}
          onSession={refresh}
          onSize={setSize}
          onEnded={refresh}
        />
      ) : (
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="No shell open"
          body={
            state?.root?.path
              ? `A new shell starts in ${state.root.path}.`
              : 'A new shell starts in your home directory.'
          }
          action={<Button variant="action" onClick={() => void openShell()}><Plus size={15} aria-hidden /> Open a shell</Button>}
        />
      )}
    </Frame>
  );
}

/**
 * The terminal fills its region rather than flowing in the page: xterm scrolls
 * itself, and a page that also scrolled would give a phone two scrollbars and
 * no way to reach the prompt.
 */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}
