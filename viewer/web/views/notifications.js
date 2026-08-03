/**
 * Notifications: the history, and the plumbing that delivers them.
 *
 * Two tabs, because they answer two different questions and only one of them
 * is about setup. **Inbox** is what the console has told you — everything it
 * announced, whether or not anything was listening at the time, which is the
 * failure this page exists for: a phone asleep and no tab open used to mean the
 * event had simply never happened. **Settings** is the delivery plumbing, and
 * it is deliberately downstream of the inbox rather than the other way round —
 * the inbox works with nothing configured at all.
 *
 * Within Settings the same distinction is drawn once more, because it is the
 * whole reason someone comes here:
 *
 *   in this tab — the Notification API, free, instant, and gone with the tab.
 *   on this device — a push subscription, which arrives with nothing open.
 *
 * Being told about a halted run at 3am and being told about it when you next
 * look at the console are not the same feature, and only one of them needs a
 * service worker and a signing key.
 */

import { html, useState, useEffect, useCallback, useMemo } from '../html.js';
import { api, fresh, subscribeNotifications } from '../api.js';
import { navigate } from '../router.js';
import { toast } from '../store.js';
import { notifyState, askToNotify } from '../notify.js';
import { Banner, Chip, Empty, Spinner, Tabs, relativeTime } from '../components/ui.js';
import {
  blocker, currentEndpoint, describeBrowser, disable, enable, iosNeedsInstall, sendTest, setCategories,
} from '../push.js';

const TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'settings', label: 'Settings' },
];

/** How many rows one page of the inbox holds before "Show older". */
const PAGE = 60;

