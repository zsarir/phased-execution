/**
 * One thing that needs a person — the row, and the one place a remedy is
 * performed.
 *
 * ## Why one row component and not two
 *
 * The same item is read in two places: the **Needs you** section on Now, and
 * the **bell drawer** over whatever page you are on. Before the unified inbox
 * those were separate lists with separate rules — the drawer showed what had
 * been ANNOUNCED and the dashboard showed what was WAITING, and an approval
 * answered on a phone stayed on the laptop's dashboard until a reload. One row
 * component over one query is what makes "the bell drawer shares its rows"
 * true rather than aspirational, and it is why acting from either surface
 * updates the other in the same tick.
 *
 * ## What the row is allowed to decide
 *
 * Almost nothing. `server/inbox.ts` decided which item exists, how loud it is,
 * what is needed, how to give it, what was already tried, and which remedies
 * apply — including which of them this console cannot perform (`action.flag`).
 * `features/now/model.ts` decides which remedy leads. This file renders that
 * and performs a press.
 *
 * The one rule it owns is a rendering rule: **a remedy that cannot be taken is
 * shown, disabled, with the reason** — never hidden. A console started without
 * `--allow-run` still has to be told its run is parked on a permission card;
 * hiding the button because it would not work is the dead end these cards were
 * built to end.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { INBOX_KIND_LABELS, SEVERITY_UI } from '@shared/attention-model.js';
import { api, type InboxAction, type InboxItem } from '@/lib/api';
import { keys } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Button, StatusBadge, toast } from '@/components/ui';
import { toHash } from '@/app/routes';
import { flagReason, splitActions } from './model';

/* ------------------------------------------------------------------ *
 * Performing one
 * ------------------------------------------------------------------ */

/**
 * Press a remedy, acknowledge an item, or put an acknowledgement back.
 *
 * Three rules, the same three `views/dashboard/actions.tsx` learned from the
 * run page and which this keeps:
 *
 *  - **one press in flight at a time**, keyed `${item.id}:${verb}`, so a row
 *    cannot be double-fired and the button that is working says so;
 *  - **the result is a toast, always, including the failures** — a row that
 *    silently does nothing is what these were before;
 *  - **the queries are invalidated in `finally`**, because the case where
 *    re-reading matters most is the one where the request failed.
 *
 * The endpoint, the method and the body are the SERVER's words, taken off the
 * action verbatim. Nothing here maps a verb to a URL: a client that knew which
 * endpoint answered `recover` would be a second copy of a routing table that
 * already exists, and the first divergence would be a button that 404s.
 */
export function useInboxActions(): {
  perform: (item: InboxItem, action: InboxAction) => void;
  ack: (item: InboxItem) => void;
  busy?: string;
} {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | undefined>();

  const settle = useCallback(() => {
    setBusy(undefined);
    void client.invalidateQueries({ queryKey: keys.inbox() });
    void client.invalidateQueries({ queryKey: keys.runs() });
    void client.invalidateQueries({ queryKey: keys.plans() });
    void client.invalidateQueries({ queryKey: keys.approvals() });
    void client.invalidateQueries({ queryKey: keys.state() });
  }, [client]);

  const perform = useCallback(
    (item: InboxItem, action: InboxAction) => {
      if (action.flag) return;
      setBusy(`${item.id}:${action.verb}`);
      void (async () => {
        try {
          // The RESULT decides the word, not the status code. `/recover` answers
          // 200 for every outcome it has — including `errand` ("nothing was
          // launched, a person is needed") and `nothing-to-do` — so a blanket
          // success toast reported that a wedged run had been recovered when
          // nothing had happened at all. Measured: an operator pressed this
          // three times, was told "done" three times, and the run never moved.
          const result = (await api.inboxAct(action)) as
            { outcome?: string; detail?: string } | null | undefined;
          const stalled = result?.outcome === 'errand' || result?.outcome === 'nothing-to-do';
          toast(
            result?.detail ?? `${action.label} — done.`,
            stalled ? 'warn' : 'ok',
            // A refusal is a thing to read, not a thing to glimpse.
            stalled ? 8000 : undefined,
          );
        } catch (error) {
          toast((error as Error).message, 'error');
        } finally {
          settle();
        }
      })();
    },
    [settle],
  );

  const ack = useCallback(
    (item: InboxItem) => {
      setBusy(`${item.id}:ack`);
      void (async () => {
        try {
          if (item.ack) {
            await api.inboxUnack(item.id);
            toast('Back in the list.', 'ok');
          } else {
            await api.inboxAck(item.id);
            // Said out loud because it is the one verb here that does NOT fix
            // anything — an operator who reads "Acknowledged" as "handled" will
            // be surprised when it comes back with a newer clock.
            toast('Acknowledged — seen, not cleared. It returns if it changes.', 'ok');
          }
        } catch (error) {
          toast((error as Error).message, 'error');
        } finally {
          settle();
        }
      })();
    },
    [settle],
  );

  return { perform, ack, ...(busy ? { busy } : {}) };
}

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

export interface InboxRowProps {
  item: InboxItem;
  /** Keyboard triage: this row is the cursor. */
  selected?: boolean;
  onSelect?: () => void;
  perform: (item: InboxItem, action: InboxAction) => void;
  ack?: (item: InboxItem) => void;
  /** `${item.id}:${verb}` of whatever is in flight. */
  busy?: string;
  /** Drop the plan/phase line — the drawer already groups by nothing else. */
  compact?: boolean;
  onOpen?: (href: string) => void;
}

