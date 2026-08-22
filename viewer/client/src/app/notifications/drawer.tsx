import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type InboxItem, type NotificationRecord } from '@/lib/api';
import { keys, useAttentionInbox, useInbox } from '@/lib/queries';
import { plural, relativeTime } from '@/lib/format';
import { usePhone } from '@/lib/media';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Banner,
  Button,
  Chip,
  CountBadge,
  Empty,
  Sheet,
  SheetContent,
  Skeleton,
  toast,
} from '@/components/ui';
import { InboxRow, useInboxActions } from '@/features/now/inbox-row';
import { needsYouCount } from '@/features/now/model';
import { useNavigate } from '@/app/router';
import {
  OVERLAY_KEYS,
  PANEL_KEYS,
  bellHref,
  closeOverlaysHref,
  panelOf,
  toHash,
  type PanelKey,
  type Route,
} from '@/app/routes';

/** How many rows one page of the drawer holds before "Show older". */
const PAGE = 40;

/**
 * The bell drawer — two questions, over whatever page you are on.
 *
 * **Needs you** is the same `GET /api/inbox` rows Now leads with, rendered by
 * the same `InboxRow`, with the same buttons that do the same thing. That is
 * the whole point of the panel: before it, an approval answered on a phone
 * stayed on the laptop's dashboard until a reload, because the drawer and the
 * dashboard were two lists over two queries with two ideas of what an "item"
 * was. One component over one query is what makes acting from either surface
 * update the other in the same tick.
 *
 * **Announcements** is the log of what the console has SAID. It is the surface
 * the whole notification store exists for: a phone asleep and no tab open used
 * to mean the event had simply never happened. Every row says not only what was
 * announced but what became of it, because a silent delivery failure is exactly
 * the thing that is invisible otherwise.
 *
 * Keeping them as two panels rather than one merged list is deliberate. "This
 * still needs you" and "this was announced at 04:12 and reached no device" are
 * different questions with different lifetimes — an inbox row disappears when
 * the thing it is about is fixed, an announcement never does — and the 2.x page
 * that answered both at once is the page nobody read.
 *
 * `?bell=1` is the open state, like `?k=` and `?help=`, so a push can deep-link
 * straight into it and a reload does not lose it; `?panel=` picks the half.
 */
