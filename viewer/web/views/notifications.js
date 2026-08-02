/**
 * The notifications card.
 *
 * Two things share this space and they are genuinely different, so the card
 * says which is which rather than presenting one switch called "notifications":
 *
 *   in this tab — the Notification API, free, instant, and gone with the tab.
 *   on this device — a push subscription, which arrives with nothing open.
 *
 * The distinction is the whole reason someone comes to this card. Being told
 * about a halted run at 3am and being told about it when you next look at the
 * console are not the same feature, and only one of them needs a service worker
 * and a signing key.
 */

import { html, useState, useEffect, useCallback } from '../html.js';
import { fresh } from '../api.js';
import { toast } from '../store.js';
import { notifyState, askToNotify } from '../notify.js';
import {
  blocker, currentEndpoint, describeBrowser, disable, enable, iosNeedsInstall, sendTest, setCategories,
} from '../push.js';

export function NotificationsCard() {
  const [state, setState] = useState(null);
  const [endpoint, setEndpoint] = useState(null);
  const [busy, setBusy] = useState('');
  const [inTab, setInTab] = useState(notifyState());

  const load = useCallback(async () => {
    try {
      const [next, mine] = await Promise.all([fresh('/api/push'), currentEndpoint()]);
      setState(next);
      setEndpoint(mine);
    } catch { /* the card degrades to its unavailable state */ }
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
                          toast(result.ok ? `Sent — ${result.detail}` : `Not sent — ${result.detail}`,
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

        <p class="muted small" style="margin:0">
          For a machine with no browser in the picture at all,
          ${' '}<code>${'PHASE_CONSOLE_NOTIFY=<command>'}</code>${' '}
          is run with the title and body of every one of these.
        </p>
      </div>
    </div>`;
}