export function InboxRow({
  item,
  selected = false,
  onSelect,
  perform,
  ack,
  busy,
  compact = false,
  onOpen,
}: InboxRowProps) {
  const [open, setOpen] = useState(false);
  const { primary, rest } = splitActions(item);
  const ui = SEVERITY_UI[item.severity] ?? 'queued';
  const since = Date.parse(item.since);
  const where = [item.slug, item.phase != null ? `phase ${item.phase}` : null].filter(Boolean).join(' · ');

  return (
    <li
      data-testid="inbox-row"
      data-kind={item.kind}
      data-severity={item.severity}
      data-selected={selected || undefined}
      // `state-<ui>` paints the border and every `tone="state"` badge inside it
      // from the ONE status vocabulary — there is no second severity palette.
      className={cn(
        `state-${ui}`,
        'flex flex-col gap-2 rounded-lg border bg-surface px-3 py-2.5',
        item.ack ? 'border-rule opacity-70' : 'border-state/45',
        selected && 'ring-2 ring-action/60',
      )}
      onFocusCapture={onSelect}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <StatusBadge state={ui} label={INBOX_KIND_LABELS[item.kind] ?? item.kind} />
            <a
              href={toHash(item.href)}
              onClick={(event) => {
                if (!onOpen) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                onOpen(toHash(item.href));
              }}
              className="min-w-0 flex-1 truncate font-medium text-ink hover:text-action"
              title={item.title}
            >
              {item.title}
            </a>
            {/* An empty `since` is a fact with no clock (an account is signed
                out; nothing records WHEN), never "just now". Saying nothing is
                the honest rendering — see `InboxItem.since`. */}
            {Number.isFinite(since) && (
              <span className="shrink-0 text-2xs text-ink-faint">{relativeTime(since)}</span>
            )}
          </div>

          <p className="mt-0.5 line-clamp-2 text-2xs text-ink-muted md:line-clamp-none">{item.need}</p>

          {!compact && where && <p className="mt-0.5 font-mono text-2xs text-ink-faint">{where}</p>}
        </div>
      </div>

      {(item.how || item.tried?.length) && (
        <div>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
          >
            <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
            {open ? 'Hide how' : 'How'}
            {item.tried?.length ? ` · ${item.tried.length} already tried` : ''}
          </button>
          {open && (
            <div className="mt-1 rounded border border-rule bg-ground px-2 py-1.5 text-2xs">
              <p className="text-ink-muted">{item.how}</p>
              {item.tried?.length ? (
                <>
                  <p className="mt-1.5 text-ink-faint">Already tried, so nobody tries it again by hand:</p>
                  <ul className="mt-0.5 flex flex-col gap-0.5 text-ink-muted">
                    {item.tried.map((line) => (
                      <li key={line}>· {line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {primary && (
          <ActionButton item={item} action={primary} primary perform={perform} busy={busy} index={1} />
        )}
        {rest.map((action, i) => (
          <ActionButton
            key={action.verb}
            item={item}
            action={action}
            perform={perform}
            busy={busy}
            index={primary ? i + 2 : i + 1}
          />
        ))}
        <Button size="sm" variant="ghost" asChild>
          <a
            href={toHash(item.href)}
            onClick={(event) => {
              if (!onOpen) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onOpen(toHash(item.href));
            }}
          >
            <ExternalLink size={12} aria-hidden />
            Open
          </a>
        </Button>
        {ack && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busy === `${item.id}:ack`}
            onClick={() => ack(item)}
            title={
              item.ack
                ? 'Put it back in the list.'
                : 'Seen, not cleared — it comes back if the thing it is about changes.'
            }
          >
            {item.ack ? 'Unacknowledge' : 'Acknowledge'}
          </Button>
        )}
      </div>

      {/* Said once per row rather than per button: three buttons each repeating
          "--allow-run is off" is noise, and none of them says it where a screen
          reader would reach it. */}
      {item.actions.some((action) => action.flag) && (
        <p className="text-2xs text-ink-faint">
          {[...new Set(item.actions.map((a) => flagReason(a.flag)).filter(Boolean))].join(' ')}
        </p>
      )}
    </li>
  );
}

/**
 * One remedy.
 *
 * `index` is the number the keyboard fires (`1`, `2`, `3`) and it is on the
 * button as a hint rather than in a legend somewhere else: a shortcut nobody
 * can see is a shortcut nobody uses.
 */
function ActionButton({
  item,
  action,
  primary = false,
  perform,
  busy,
  index,
}: {
  item: InboxItem;
  action: InboxAction;
  primary?: boolean;
  perform: (item: InboxItem, action: InboxAction) => void;
  busy?: string;
  index: number;
}) {
  const reason = flagReason(action.flag);
  return (
    <Button
      size="sm"
      variant={primary ? 'action' : 'default'}
      disabled={Boolean(action.flag) || busy === `${item.id}:${action.verb}`}
      title={reason}
      data-verb={action.verb}
      onClick={() => perform(item, action)}
    >
      {action.label}
      {index <= 3 && !action.flag && (
        <Badge tone="neutral" mono className="border-transparent px-1 py-0 text-ink-faint">
          {index}
        </Badge>
      )}
    </Button>
  );
}
