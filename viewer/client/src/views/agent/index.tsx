/**
 * The Agent page — interactive `claude` sessions in the browser terminal.
 *
 * Same bones as the Terminal page (explicit sessions, the id in the URL, the
 * isFetching-gated fallback, cache seeded from the ticket) with one deliberate
 * difference: `#/agent` with no id is a LAUNCHER, not an empty state — model,
 * effort, permission mode and the first prompt are choices that must exist
 * before the pty does, so the page collects them first. The server composes
 * and validates everything (`server/agent.ts`); this page never builds argv.
 *
 * The session list is shared with the shell page (one registry, one cap of 8
 * across both kinds) — each page shows only its own kind, and the New buttons
 * disable on the unfiltered total, or the cap would look like a bug on
 * whichever page had fewer tabs.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Sparkles, X } from 'lucide-react';
import { planHref } from '@shared/routes.js';
import { api, type TerminalTicket } from '@/lib/api';
import { usePhone } from '@/lib/media';
import { keys, useAutoReadNotifications, useConsoleState, usePlans, useTerminals } from '@/lib/queries';
import { estimateTerminalSize } from '@/lib/terminal';
import { navigate, type Route } from '@/router';
import { Button, Chip, Empty, Spinner, toast } from '@/components/ui';
// Through `pane`, deliberately — see the re-export note there: a second
// importable module in this shared chunk renames it and precaches xterm.
// SessionControls and the strip included: they are shared with the terminal
// route, so a direct import from BOTH views is exactly the second facade that
// renames the chunk.
import {
  EndedBanner,
  SESSION_HINTS,
  SessionControls,
  SessionGone,
  SessionStrip,
  SessionVitals,
  TerminalPane,
  sessionStateNote,
} from '../terminal/pane';
import { Launcher, type LaunchBody } from './launcher';
import { MODE_TITLE, modeName } from './modes';
import { NewPlanWizardButton } from './wizard';

export default function AgentView({ route }: { route: Route }) {
  const client = useQueryClient();
  const phone = usePhone();
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const { data: state } = useConsoleState();
  const allowed = state?.allowAgent === true;
  const { data: terminals, isPending, isFetching } = useTerminals(allowed);

  const all = terminals?.sessions ?? [];
  const sessions = all.filter((session) => session.kind === 'claude');
  // Live processes only: ended records stay listed (that is where the `--resume`
  // id lives) and must not hold a slot. See the same note on the terminal page.
  const atCap =
    (terminals?.live ?? all.filter((session) => !session.exited).length) >= (terminals?.limit ?? 8);
  const wanted = route.segments[1];
  const open = sessions.find((session) => session.id === wanted);

  // `void`, never `await` — the terminal page's rule, for the same deadlock.
  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.terminal() });
  };

  /**
   * A URL naming a session this console has never heard of no longer bounces —
   * it says so (`SessionGone` below). The bounce existed because an ended
   * session's record vanished within a minute, so the URL in your history was
   * usually dead; records now survive until dismissed, and the case that is
   * left deserves a sentence rather than a redirect.
   *
   * `isFetching` was load-bearing for that effect and stays load-bearing here:
   * the "gone" panel must not render against a list that is invalidated but not
   * yet refetched, or creating a session flashes it.
   */
  const settled = allowed && !isPending && !isFetching;
  const gone = Boolean(settled && wanted && !open);

  // Opening the session a `session` notification is about counts as reading it.
  // The record carries the id (`server/notifications.ts`), so the count drops
  // by exactly the endings of this session.
  useAutoReadNotifications({ sessionId: wanted }, Boolean(wanted));

  async function launch(body: LaunchBody) {
    try {
      // The size the pane will settle on, so the CLI is not born at 80×24
      // and laid out for a window it is not in; the pane corrects it on open.
      const ticket = await api.agentTicket({ ...body, ...estimateTerminalSize(phone) });
      seed(ticket);
      refresh();
      navigate(`agent/${ticket.sessionId}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  function seed(ticket: TerminalTicket) {
    // Seeded from the response rather than waited for, so the tab and the
    // pane are right on the very next render — the ticket carries the record.
    if (!ticket.session) return;
    client.setQueryData(keys.terminal(), (prev: typeof terminals) =>
      prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
    );
  }

  async function close(id: string) {
    try {
      const result = await api.terminalClose(id);
      if (result.state) client.setQueryData(keys.terminal(), result.state);
      const rest = sessions.filter((session) => session.id !== id);
      navigate(rest.length ? `agent/${rest[0].id}` : 'agent');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  /** Drop an ended record. The live ones are closed, never dismissed. */
  async function dismiss(id: string) {
    try {
      const result = await api.sessionDismiss(id);
      if (!result.ok) {
        toast(String(result.reason ?? 'refused'), 'error');
        return;
      }
      if (result.state) client.setQueryData(keys.terminal(), result.state);
      const rest = sessions.filter((session) => session.id !== id);
      navigate(rest.length ? `agent/${rest[0].id}` : 'agent');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  /* ---------------- the two ways there is no agent ---------------- */

  if (!allowed) {
    return (
      <Frame>
        <Empty
          icon={<Bot size={28} className="text-ink-faint" aria-hidden />}
          title="Agent sessions are off"
          body={
            <>
              An agent session is an interactive Claude Code CLI in a terminal on this machine — it acts only
              with your approval, in the terminal itself, but starting one is still its own decision. Restart
              the console with <code className="rounded bg-surface-raised px-1 font-mono">--allow-agent</code>{' '}
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
          icon={<Bot size={28} className="text-ink-faint" aria-hidden />}
          title="No terminal available"
          body={
            <>
              <code className="rounded bg-surface-raised px-1 font-mono">node-pty</code> did not load, so this
              console cannot open a pty for the session to run in. Run{' '}
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
      {/* The strip: tabs on a desktop, the open session + a chevron on a phone
          (the sheet behind it lists every session and carries the controls,
          the launch record and the wizard). */}
      <SessionStrip
        kind="claude"
        sessions={sessions.map((session) => ({
          id: session.id,
          label: session.label,
          note: sessionStateNote(session),
        }))}
        activeId={open?.id}
        onSelect={(id) => navigate(`agent/${id}`)}
        onClose={(id) => void close(id)}
        note={capNote}
        actions={
          <Button
            size="sm"
            className="ml-1 min-h-(--tap-min) shrink-0"
            disabled={atCap}
            title={capNote ?? 'Configure and start a new Claude session'}
            onClick={() => navigate('agent')}
          >
            <Plus size={14} aria-hidden /> New
          </Button>
        }
        more={
          <span className="shrink-0">
            <NewPlanWizardButton allowAgent={allowed} />
          </span>
        }
        details={
          open && (
            <>
              {/* Freeze / Continue / Stop — the lane verbs, for THIS session. */}
              <SessionControls session={open} />
              {/* Plan · phase · elapsed · ETA — the four facts that say what this
                session IS, before the mode chip says how it was launched. */}
              <SessionVitals session={open} />
              {/* What the process was STARTED under. ⇧Tab changes the mode inside
                the session and tells nothing out here, so the chip is a record
                of the launch and the title says exactly that — a label that
                silently went stale would be worse than no label. */}
              <Chip mono title={MODE_TITLE}>
                launched in {modeName(open.meta?.permissionMode)}
              </Chip>
              {/* The shortcut itself, where someone reading the chip is already
                looking. Desktop only: a phone has no ⇧Tab to press, and the
                keybar under the terminal already offers the button. */}
              <span className="hidden items-center gap-1.5 text-2xs text-ink-faint md:flex">
                <kbd className="rounded border border-rule bg-surface-raised px-1 py-0.5 font-mono text-2xs">
                  ⇧Tab
                </kbd>
                cycles permission modes
              </span>
              <Chip mono className="hidden md:inline-flex" title={open.cwd}>
                {(size ?? open).cols}×{(size ?? open).rows}
              </Chip>
            </>
          )
        }
        hints={[...SESSION_HINTS, MODE_TITLE]}
      />

      {gone ? (
        <SessionGone kind="claude" />
      ) : open ? (
        <>
          {open.meta?.intent === 'plan' && <PlanWatcher key={open.id} />}
          {open.exited && (
            <EndedBanner
              session={open}
              atCap={atCap}
              onResume={(resume) => void launch({ resume })}
              onDismiss={(id) => void dismiss(id)}
            />
          )}
          {/* Keyed by session — a tab switch builds a fresh xterm, never replays
              another session's scrollback into a reused one. */}
          <TerminalPane
            key={open.id}
            sessionId={open.id}
            onSession={refresh}
            onSize={setSize}
            onEnded={refresh}
            composer
          />
        </>
      ) : (
        <Launcher
          root={state?.root?.path}
          disabled={atCap}
          skillsEnabled={Boolean(state?.root?.path)}
          onLaunch={launch}
        />
      )}
    </Frame>
  );
}

/** Same frame as the terminal: the pane scrolls itself, the page never does. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}

/**
 * Watches the plans list while a plan-authoring session runs, and says so the
 * moment a NEW slug appears.
 *
 * The mechanism is the console's ordinary plumbing: `new-plan.sh` writes the
 * file → the docs watcher emits `changed` → `EVENT_EFFECTS` invalidates
 * `keys.plans()` → this refetch diffs against the baseline taken on mount.
 * Keyed by session id, so each authoring session gets its own baseline.
 *
 * Known limit, accepted: the baseline is per-mount — open the page for the
 * first time AFTER the plan was written and there is no banner, because the
 * plan is already on the Plans page by then.
 */
function PlanWatcher() {
  const { data: plans } = usePlans(true);
  const baseline = useRef<Set<string> | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!plans) return;
    const seen = baseline.current;
    if (!seen) {
      baseline.current = new Set(plans.map((plan) => plan.slug));
      return;
    }
    const fresh = plans.find((plan) => !seen.has(plan.slug));
    if (fresh) setCreated((current) => current ?? fresh.slug);
  }, [plans]);

  if (!created || dismissed) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface px-3 py-2 text-sm">
      <Sparkles size={14} className="shrink-0 text-action" aria-hidden />
      <span>
        Plan <code className="rounded bg-surface-raised px-1 font-mono">{created}</code> was created —{' '}
        <a className="text-action underline underline-offset-2" href={planHref(created)}>
          open it
        </a>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="ml-auto flex size-(--tap-min) shrink-0 items-center justify-center text-ink-faint hover:text-ink"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
