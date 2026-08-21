/**
 * The session strip shared by the Terminal and Agent pages.
 *
 * On a desktop it is a `Tabs` list (Radix owns the roving focus and the
 * arrow keys; `ui/tabs.tsx` adds the scroll-into-view and the trailing fade
 * a hidden-scrollbar strip needs), each tab paired with its ✕, then the
 * actions that create sessions, then — pushed to the right — the controls and
 * facts of the open session.
 *
 * On a phone it **collapses to the open session and a chevron**: the strip
 * used to be 489 px of tabs at 390 px, with "New plan with AI" off the screen
 * and nothing saying so. The chevron opens a bottom sheet listing every
 * session (switch, close), the open session's controls and facts, and the
 * actions that did not fit the row — and the sheet is where a phone gets the
 * explanations a desktop reads as hover titles (`hints`), since a `title=`
 * alone is unreachable by a finger.
 *
 * ⚠️ Imported by both pages THROUGH `./pane`, never directly — the single-
 * facade rule that keeps the shared lazy chunk named `pane-*` (see pane.tsx).
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { Sheet, SheetContent, Tabs, TabsList, TabsTrigger } from '@/components/ui';

/**
 * What the session controls and vitals mean — the sentences a desktop reads
 * as hover titles, said in the sheet on a phone.
 */
export const SESSION_HINTS: readonly string[] = [
  'Freeze stops the session’s processes where they stand (SIGSTOP), losing nothing; Continue resumes them mid-token.',
  'Stop sends SIGTERM and force-ends only after a 15-second grace it ignored; the record — and a session’s resume id — stay in the list.',
  'The clock is how long the session has run; an estimate beside it is the phase’s own, and past it the honest word is “over”.',
];

export interface StripSession {
  id: string;
  label: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping…`. */
  note?: string | null;
}

export function SessionStrip({
  kind,
  sessions,
  activeId,
  onSelect,
  onClose,
  actions,
  details,
  hints,
  more,
  note,
}: {
  kind: 'shell' | 'claude';
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
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const active = sessions.find((session) => session.id === activeId);
  const word = kind === 'claude' ? 'session' : 'shell';

  if (!phone) {
    return (
      <div className="flex shrink-0 items-center gap-1 border-b border-rule bg-ground-deep px-2 py-1.5">
        <Tabs
          value={active?.id ?? ''}
          onValueChange={(value) => {
            if (value) onSelect(value);
          }}
          className="min-w-0"
        >
          <TabsList aria-label={`Open ${word}s`} className="border-b-0">
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
        {active && details && <div className="ml-auto flex shrink-0 items-center gap-2">{details}</div>}
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
          aria-label={active ? `${active.label} — open the session list` : `Open the ${word} list`}
          onClick={() => setOpen(true)}
          className="flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-1.5 rounded border border-rule bg-surface px-2 text-left text-sm"
        >
          <span className="truncate text-ink">{active ? active.label : `No ${word} open`}</span>
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
        <SheetContent title={kind === 'claude' ? 'Sessions' : 'Shells'}>
          {sessions.length === 0 ? (
            <p className="px-1 py-2 text-sm text-ink-muted">No {word} is open.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label={`Open ${word}s`}>
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

          {more && <div className="mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">{more}</div>}
        </SheetContent>
      </Sheet>
    </>
  );
}
