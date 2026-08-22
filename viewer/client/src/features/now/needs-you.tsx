/**
 * **Needs you** — the first thing on the home page, and the only place on it
 * that may be amber.
 *
 * ## What earns a row
 *
 * Not this file's decision. `GET /api/inbox` is one deduped list built by one
 * pure function from facts the server already had — the ladder's errands, the
 * permission cards, the gates, the sign-ins, the MCP walls, the QA verdicts,
 * the lock debris, the stalls, the rulings and the console's own health. Eight
 * surfaces used to answer "is anything waiting on me?" and none of them could
 * be counted, because nothing could say whether a halted-run card, the errand
 * under it and the push that announced it were three asks or one.
 *
 * So the section renders what it is sent, in the order it is sent, and the one
 * thing it adds is the ability to answer without leaving the page.
 *
 * ## Triage without a mouse
 *
 * `j`/`k` move, `1`/`2`/`3` press the row's first three remedies, `Enter`
 * opens where it lives. The numbers are printed on the buttons rather than in
 * a legend, because a shortcut nobody can see is a shortcut nobody uses. Keys
 * are ignored while a field has focus — a page that eats `j` in a search box
 * is a page you stop typing in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Badge, Button, CountBadge, Empty, Kbd, Skeleton } from '@/components/ui';
import { useNavigate } from '@/app/router';
import { scrollIntoScroller } from '@/lib/scroll';
import { plural } from '@/lib/format';
import type { ConvergeStatusView, InboxItem } from '@/lib/api';
import { InboxRow, useInboxActions } from './inbox-row';
import { inboxCounts } from './model';

/** Fields that own their keys — triage must never steal a keystroke from one. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  );
}

/**
 * When the loop next looks at all this by itself.
 *
 * The empty state's whole job. "Nothing needs you" on its own reads as "and
 * nothing ever will" — an operator who has watched the console park a run
 * wants to know whether anything is coming back round. A console where the
 * loop is manual says THAT instead, which is a different and more useful fact.
 */
export function nextSweepText(converge: ConvergeStatusView | undefined): string {
  if (!converge) return 'The convergence loop re-reads the board whenever anything changes.';
  if (!converge.automatic) {
    return 'Convergence is manual on this console (runs are off, or --no-converge) — Recover & continue runs a pass.';
  }
  const every = converge.everyMs > 0 ? ` and every ${Math.round(converge.everyMs / 60_000)} min` : '';
  const queued = converge.pending.length ? ` ${plural(converge.pending.length, 'pass')} queued.` : '';
  return `The loop sweeps at boot, on a docs change, a minute after a stop${every}.${queued}`;
}

export interface NeedsYouProps {
  items: InboxItem[] | undefined;
  loading: boolean;
  /** The endpoint is missing (an older server) — say so rather than "all clear". */
  unavailable?: boolean;
  converge?: ConvergeStatusView;
  /** Show acknowledged rows too. */
  showAcked: boolean;
  onShowAcked: (next: boolean) => void;
  /** `?focus=inbox` landed here — take the keyboard without a click. */
  autoFocus?: boolean;
}

export function NeedsYou({
  items,
  loading,
  unavailable = false,
  converge,
  showAcked,
  onShowAcked,
  autoFocus = false,
}: NeedsYouProps) {
  const navigate = useNavigate();
  const { perform, ack, busy } = useInboxActions();
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => items ?? [], [items]);
  const counts = inboxCounts(rows);

  // Never point past the end after a row is answered and the list shortens.
  const index = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);
  const current = rows[index];

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => {
        const next = Math.max(0, Math.min(rows.length - 1, c + delta));
        const el = listRef.current?.children[next];
        // NEVER `scrollIntoView`: it scrolls every scrollable ancestor, which
        // on a phone is the sideways yank Phase 1 banned. `scrollIntoScroller`
        // finds the one scroller that owns the element.
        if (el) scrollIntoScroller(el, 'nearest');
        return next;
      });
    },
    [rows.length],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (!current) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        navigate(current.href);
      } else if (event.key === '1' || event.key === '2' || event.key === '3') {
        const action = current.actions?.[Number(event.key) - 1];
        // A flagged action is not pressable by mouse either; the key does the
        // same nothing rather than a different nothing.
        if (!action || action.flag) return;
        event.preventDefault();
        perform(current, action);
      }
    },
    [current, move, navigate, perform],
  );

  useEffect(() => {
    if (autoFocus) listRef.current?.focus();
  }, [autoFocus]);

  if (loading && !items) {
    return (
      <Section counts={counts} showAcked={showAcked} onShowAcked={onShowAcked}>
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </Section>
    );
  }

  if (unavailable) {
    return (
      <Section counts={counts} showAcked={showAcked} onShowAcked={onShowAcked}>
        <Empty
          icon={<Inbox size={22} />}
          title="This server has no inbox"
          body="It predates the unified inbox, so this console cannot say what is waiting on you. Restart it from Settings to pick the newer server up."
        />
      </Section>
    );
  }

  if (!rows.length) {
    return (
      <Section counts={counts} showAcked={showAcked} onShowAcked={onShowAcked}>
        <Empty
          icon={<Inbox size={22} />}
          title={showAcked ? 'Nothing at all, acknowledged or otherwise' : 'Nothing needs you'}
          body={nextSweepText(converge)}
          {...(showAcked
            ? {}
            : { action: <Button onClick={() => onShowAcked(true)}>Show acknowledged</Button> })}
        />
      </Section>
    );
  }

  return (
    <Section counts={counts} showAcked={showAcked} onShowAcked={onShowAcked}>
      <ul
        ref={listRef}
        tabIndex={0}
        role="list"
        aria-label="Things that need you"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-action/50"
      >
        {rows.map((item, i) => (
          <InboxRow
            key={item.id}
            item={item}
            selected={i === index}
            onSelect={() => setCursor(i)}
            perform={perform}
            ack={ack}
            {...(busy ? { busy } : {})}
            onOpen={(href) => navigate(href)}
          />
        ))}
      </ul>
      <p className="mt-1.5 flex flex-wrap items-center gap-1 text-2xs text-ink-faint">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd> to move · <Kbd>1</Kbd>–<Kbd>3</Kbd> to act · <Kbd>Enter</Kbd> to open
      </p>
    </Section>
  );
}

function Section({
  counts,
  showAcked,
  onShowAcked,
  children,
}: {
  counts: ReturnType<typeof inboxCounts>;
  showAcked: boolean;
  onShowAcked: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label="Needs you" data-testid="needs-you">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-2xs font-medium uppercase tracking-[0.14em] text-action">Needs you</h2>
        {/* `CountBadge` has no red tone on purpose — the vocabulary's red is a
            STATE, not a count. An urgent total is a word plus a number. */}
        {counts.urgent > 0 && (
          <Badge tone="bad" mono>
            {counts.urgent} urgent
          </Badge>
        )}
        {counts['needs-you'] > 0 && <CountBadge count={counts['needs-you']} tone="accent" label="waiting" />}
        {counts.fyi > 0 && <CountBadge count={counts.fyi} tone="neutral" label="for information" />}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-pressed={showAcked}
          onClick={() => onShowAcked(!showAcked)}
        >
          {showAcked ? 'Hide acknowledged' : 'Show acknowledged'}
        </Button>
      </div>
      {children}
    </section>
  );
}
