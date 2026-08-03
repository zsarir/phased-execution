/**
 * The inbox: everything the console has announced.
 *
 * This is the page the whole notification store exists for. Before it, a phone
 * asleep and no tab open meant the event had simply never happened — the
 * announcement was raised, delivered to nobody, and forgotten. Every row here
 * says not only *what* was announced but *what became of it*, because a silent
 * delivery failure is exactly the thing that is invisible otherwise.
 *
 * Ported from `web/views/notifications.js`. Three things changed:
 *
 * 1. **The rows are links.** They were `<button onClick=navigate>`, so the one
 *    list in the app whose entire purpose is "go and look at this" could not be
 *    opened in a background tab.
 * 2. **The four-way reload subscription is gone.** The old inbox re-fetched
 *    itself from a `subscribeNotifications({notification, delivery, read,
 *    cleared})` block; `EVENT_EFFECTS` already invalidates the `notifications`
 *    prefix on all four, so the data layer does it for every mounted variant.
 * 3. **Clear-all asks in a focus-trapped dialog** rather than `window.confirm`.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type NotificationRecord } from '@/lib/api';
import { keys, useInbox } from '@/lib/queries';
import { plural, relativeTime } from '@/lib/format';
import {
  AlertDialog, AlertDialogContent, AlertDialogTrigger,
  Banner, Button, Chip, Empty, Skeleton, toast,
} from '@/components/ui';
import { toHash } from '@shared/routes.js';

/** How many rows one page of the inbox holds before "Show older". */
const PAGE = 60;