export function NotificationsView({ route }) {
  const tab = TABS.some((t) => t.id === route?.segments?.[1]) ? route.segments[1] : 'inbox';
  const [unread, setUnread] = useState(0);

  return html`
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Notifications</h1>
          <p class="sub">
            Everything the console announced — kept whether or not a tab was open or a device
            was subscribed to hear it.
          </p>
        </div>
        ${unread > 0 ? html`<${Chip} kind="warn">${unread} unread</${Chip}>` : null}
      </header>

      <${Tabs}
        tabs=${TABS.map((t) => (t.id === 'inbox' && unread > 0 ? { ...t, count: unread } : t))}
        active=${tab}
        onSelect=${(id) => navigate(`notifications/${id}`)} />

      ${tab === 'settings'
        ? html`<div class="grid cards" style="margin-top:var(--s3)"><${NotificationsCard} /></div>`
        : html`<${Inbox} onUnread=${setUnread} />`}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

function Inbox({ onUnread }) {
  const [data, setData] = useState(null);
  const [category, setCategory] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.notifications({ category, unread: unreadOnly, limit });
      setData(next);
      onUnread?.(next.unread ?? 0);
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
  }, [category, unreadOnly, limit, onUnread]);

  useEffect(() => { void load(); }, [load]);

  // The store is the source of truth and it changes from four directions — a
  // new announcement, a delivery outcome landing against one, a phone marking
  // one read, another tab clearing them. All of them arrive here.
  useEffect(() => subscribeNotifications({
    notification: load, delivery: load, read: load, cleared: load,
  }), [load]);

  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (error) { toast(String(error.message ?? error), 'error'); }
    finally { setBusy(''); await load(); }
  };

  const groups = useMemo(() => groupByDay(data?.items ?? []), [data]);

  if (!data) return html`<div style="margin-top:var(--s4)"><${Spinner} label="Reading the inbox" /></div>`;

  const nothingCanArrive = data.devices === 0 && !data.outOfBand?.configured;

  return html`
    <div class="stack" style="margin-top:var(--s3)">
      ${nothingCanArrive ? html`
        <${Banner} kind="info">
          <strong>Nothing can reach you out of band yet.</strong> No device is subscribed and no
          <code>PHASE_CONSOLE_NOTIFY</code> command is set, so these arrive here and nowhere else.
          ${' '}<button class="linkish" onClick=${() => navigate('notifications/settings')}>Set a device up</button>.
        </${Banner}>` : null}

      <div class="row wrap spread inbox-controls">
        <div class="row wrap" style="gap:6px">
          <button class=${`chip ${category === '' ? 'on' : ''}`} onClick=${() => setCategory('')}>All</button>
          ${(data.categories ?? []).map((c) => html`
            <button key=${c.id} class=${`chip ${category === c.id ? 'on' : ''}`}
                    title=${c.detail}
                    onClick=${() => setCategory(category === c.id ? '' : c.id)}>${c.label}</button>`)}
        </div>
        <div class="row wrap" style="gap:6px">
          <button class=${`btn small ${unreadOnly ? 'primary' : ''}`}
                  aria-pressed=${String(unreadOnly)}
                  onClick=${() => setUnreadOnly(!unreadOnly)}>Unread only</button>
          <button class="btn small" disabled=${busy !== '' || data.unread === 0}
                  onClick=${() => act('read', () => api.markNotificationsRead())}>Mark all read</button>
          <button class="btn small" disabled=${busy !== '' || !data.total}
                  onClick=${() => act('clear-read', () => api.clearNotifications('read'))}>Clear read</button>
          <button class="btn small danger" disabled=${busy !== '' || !data.total}
                  onClick=${() => act('clear-all', async () => {
                    // The only irreversible thing on this page. It gets a
                    // question, and the question says how many.
                    if (!confirm(`Delete all ${data.total} notification${data.total === 1 ? '' : 's'}? This cannot be undone.`)) return;
                    await api.clearNotifications('all');
                  })}>Clear all</button>
        </div>
      </div>

      ${!data.items.length ? html`
        <${Empty}
          title=${unreadOnly || category ? 'Nothing matches that' : 'Nothing yet'}
          hint=${unreadOnly || category
            ? 'Clear the filters to see the rest.'
            : 'Approvals, halts, phases landing and plans finishing all arrive here.'} />`
        : groups.map(([day, items]) => html`
          <section key=${day} class="inbox-day">
            <div class="rail-section-title">${day}</div>
            <div class="stack" style="gap:4px">
              ${items.map((item) => html`
                <${InboxRow} key=${item.id} item=${item}
                  onOpen=${() => act('open', async () => {
                    if (!item.read) await api.markNotificationsRead([item.id]);
                    navigate(item.url);
                  })}
                  onClear=${() => act('drop', () => api.clearNotifications({ id: item.id }))} />`)}
            </div>
          </section>`)}

      ${data.more ? html`
        <button class="btn" onClick=${() => setLimit(limit + PAGE)}>Show older</button>` : null}
    </div>`;
}

function InboxRow({ item, onOpen, onClear }) {
  const delivered = item.delivery ?? [];
  const failed = delivered.filter((d) => d.outcome !== 'sent');
  return html`
    <article class=${`inbox-row ${item.read ? '' : 'unread'} ${item.urgent ? 'urgent' : ''}`}>
      <button class="inbox-open" onClick=${onOpen} title=${`Open ${item.url}`}>
        <div class="row spread">
          <strong>${item.title}</strong>
          <span class="muted small">${relativeTime(Date.parse(item.at))}</span>
        </div>
        <p class="muted small" style="margin:2px 0 0">${item.body}</p>
        <div class="row wrap" style="gap:6px;margin-top:4px">
          <span class="tag">${item.category}</span>
          ${item.urgent ? html`<span class="tag" style="color:var(--line-ready)">urgent</span>` : null}
          ${delivered.length
            // A silent failure is the thing this store exists to make visible,
            // so the row says what became of it rather than only that it was
            // announced.
            ? html`<span class="tag" title=${delivered.map((d) => `${d.label}: ${d.outcome}${d.detail ? ` (${d.detail})` : ''}`).join('\n')}>
                ${failed.length ? `${failed.length}/${delivered.length} not delivered` : `sent to ${delivered.length}`}
              </span>`
            : html`<span class="tag muted" title="No device was subscribed when this was announced">no device</span>`}
        </div>
      </button>
      <button class="btn small ghost inbox-drop" title="Remove this one" onClick=${onClear}>×</button>
    </article>`;
}

/** Day headings, newest first, with the two everyone actually reads named. */
function groupByDay(items) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const out = new Map();
  for (const item of items) {
    const at = new Date(item.at);
    const key = Number.isNaN(at.getTime()) ? 'Undated'
      : at.toDateString() === today ? 'Today'
        : at.toDateString() === yesterday ? 'Yesterday'
          : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return [...out.entries()];
}

/* ------------------------------------------------------------------ *
 * Settings: how a notification gets out of this process
 * ------------------------------------------------------------------ */

export function NotificationsCard() {
  const [state, setState] = useState(null);
  const [endpoint, setEndpoint] = useState(null);
  const [reach, setReach] = useState(null);
  const [busy, setBusy] = useState('');
  const [inTab, setInTab] = useState(notifyState());

  const load = useCallback(async () => {
    try {
      const [next, mine] = await Promise.all([fresh('/api/push'), currentEndpoint()]);
      setState(next);
      setEndpoint(mine);
    } catch { /* the card degrades to its unavailable state */ }
    // Read from the store rather than from the register: "this device is
    // subscribed" and "anything actually arrived" are different claims, and
    // only the second one is worth anything at 3am.
    try { setReach(await api.notifications({ limit: 25 })); } catch { /* the readout stays hidden */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Which row is this browser? The endpoint is the only thing that says so, and
  // the server never returns it — so the client matches on the one it holds.
  const mine = state?.devices?.find((d) => d.service && endpoint && endpoint.startsWith(d.service)) ?? null;
  const subscribed = Boolean(endpoint && mine);
  const why = blocker();

  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (error) { toast(String(error.message ?? error), 'error'); }
    finally { setBusy(''); await load(); }
  };

  return html`
    <div class="card" style="grid-column:1/-1">
      <div class="card-head">
        <h3>Notifications</h3>
        <span class="muted small">${state?.devices?.length ?? 0} device${state?.devices?.length === 1 ? '' : 's'} subscribed</span>
      </div>
      <div class="card-body stack">

        ${!state?.devices?.length && !why ? html`
          <${Banner} kind="info">
            <strong>Nothing has ever been sent from this console.</strong> No browser has subscribed,
            so every announcement so far reached the inbox and stopped there. Turning it on below
            takes one permission prompt and covers this device with the console closed.
          </${Banner}>` : null}

        <div class="notify-lane">
          <div class="grow">
            <strong>In this tab</strong>
            <p class="muted small" style="margin:2px 0 0">
              Raised by the page. Costs nothing and needs no setup, but only exists while a tab is open.
            </p>
          </div>
          ${inTab === 'granted'
            ? html`<span class="tag" style="color:var(--line-done)">on</span>`
            : inTab === 'denied'
              ? html`<span class="muted small">blocked in browser settings</span>`
              : inTab === 'unsupported'
                ? html`<span class="muted small">unsupported here</span>`
                : html`<button class="btn small" onClick=${async () => setInTab(await askToNotify())}>Allow</button>`}
        </div>

        <div class="notify-lane">
          <div class="grow">
            <strong>On this device</strong>
            <p class="muted small" style="margin:2px 0 0">
              Delivered through a push service, so it arrives with the console closed — the case an
              unattended run exists for. ${describeBrowser()}.
            </p>
          </div>
          ${subscribed
            ? html`
              <div class="row" style="gap:6px">
                <button class="btn small" disabled=${busy !== ''}
                        onClick=${() => run('test', async () => {
                          const result = await sendTest(mine.id);
                          // "Accepted" is the truth and is not the same as
                          // "you saw it": the push service, the browser and the
                          // operating system are three separate yeses, and only
                          // the first one answers back. Saying just "sent" makes
                          // a muted OS look like a broken console.
                          toast(result.ok
                            ? `Handed to the push service. If nothing appeared, it got no further than your `
                              + `system notification settings for this browser.`
                            : `Not sent — ${result.detail}`,
                            result.ok ? 'ok' : 'error');
                        })}>
                  ${busy === 'test' ? 'Sending…' : 'Send a test'}
                </button>
                <button class="btn small danger" disabled=${busy !== ''}
                        onClick=${() => run('off', disable)}>Turn off</button>
              </div>`
            : why
              ? null
              : html`
                <button class="btn small primary" disabled=${busy !== ''}
                        onClick=${() => run('on', async () => {
                          const result = await enable();
                          toast(result.ok ? 'This device will be notified.' : result.detail,
                            result.ok ? 'ok' : 'error');
                        })}>
                  ${busy === 'on' ? 'Subscribing…' : 'Turn on'}
                </button>`}
        </div>

        ${why ? html`
          <div class="banner ${iosNeedsInstall() ? 'info' : 'warn'}">
            ${why}
          </div>` : null}

        ${subscribed && state?.categories?.length ? html`
          <div>
            <div class="rail-section-title" style="margin-bottom:var(--s2)">What to send</div>
            <div class="stack" style="gap:var(--s2)">
              ${state.categories.map((category) => html`
                <label key=${category.id} class="notify-category">
                  <input
                    type="checkbox"
                    checked=${mine.categories?.[category.id] === true}
                    onChange=${(event) => run('cat', () => setCategories(mine.id, {
                      ...mine.categories, [category.id]: event.target.checked,
                    }))} />
                  <div>
                    <strong>${category.label}</strong>
                    ${category.urgent ? html`<span class="tag" style="margin-left:6px">urgent</span>` : null}
                    <p class="muted small" style="margin:2px 0 0">${category.detail}</p>
                  </div>
                </label>`)}
            </div>
          </div>` : null}

        ${state?.devices?.length > 1 ? html`
          <div>
            <div class="rail-section-title" style="margin-bottom:var(--s2)">Other devices</div>
            <div class="stack" style="gap:4px">
              ${state.devices.filter((d) => d.id !== mine?.id).map((device) => html`
                <div key=${device.id} class="notify-lane">
                  <div class="grow">
                    <strong>${device.label}</strong>
                    <span class="muted small" style="margin-left:6px">
                      ${Object.values(device.categories ?? {}).filter(Boolean).length} categories
                      ${device.lastOkAt ? ` · last reached ${new Date(device.lastOkAt).toLocaleString()}` : ' · never reached'}
                    </span>
                  </div>
                  <button class="btn small" disabled=${busy !== ''}
                          onClick=${() => run('test', async () => {
                            const result = await sendTest(device.id);
                            toast(result.ok ? `Sent — ${result.detail}` : `Not sent — ${result.detail}`,
                              result.ok ? 'ok' : 'error');
                          })}>Test</button>
                </div>`)}
            </div>
          </div>` : null}

        ${reach ? html`<${DeliveryReadout} reach=${reach} />` : null}

        ${subscribed ? html`
          <p class="muted small" style="margin:0">
            A test that says it was handed over and never appears has almost always been stopped by
            the operating system rather than by anything here — macOS
            ${' '}<em>System Settings → Notifications → your browser</em>, or Windows
            ${' '}<em>Settings → System → Notifications</em>. A Focus or Do Not Disturb mode does the
            same thing silently.
          </p>` : null}

        <p class="muted small" style="margin:0">
          For a machine with no browser in the picture at all,
          ${' '}<code>${'PHASE_CONSOLE_NOTIFY=<command>'}</code>${' '}
          is run with the title and body of every one of these.
          ${reach && !reach.outOfBand?.configured
            ? html` It is <strong>not set</strong> for this process — and under launchd it has to be
              in the plist, not in your shell: ${' '}<code>deploy/agent.sh install --notify '<command>'</code>.`
            : reach ? html` It is set.` : null}
        </p>
      </div>
    </div>`;
}

/**
 * What actually became of the last few announcements.
 *
 * The register answers "is a device subscribed", which is not the question. A
 * subscription can be live, chosen for every category, and still deliver
 * nothing — a push service refusing, an endpoint that died months ago, an
 * operating system dropping it silently. `announce()` is deliberately not
 * awaited so none of that can stall a run, which is exactly why none of it was
 * ever visible. Here it is.
 */
function DeliveryReadout({ reach }) {
  const items = reach.items ?? [];
  if (!items.length) return null;
  const attempted = items.filter((r) => (r.delivery ?? []).length);
  const undelivered = items.length - attempted.length;
  const failures = attempted.flatMap((r) => (r.delivery ?? []).filter((d) => d.outcome !== 'sent'));

  return html`
    <div class="notify-lane">
      <div class="grow">
        <strong>What has been reaching you</strong>
        <p class="muted small" style="margin:2px 0 0">
          Of the last ${items.length} announcement${items.length === 1 ? '' : 's'},
          ${' '}${attempted.length} went to a device${undelivered
            ? ` and ${undelivered} reached no device at all — those exist only in the inbox`
            : ''}.
          ${failures.length ? html`
            <br />
            <span style="color:var(--line-blocked)">
              ${failures.length} handover${failures.length === 1 ? '' : 's'} did not succeed:
              ${' '}${[...new Set(failures.map((f) => `${f.label} · ${f.outcome}`))].join(', ')}.
            </span>` : null}
        </p>
      </div>
    </div>`;
}
