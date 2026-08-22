/**
 * The one sessions list — every process this console owns or can see.
 *
 * ## Four kinds, one list
 *
 * Until 3.0 there were two pages (`#/terminal`, `#/agent`), each showing the
 * half of the pty registry that was its own kind, and two OTHER surfaces that
 * knew about processes neither page did: the run page's lane strip, and the
 * session-presence registry's report of every `claude` alive on this machine.
 * Four lists, no page that answered "what is running right now".
 *
 * `sessionRows` folds all four into one vocabulary:
 *
 *   - **lane** — an autopilot lane of a live run. The console owns the process
 *     but not through the pty registry, so the row links to the run page,
 *     where its approvals, ask box and replay live.
 *   - **agent** / **shell** — a pty this console minted. `#/sessions/<id>` is
 *     its address, and the pane on that page is the terminal.
 *   - **foreign** — a `claude` the session-presence hook reported: someone's
 *     own CLI, another console's lane. Nothing here can drive it; the row says
 *     it exists, which is the whole point (it is what a scope conflict is).
 *
 * The derivation is pure and exported so the fold is testable without a pty,
 * and it reuses `features/now`'s lane + foreign models rather than minting a
 * second vocabulary for the same facts — the `groupOf` rule from Phase 9.
 *
 * ## The strip is this list, collapsed
 *
 * `SessionStrip` is the same list rendered as one row above a pane: tabs on a
 * desktop (Radix owns the roving focus; `ui/tabs.tsx` adds the scroll-into-view
 * and the trailing fade a hidden-scrollbar strip needs), and on a phone **the
 * open session and a chevron** — the strip used to be 489 px of tabs at 390 px
 * with "New plan with AI" off the screen and nothing saying so. The chevron
 * opens a bottom sheet with every session, the open one's controls and facts,
 * and the actions that did not fit the row; the sheet is also where a phone
 * gets the explanations a desktop reads as hover titles (`hints`), since a
 * `title=` alone is unreachable by a finger.
 */

