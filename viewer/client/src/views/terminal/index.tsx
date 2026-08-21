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

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TerminalSquare, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { keys, useAutoReadNotifications, useConsoleState, useTerminals } from '@/lib/queries';
import { navigate, type Route } from '@/app/router';
import { Button, Chip, Empty, Spinner, toast } from '@/components/ui';
// Through `./pane`, deliberately — see the re-export note there: a second
// importable module in this shared chunk renames it and precaches xterm.
// SessionControls and the strip through the pane facade too, for the same
// reason (see the note in pane.tsx).
import {
  EndedBanner,
  SESSION_HINTS,
  SessionControls,
  SessionGone,
  SessionStrip,
  SessionVitals,
  TerminalPane,
} from './pane';

export default function TerminalView({ route }: { route: Route }) {
  const client = useQueryClient();
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const { data: state } = useConsoleState();
  const allowed = state?.allowTerminal === true;
  const { data: terminals, isPending, isFetching } = useTerminals(allowed);

  // One registry serves two pages: this one shows shells, `#/agent` shows
  // claude sessions. `?? 'shell'` keeps an older server's kind-less records
  // here. The cap check stays on the UNFILTERED total — 8 across both kinds.
  const all = terminals?.sessions ?? [];
  const sessions = all.filter((session) => (session.kind ?? 'shell') === 'shell');
  // Live processes only — the list now keeps ended records, and counting those
  // toward the cap would refuse a new shell because of eight that exited
  // yesterday. `live` is the server's own number; the filter is the fallback for
  // a server that predates it.
  const atCap =
    (terminals?.live ?? all.filter((session) => !session.exited).length) >= (terminals?.limit ?? 8);
  const wanted = route.segments[1];
  const open = sessions.find((session) => session.id === wanted);

  // `void`, never `await`: awaiting an invalidation resolves only when the
  // refetch settles, and awaiting one inside a render path is how P3 deadlocked
  // a whole test file.
  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.terminal() });
  };

  /**
   * A URL naming a session this console does not have used to bounce silently —
   * defensible when sessions timed out while a phone slept, and the wrong answer
   * now that they do not: a session ends when you close it or the console does,
   * so a URL that names nothing means the record was dismissed or retired, and
   * that is worth a sentence.
   *
   * ⚠️ `isFetching` is still load-bearing. Without it this renders against a
   * list that has been invalidated but not yet refetched and flashes "gone" over
   * the session that was just created.
   */
  const settled = allowed && !isPending && !isFetching;
  const gone = Boolean(settled && wanted && !open);

  // The same rule the agent page follows: opening the session a notification is
  // about is reading it.
  useAutoReadNotifications({ sessionId: wanted }, Boolean(wanted));

  async function openShell() {
    try {
      const ticket = await api.terminalTicket({});
      // Seeded from the response rather than waited for: the ticket carries the
      // session record, so the tab and the pane are correct on the very next
      // render instead of one network round trip later.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: typeof terminals) =>
          prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
        );
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

  /** Drop an ended record. A live session is closed, never dismissed. */
  async function dismiss(id: string) {
    try {
      const result = await api.sessionDismiss(id);
      if (!result.ok) {
        toast(String(result.reason ?? 'refused'), 'error');
        return;
      }
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
              A shell is a separate decision from the autopilot: it runs as you, with nothing between it and
              the machine. Restart the console with{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">--allow-terminal</code> to turn it
              on.
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
              <code className="rounded bg-surface-raised px-1 font-mono">node-pty</code> did not load, so this
              console cannot open a pty. Run{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">npm install</code> in the viewer
              directory and restart. Everything else on the console is unaffected.
            </>
          }
        />
      </Frame>
    );
  }

  if (isPending) {
    return (
      <Frame>
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      </Frame>
    );
  }

  /* ---------------- the page ---------------- */

  const capNote = atCap
    ? `The limit is ${terminals?.limit ?? 8} running sessions across shells and agents — ` +
      'close one first (ended ones do not count).'
    : undefined;

  return (
    <Frame>
      {/* The strip: tabs on a desktop, the open shell + a chevron on a phone
          (the sheet behind it lists every shell, and carries the controls). */}
      <SessionStrip
        kind="shell"
        sessions={sessions.map((session) => ({
          id: session.id,
          label: session.label,
          note: session.exited ? 'ended' : null,
        }))}
        activeId={open?.id}
        onSelect={(id) => navigate(`terminal/${id}`)}
        onClose={(id) => void closeShell(id)}
        note={capNote}
        actions={
          <Button
            size="sm"
            className="ml-1 min-h-(--tap-min) shrink-0"
            disabled={atCap}
            title={capNote ?? 'Open a new shell in the source directory'}
            onClick={() => void openShell()}
          >
            <Plus size={14} aria-hidden /> New
          </Button>
        }
        details={
          open && (
            <>
              {/* Freeze / Continue / Stop — the lane verbs, for THIS shell. */}
              <SessionControls session={open} />
              {/* Plan · phase · elapsed (· ETA when the session names a phase) —
                a shell attached to nothing still gets its clock. */}
              <SessionVitals session={open} />
              <Chip mono className="hidden shrink-0 md:inline-flex" title={open.cwd}>
                {(size ?? open).cols}×{(size ?? open).rows}
              </Chip>
            </>
          )
        }
        hints={SESSION_HINTS}
      />

      {gone ? (
        <SessionGone kind="shell" />
      ) : open ? (
        <>
          {open.exited && <EndedBanner session={open} atCap={atCap} onDismiss={(id) => void dismiss(id)} />}
          {/* Keyed by session: switching tabs must build a new xterm bound to
              the new pty, not reuse one and replay someone else's scrollback
              into it. */}
          <TerminalPane
            key={open.id}
            sessionId={open.id}
            onSession={refresh}
            onSize={setSize}
            onEnded={refresh}
          />
        </>
      ) : (
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="No shell open"
          body={
            state?.root?.path
              ? `A new shell starts in ${state.root.path}.`
              : 'A new shell starts in your home directory.'
          }
          action={
            <Button variant="action" onClick={() => void openShell()}>
              <Plus size={15} aria-hidden /> Open a shell
            </Button>
          }
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