/** Day headings, newest first, with the two everyone actually reads named. */
export function groupByDay(items: NotificationRecord[]): [string, NotificationRecord[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const out = new Map<string, NotificationRecord[]>();
  for (const item of items) {
    const at = new Date(item.at);
    const key = Number.isNaN(at.getTime()) ? 'Undated'
      : at.toDateString() === today ? 'Today'
        : at.toDateString() === yesterday ? 'Yesterday'
          : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return [...out.entries()];
}

/** What became of one announcement, in the fewest words that are still true. */
export function deliverySummary(item: NotificationRecord): { text: string; failed: boolean } {
  const delivered = item.delivery ?? [];
  if (!delivered.length) return { text: 'no device', failed: false };
  const failed = delivered.filter((d) => d.outcome !== 'sent');
  return failed.length
    ? { text: `${failed.length}/${delivered.length} not delivered`, failed: true }
    : { text: `sent to ${delivered.length}`, failed: false };
}

export function Inbox({ onUnread }: { onUnread?: (n: number) => void }) {
  const client = useQueryClient();
  const [category, setCategory] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const { data, isPending } = useInbox({
    category: category || undefined,
    unread: unreadOnly || undefined,
    limit,
  });

  // Reported up so the page header and the tab can carry the count without
  // either of them fetching the inbox a second time. In an effect, not in
  // render: setting a parent's state while rendering a child is a React
  // warning at best and a loop at worst.
  const unread = data?.unread;
  useEffect(() => { if (unread != null) onUnread?.(unread); }, [unread, onUnread]);

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { void client.invalidateQueries({ queryKey: keys.notifications() }); },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const open = useMutation({
    mutationFn: async (item: NotificationRecord) => {
      if (!item.read) await api.markNotificationsRead([item.id]);
      return item.url;
    },
    onSuccess: (url) => {
      void client.invalidateQueries({ queryKey: keys.notifications() });
      // The URL is whatever `routeFor` built on the server — never assembled
      // here. `toHash` normalises the `/#/…` form a push payload carries.
      window.location.hash = toHash(url);
    },
  });

  if (isPending && !data) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
      </div>
    );
  }

  if (!data) return null;

  const groups = groupByDay(data.items);
  const nothingCanArrive = data.devices === 0 && !data.outOfBand?.configured;
  const busy = act.isPending;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {nothingCanArrive && (
        <Banner severity="info">
          <strong>Nothing can reach you out of band yet.</strong> No device is subscribed and no{' '}
          <code>PHASE_CONSOLE_NOTIFY</code> command is set, so these arrive here and nowhere else.{' '}
          <a href="#/notifications/settings" className="text-action underline">Set a device up</a>.
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          <Button size="sm" aria-pressed={category === ''} onClick={() => setCategory('')}>All</Button>
          {(data.categories ?? []).map((c) => (
            <Button
              key={c.id}
              size="sm"
              aria-pressed={category === c.id}
              title={c.detail}
              onClick={() => setCategory(category === c.id ? '' : c.id)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}>
            Unread only
          </Button>
          <Button
            size="sm"
            disabled={busy || data.unread === 0}
            onClick={() => act.mutate(() => api.markNotificationsRead())}
          >
            Mark all read
          </Button>
          <Button
            size="sm"
            disabled={busy || !data.total}
            onClick={() => act.mutate(() => api.clearNotifications('read'))}
          >
            Clear read
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="danger" disabled={busy || !data.total}>Clear all</Button>
            </AlertDialogTrigger>
            {/* The only irreversible thing on this page. It gets a question,
                and the question says how many. */}
            <AlertDialogContent
              title={`Delete all ${plural(data.total, 'notification')}?`}
              description="This cannot be undone. Delivery history goes with them."
              confirmLabel="Delete them"
              destructive
              onConfirm={() => act.mutate(() => api.clearNotifications('all'))}
            />
          </AlertDialog>
        </div>
      </div>

      {!data.items.length ? (
        <Empty
          title={unreadOnly || category ? 'Nothing matches that' : 'Nothing yet'}
          body={unreadOnly || category
            ? 'Clear the filters to see the rest.'
            : 'Approvals, halts, phases landing and plans finishing all arrive here.'}
        />
      ) : groups.map(([day, items]) => (
        <section key={day}>
          <h2 className="mb-1.5 font-display text-2xs tracking-[0.14em] text-ink-faint uppercase">{day}</h2>
          <div className="flex flex-col gap-1">
            {items.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                onOpen={() => open.mutate(item)}
                onClear={() => act.mutate(() => api.clearNotifications({ id: item.id }))}
              />
            ))}
          </div>
        </section>
      ))}

      {data.more && (
        <div>
          <Button onClick={() => setLimit(limit + PAGE)}>Show older</Button>
        </div>
      )}
    </div>
  );
}

function InboxRow({
  item,
  onOpen,
  onClear,
}: {
  item: NotificationRecord;
  onOpen: () => void;
  onClear: () => void;
}) {
  const delivered = item.delivery ?? [];
  const summary = deliverySummary(item);

  return (
    <article
      className={`flex items-stretch gap-1 rounded border bg-surface
                  ${item.read ? 'border-rule' : 'border-action/45'}`}
    >
      {/* A real link so it can be opened in a background tab; the click also
          marks it read, which a bare href cannot do. */}
      <a
        href={toHash(item.url)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen();
        }}
        className="min-w-0 flex-1 px-3 py-2 hover:bg-surface-raised focus-visible:bg-surface-raised"
      >
        <div className="flex items-baseline justify-between gap-2">
          <strong className={`min-w-0 truncate text-sm ${item.read ? 'text-ink-muted' : 'text-ink'}`}>
            {item.title}
          </strong>
          <span className="shrink-0 text-2xs text-ink-faint">{relativeTime(Date.parse(item.at))}</span>
        </div>
        <p className="mt-0.5 text-sm text-ink-muted">{item.body}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Chip>{item.category}</Chip>
          {item.urgent && <Chip tone="warn">urgent</Chip>}
          <Chip
            tone={summary.failed ? 'bad' : delivered.length ? 'ok' : 'neutral'}
            title={delivered.length
              ? delivered.map((d) => `${d.label}: ${d.outcome}${d.detail ? ` (${d.detail})` : ''}`).join('\n')
              : 'No device was subscribed when this was announced'}
          >
            {summary.text}
          </Chip>
        </div>
      </a>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove “${item.title}”`}
        className="shrink-0 px-2 text-ink-faint hover:bg-surface-raised hover:text-blocked"
      >
        <X className="size-4" aria-hidden />
      </button>
    </article>
  );
}