import { useState, type ReactNode } from 'react';
import { Bot, ChevronDown, Cpu, TerminalSquare, Users, X } from 'lucide-react';
import { planHref } from '@shared/routes.js';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { relativeTime } from '@/lib/format';
import { Sheet, SheetContent, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { foreignVehicle, otherSessions, type NowLane } from '@/features/now/model';
import type { ForeignSession, TerminalSession } from '@/lib/api';
import { sessionsHref } from '@/app/routes';
import { sessionStateNote } from './session-controls';

/**
 * What the session controls and vitals mean — the sentences a desktop reads
 * as hover titles, said in the sheet on a phone.
 */
export const SESSION_HINTS: readonly string[] = [
  'Freeze stops the session’s processes where they stand (SIGSTOP), losing nothing; Continue resumes them mid-token.',
  'Stop sends SIGTERM and force-ends only after a 15-second grace it ignored; the record — and a session’s resume id — stay in the list.',
  'The clock is how long the session has run; an estimate beside it is the phase’s own, and past it the honest word is “over”.',
];

/* ---------------- the fold (pure, exported for tests) ---------------- */

export type SessionKind = 'lane' | 'agent' | 'shell' | 'foreign';

/** The four kinds in list order, with the heading each group carries. */
export const SESSION_GROUPS: readonly { kind: SessionKind; title: string; blurb: string }[] = [
  {
    kind: 'lane',
    title: 'Autopilot lanes',
    blurb: 'Phases this console is running. The console, approvals and replay are on the run page.',
  },
  { kind: 'agent', title: 'Agent sessions', blurb: 'Interactive Claude sessions this console started.' },
  { kind: 'shell', title: 'Shells', blurb: 'Plain shells on this machine, from here or from a phone.' },
  {
    kind: 'foreign',
    title: 'Other sessions on this machine',
    blurb:
      'Reported by the session-presence hook — someone’s own CLI, or another console’s lane. Read-only here.',
  },
];

export interface SessionRow {
  /** Stable across re-sorts, which is what keys React. */
  key: string;
  kind: SessionKind;
  label: string;
  /** The one-line "what it is" under the label. */
  detail?: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping…`. */
  note?: string | null;
  /** Where the row goes. */
  href: string;
  /** The pty id, when THIS console owns the process — what `#/sessions/:id` opens. */
  id?: string;
  live: boolean;
  /** For the "started N ago" line. Epoch ms. */
  startedAt?: number;
}

const KIND_ORDER: Record<SessionKind, number> = { lane: 0, agent: 1, shell: 2, foreign: 3 };

/** The lucide glyph for a kind — one table, so the list and the strip agree. */
export const KIND_ICON = { lane: Cpu, agent: Bot, shell: TerminalSquare, foreign: Users } as const;

/**
 * Every process, in one list: live first, then by kind, then most recent.
 *
 * `lanes` and `foreign` come straight from `features/now`'s models — the same
 * `nowLanes()` the home page ranks and the same `otherSessions()` it uses to
 * drop a registry row that duplicates a lane we already drew. Console-owned
 * ptys are ordered live-before-ended within their kind so eight dismissable
 * records never bury the shell you are typing in.
 */
export function sessionRows(input: {
  terminals?: readonly TerminalSession[] | undefined;
  lanes?: readonly NowLane[] | undefined;
  foreign?: readonly ForeignSession[] | undefined;
  now?: number;
}): SessionRow[] {
  const now = input.now ?? Date.now();
  const rows: SessionRow[] = [];

  for (const lane of input.lanes ?? []) {
    rows.push({
      key: `lane:${lane.key}`,
      kind: 'lane',
      label: `${lane.planTitle} · P${lane.phase}`,
      ...(lane.title ? { detail: lane.title } : {}),
      note: lane.frozen ? 'frozen' : lane.status === 'running' ? null : lane.status,
      href: planHref(lane.slug, 'run'),
      live: lane.status === 'running',
      ...(lane.startedAt ? { startedAt: Date.parse(lane.startedAt) } : {}),
    });
  }

  for (const session of input.terminals ?? []) {
    rows.push({
      key: `pty:${session.id}`,
      kind: (session.kind ?? 'shell') === 'claude' ? 'agent' : 'shell',
      label: session.label,
      detail: session.cwd,
      note: sessionStateNote(session),
      href: sessionsHref(session.id),
      id: session.id,
      live: !session.exited,
      startedAt: session.exitedAt ?? session.lastOutputAt ?? session.createdAt,
    });
  }

  // `otherSessions` drops a registry row that is a lane we have already drawn
  // (same session id) and keeps an hour of recently-ended ones.
  for (const session of otherSessions(input.foreign, input.lanes ?? [], now)) {
    rows.push({
      key: `foreign:${session.sessionId}`,
      kind: 'foreign',
      // The plan it works, else who owns it, else WHAT it is. The bare `kind`
      // was the first draft and the live page showed four rows saying
      // "foreign" — true, and no help at all.
      label: session.plan
        ? `${session.plan.slug} · P${session.plan.phase}`
        : (session.owner ?? foreignVehicle(session)),
      detail: session.cwd,
      note: session.presence === 'live' ? null : session.presence,
      href: session.plan ? planHref(session.plan.slug, 'run') : sessionsHref(),
      live: session.presence === 'live',
      startedAt: Date.parse(session.lastSeen),
    });
  }

  return rows.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

/* ---------------- the page list ---------------- */

/**
 * The list as a PAGE section: grouped by kind, every row a link.
 *
 * A group with no rows renders nothing rather than an empty heading — four
 * headings over one shell is a page that looks broken on the console most
 * people run.
 */
export function SessionList({
  rows,
  activeId,
  onClose,
  empty,
}: {
  rows: readonly SessionRow[];
  /** The open pty, so the page list marks it while a pane is up beside it. */
  activeId?: string | undefined;
  /** Closing is offered only for a pty this console owns. */
  onClose?: (id: string) => void;
  /** What to say when there is nothing at all. */
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="flex flex-col gap-4">
      {SESSION_GROUPS.map((group) => {
        const mine = rows.filter((row) => row.kind === group.kind);
        if (mine.length === 0) return null;
        return (
          <section key={group.kind} aria-label={group.title}>
            <h3 className="text-sm font-medium text-ink">{group.title}</h3>
            <p className="mt-0.5 text-2xs text-ink-faint">{group.blurb}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {mine.map((row) => (
                <SessionListRow
                  key={row.key}
                  row={row}
                  active={Boolean(row.id && row.id === activeId)}
                  {...(onClose ? { onClose } : {})}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SessionListRow({
  row,
  active,
  onClose,
}: {
  row: SessionRow;
  active: boolean;
  onClose?: (id: string) => void;
}) {
  const Icon = KIND_ICON[row.kind];
  return (
    <li className="flex items-center gap-1">
      <a
        href={row.href}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-2 rounded border px-2 py-1 text-sm',
          active ? 'border-rule-strong bg-surface-raised' : 'border-rule bg-surface hover:bg-surface-raised',
        )}
      >
        <Icon size={15} className="shrink-0 text-ink-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-ink">{row.label}</span>
            {!row.live && <span className="shrink-0 text-2xs text-ink-faint">{row.note ?? 'ended'}</span>}
            {row.live && row.note && <span className="shrink-0 text-2xs text-warn">{row.note}</span>}
          </span>
          {/* A recorded path has no space in it for eighty characters, and a
              track sized to one scrolls the whole phone page sideways (Phase 9).
              `break-words` inside a `min-w-0` parent is the fix. */}
          {row.detail && (
            <span className="mt-0.5 block truncate font-mono text-2xs break-words text-ink-faint">
              {row.detail}
            </span>
          )}
        </span>
        {row.startedAt != null && Number.isFinite(row.startedAt) && (
          <span className="shrink-0 text-2xs text-ink-faint">{relativeTime(row.startedAt)}</span>
        )}
      </a>
      {onClose && row.id && (
        <button
          type="button"
          aria-label={`Close ${row.label}`}
          onClick={() => onClose(row.id!)}
          className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </li>
  );
}

/* ---------------- the strip (the same list, above a pane) ---------------- */

export interface StripSession {
  id: string;
  label: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping…`. */
  note?: string | null;
}

export function SessionStrip({
  sessions,
  activeId,
  onSelect,
  onClose,
  actions,
  details,
  hints,
  more,
  note,
  extra,
}: {
  sessions: readonly StripSession[];
  activeId?: string;
  onSelect(id: string): void;
  onClose(id: string): void;
  /** Creates sessions — after the tabs (desktop) or the picker (phone). */
  actions?: ReactNode;
  /** Controls and facts for the OPEN session: the right side, or the sheet. */
  details?: ReactNode;
  /** Plain sentences explaining `details` — the tap path for desktop titles. */
  hints?: readonly string[];
  /** Actions that only fit the sheet on a phone (the plan wizard). */
  more?: ReactNode;
  /** Why creating is refused right now (the cap) — said in the sheet. */
  note?: string;
  /** Everything this console does NOT own a pty for — lanes and foreign rows. */
  extra?: ReactNode;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const active = sessions.find((session) => session.id === activeId);

  if (!phone) {
    return (
      // 🔴 `flex-wrap`, and `details` without `shrink-0`, are load-bearing.
      // The strip is tabs + actions + the open session's facts, and the facts
      // are a variable-length row (controls, plan · phase, elapsed, an ETA, the
      // launch mode, ⇧Tab, the size). Phase 10 put a second New button on it
      // and the whole row went 122 px past the viewport on a 1440 desktop —
      // which, because `ml-auto` resolves before an overflow, pushed the TAB
      // LIST to x = −25: the one control the strip exists for, off the left
      // edge, with no scrollbar to bring it back. Wrapping costs a row of
      // height on a narrow window and loses nothing.
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-rule bg-ground-deep px-2 py-1.5">
        <Tabs
          value={active?.id ?? ''}
          onValueChange={(value) => {
            if (value) onSelect(value);
          }}
          className="min-w-0"
        >
          <TabsList aria-label="Open sessions" className="border-b-0">
            {sessions.map((session) => {
              const isActive = session.id === active?.id;
              return (
                <span
                  key={session.id}
                  className={cn(
                    'flex shrink-0 items-center rounded border',
                    isActive ? 'border-rule-strong bg-surface-raised' : 'border-rule bg-surface',
                  )}
                >
                  <TabsTrigger
                    value={session.id}
                    className={cn(
                      'min-h-(--tap-min) max-w-56 truncate border-b-0 px-3 py-0 text-sm',
                      'data-[state=active]:border-b-0',
                    )}
                  >
                    {session.label}
                    {session.note && <span className="ml-1.5 text-2xs text-ink-faint">{session.note}</span>}
                  </TabsTrigger>
                  <button
                    type="button"
                    aria-label={`Close ${session.label}`}
                    onClick={() => onClose(session.id)}
                    className="flex size-(--tap-min) items-center justify-center text-ink-faint hover:text-ink"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
              );
            })}
          </TabsList>
        </Tabs>
        {actions}
        {more}
        {active && details && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{details}</div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule bg-ground-deep px-2 py-1.5">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={active ? `${active.label} — open the session list` : 'Open the session list'}
          onClick={() => setOpen(true)}
          className="flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-1.5 rounded border border-rule bg-surface px-2 text-left text-sm"
        >
          <span className="truncate text-ink">{active ? active.label : 'No session open'}</span>
          {active?.note && <span className="shrink-0 text-2xs text-ink-faint">{active.note}</span>}
          {sessions.length > 1 && (
            <span className="shrink-0 rounded bg-surface-raised px-1.5 font-mono text-2xs text-ink-faint">
              {sessions.length}
            </span>
          )}
          <ChevronDown size={16} className="ml-auto shrink-0 text-ink-muted" aria-hidden />
        </button>
        {actions}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title="Sessions">
          {sessions.length === 0 ? (
            <p className="px-1 py-2 text-sm text-ink-muted">No session is open.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Open sessions">
              {sessions.map((session) => {
                const isActive = session.id === active?.id;
                return (
                  <li key={session.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => {
                        onSelect(session.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-sm',
                        isActive ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface',
                      )}
                    >
                      <span className="truncate">{session.label}</span>
                      {session.note && (
                        <span className="shrink-0 text-2xs text-ink-faint">{session.note}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${session.label}`}
                      onClick={() => onClose(session.id)}
                      className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {note && <p className="mt-2 px-1 text-2xs text-ink-faint">{note}</p>}

          {active && details && (
            <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-3">
              <div className="flex flex-wrap items-center gap-2">{details}</div>
              {hints && hints.length > 0 && (
                <ul className="flex flex-col gap-1 px-1 text-2xs text-ink-faint">
                  {hints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {extra && <div className="mt-3 border-t border-rule pt-3">{extra}</div>}
          {more && <div className="mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">{more}</div>}
        </SheetContent>
      </Sheet>
    </>
  );
}