export function NotificationsDrawer({ route }: { route: Route }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const open = route.query[OVERLAY_KEYS.bell] != null;
  // Needs-you first by default: the drawer is opened by a bell with a count on
  // it, and the count is of things still waiting. `#/notifications` — the
  // retired announcements page — asks for its own panel by name.
  const panel = panelOf(route) ?? PANEL_KEYS.inbox;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) navigate(closeOverlaysHref(route));
      }}
    >
      {/* Right on a desktop — it is a list beside the page, not over it. Bottom
          on a phone, where a right-hand drawer is a full-screen modal that has
          not admitted it and where the thumb is at the other end of the device. */}
      <SheetContent side={phone ? 'bottom' : 'right'} title="Inbox" showTitle className="p-0">
        {open && (
          <DrawerPanels
            panel={panel}
            onPanel={(next) => navigate(bellHref(route, next))}
            onOpen={(url) => navigate(toHash(url))}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The two panels and the switch between them.
 *
 * Mounted one at a time on purpose: each holds a paged server query, and a
 * closed panel has no business keeping one warm.
 */
function DrawerPanels({
  panel,
  onPanel,
  onOpen,
}: {
  panel: PanelKey;
  onPanel: (panel: PanelKey) => void;
  onOpen: (url: string) => void;
}) {
  // Unconditional, unlike every other run-endpoint read in the app: the shell
  // only mounts this drawer once `/api/state` has answered, so the stale-server
  // guard has already been applied one level up — and `useAttentionInbox` does
  // not retry, so a console too old for the endpoint costs exactly one 404.
  const inbox = useAttentionInbox();
  const waiting = needsYouCount(inbox.data?.items);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule px-3 py-2">
        <Button
          size="sm"
          variant={panel === PANEL_KEYS.inbox ? 'action' : 'ghost'}
          aria-pressed={panel === PANEL_KEYS.inbox}
          onClick={() => onPanel(PANEL_KEYS.inbox)}
        >
          Needs you
          <CountBadge count={waiting} tone="accent" label="waiting on you" />
        </Button>
        <Button
          size="sm"
          variant={panel === PANEL_KEYS.announcements ? 'action' : 'ghost'}
          aria-pressed={panel === PANEL_KEYS.announcements}
          onClick={() => onPanel(PANEL_KEYS.announcements)}
        >
          Announcements
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {panel === PANEL_KEYS.inbox ? (
          <NeedsYouPanel items={inbox.data?.items} loading={inbox.isPending} onOpen={onOpen} />
        ) : (
          <DrawerBody onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

/**
 * The needs-you rows, in the drawer.
 *
 * `compact` drops the plan/phase line each row carries on Now — in a 380px
 * drawer that line is what pushes the buttons below the fold, and the row's
 * own title already names the plan.
 */
function NeedsYouPanel({
  items,
  loading,
  onOpen,
}: {
  items: InboxItem[] | undefined;
  loading: boolean;
  onOpen: (url: string) => void;
}) {
  const { perform, ack, busy } = useInboxActions();

  if (loading && !items) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  if (!items?.length) {
    return (
      <div className="p-3">
        <Empty
          title="Nothing needs you"
          body="Errands, permission cards, gates and sign-ins all arrive here — and on Now, which is the same list."
        />
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-3">
      {items.map((item) => (
        <InboxRow
          key={item.id}
          item={item}
          perform={perform}
          ack={ack}
          {...(busy ? { busy } : {})}
          compact
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

/** Day headings, newest first, with the two everyone actually reads named. */
export function groupByDay(items: NotificationRecord[]): [string, NotificationRecord[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const out = new Map<string, NotificationRecord[]>();
  for (const item of items) {
    const at = new Date(item.at);
    const key = Number.isNaN(at.getTime())
      ? 'Undated'
      : at.toDateString() === today
        ? 'Today'
        : at.toDateString() === yesterday
          ? 'Yesterday'
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

/**
 * The announcements list. Split out so the drawer mounts it only while that
 * panel is showing — it is a paged server query, and a panel nobody is looking
 * at has no business holding one.
 */
export function DrawerBody({ onOpen }: { onOpen: (url: string) => void }) {
  const client = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const { data, isPending } = useInbox({ unread: unreadOnly || undefined, limit });

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.notifications() });
    },
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
      onOpen(url);
    },
  });

  if (isPending && !data) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  const groups = groupByDay(data.items);
  const nothingCanArrive = data.devices === 0 && !data.outOfBand?.configured;
  const busy = act.isPending;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
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
            <Button size="sm" variant="danger" disabled={busy || !data.total}>
              Clear all
            </Button>
          </AlertDialogTrigger>
          {/* The only irreversible thing in here. It gets a question, and the
              question says how many. */}
          <AlertDialogContent
            title={`Delete all ${plural(data.total, 'notification')}?`}
            description="This cannot be undone. Delivery history goes with them."
            confirmLabel="Delete them"
            destructive
            onConfirm={() => act.mutate(() => api.clearNotifications('all'))}
          />
        </AlertDialog>
      </div>

      {nothingCanArrive && (
        <Banner severity="info">
          <div className="min-w-0">
            <strong>Nothing can reach you out of band yet.</strong> No device is subscribed and no{' '}
            <code>PHASE_CONSOLE_NOTIFY</code> command is set, so these arrive here and nowhere else.{' '}
            <a href="#/notifications/settings" className="text-action underline">
              Set a device up
            </a>
            .
          </div>
        </Banner>
      )}

      {!data.items.length ? (
        <Empty
          title={unreadOnly ? 'Nothing unread' : 'Nothing yet'}
          body={
            unreadOnly
              ? 'Everything the console has announced has been read.'
              : 'Approvals, halts, phases landing and plans finishing all arrive here.'
          }
        />
      ) : (
        groups.map(([day, items]) => (
          <section key={day}>
            <h3 className="mb-1.5 font-display text-2xs tracking-[0.14em] text-ink-faint uppercase">{day}</h3>
            <div className="flex flex-col gap-1">
              {items.map((item) => (
                <DrawerRow
                  key={item.id}
                  item={item}
                  onOpen={() => open.mutate(item)}
                  onClear={() => act.mutate(() => api.clearNotifications({ id: item.id }))}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {data.more && (
        <div>
          <Button onClick={() => setLimit(limit + PAGE)}>Show older</Button>
        </div>
      )}
    </div>
  );
}

function DrawerRow({
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
      className={`flex items-stretch gap-1 rounded border bg-surface ${
        item.read ? 'border-rule' : 'border-action/45'
      }`}
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
          {item.resolved ? (
            <Chip title={`Resolved on its own ${item.resolved.reason ? `— ${item.resolved.reason}` : ''}`}>
              resolved itself
            </Chip>
          ) : (
            item.urgent && <Chip tone="warn">urgent</Chip>
          )}
          <Chip
            tone={summary.failed ? 'bad' : delivered.length ? 'ok' : 'neutral'}
            title={
              delivered.length
                ? delivered
                    .map((d) => `${d.label}: ${d.outcome}${d.detail ? ` (${d.detail})` : ''}`)
                    .join('\n')
                : 'No device was subscribed when this was announced'
            }
          >
            {summary.text}
          </Chip>
        </div>
      </a>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove “${item.title}”`}
        className="shrink-0 px-2 text-ink-faint hover:bg-surface-raised hover:text-status-failed"
      >
        <X className="size-4" aria-hidden />
      </button>
    </article>
  );
}
