/** Phase Console — client entry: shell, rail, routing and live refresh. */

import { html, render, useState, useEffect, useCallback } from './html.js';
import { api, subscribe, subscribeRun, subscribeNotifications, clearCache } from './api.js';
import { useRoute, navigate } from './router.js';
import { usePrefs, useToasts, applyTheme, getPrefs } from './store.js';
import { syncSuppression } from './push.js';
import { announce } from './notify.js';
import { Spinner, Banner, useMediaQuery, useTouch, useTapTitles } from './components/ui.js';
import { RestartButton } from './components/restart.js';

import { SourceView } from './views/source.js';
import { PlansView } from './views/plans.js';
import { PlanView } from './views/plan.js';
import { ReadyView } from './views/ready.js';
import { StatsView } from './views/stats.js';
import { SearchView } from './views/search.js';
import { SettingsView } from './views/settings.js';
import { RunsView } from './views/run.js';
import { GuideView } from './views/guide.js';
import { DashboardView } from './views/dashboard.js';
import { NotificationsView } from './views/notifications.js';

function RouteGlyph() {
  return html`
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 22h8l6-12h8" fill="none" stroke="var(--track)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="5" cy="22" r="3.2" fill="var(--line-done)" />
      <circle cx="13" cy="22" r="3.2" fill="var(--line-done)" />
      <circle cx="27" cy="10" r="3.2" fill="none" stroke="var(--line-ready)" stroke-width="2.5" />
    </svg>`;
}

function Rail({ state, counts, route, onPickSource }) {
  const [prefs, setPrefs] = usePrefs();
  const current = route.segments[0] || 'dashboard';

  const item = (id, label, count, hot) => html`
    <button
      class="nav-item"
      aria-current=${current === id ? 'page' : null}
      onClick=${() => navigate(id)}>
      <span>${label}</span>
      ${count != null ? html`<span class=${`count ${hot ? 'hot' : ''}`}>${count}</span>` : null}
    </button>`;

  return html`
    <nav class="rail">
      <div class="brand">
        <${RouteGlyph} />
        <div>
          <div class="brand-name">Phase</div>
          <div class="brand-sub">console</div>
        </div>
      </div>

      <div class="nav">
        ${item('dashboard', 'Dashboard')}
        ${item('ready', 'Ready now', counts.ready, counts.ready > 0)}
        ${item('plans', 'Plans', counts.plans)}
        ${item('runs', 'Runs', counts.approvals || null, counts.approvals > 0)}
        ${item('notifications', 'Notifications', counts.unread || null, counts.unread > 0)}
        ${item('stats', 'Statistics')}
        ${item('search', 'Search')}
      </div>

      <div class="rail-section-title">Source</div>
      <button
        class="source-chip"
        onClick=${onPickSource}
        title=${`${state.root?.path ?? ''}\nClick to open a different directory`}>
        <span class="spread">
          <span class="label truncate">${state.root?.label ?? 'Choose a directory'}</span>
          <span class="tag">Change</span>
        </span>
        <span class="path">${state.root?.path ?? 'no source open'}</span>
        <span class="row" style="gap:6px;margin-top:4px">
          <span class="tag">${counts.plans} plans</span>
          <span class="tag">${counts.phases} phases</span>
        </span>
      </button>

      <div class="rail-footer">
        ${!state.allowWrites ? html`<span class="tag" title="Start with --allow-writes to enable scaffolding, QA records and locks">read-only</span>` : html`<span class="tag" style="color:var(--line-ready)">writes enabled</span>`}
        <div class="row" style="gap:4px">
          <div class="btn-group" role="group" aria-label="Theme">
            ${[['system', 'Auto'], ['dark', 'Night'], ['light', 'Paper']].map(([value, label]) => html`
              <button
                key=${value}
                class="btn small"
                aria-pressed=${String(prefs.theme === value)}
                onClick=${() => setPrefs({ theme: value })}>${label}</button>`)}
          </div>
        </div>
        <button class="nav-item" onClick=${() => navigate('guide')} aria-current=${current === 'guide' ? 'page' : null}>Guide</button>
        <button class="nav-item" onClick=${() => navigate('settings')} aria-current=${current === 'settings' ? 'page' : null}>Settings</button>
      </div>
    </nav>`;
}

/* ------------------------------------------------------------------ *
 * The phone shell
 *
 * The rail did not fold onto a phone, it was *folded away*: below 900px it
 * became a horizontally scrolling strip of links with `.rail-footer` set to
 * `display: none` — and the footer is where Guide, Settings and the theme
 * switcher lived. Notifications are turned on in Settings, so the one page you
 * needed on the phone was the one page the phone could not reach.
 *
 * What replaces it is the shape a phone already knows: a bar along the bottom
 * for the four places you go, the inbox where an app puts its bell, and a sheet
 * for everything else. Nothing is hidden — every route in the app is one or two
 * taps from anywhere.
 * ------------------------------------------------------------------ */

const GLYPH = {
  dashboard: html`<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z" />`,
  ready: html`<path d="M13 3 5 14h6l-1 7 8-11h-6z" />`,
  plans: html`<path d="M5 4h9l5 5v11H5z" /><path d="M14 4v5h5" />`,
  runs: html`<path d="M3 12h4l3-8 4 16 3-8h4" />`,
  more: html`<path d="M5 12h.01M12 12h.01M19 12h.01" />`,
  bell: html`<path d="M18 15V10a6 6 0 0 0-12 0v5l-2 3h16z" /><path d="M10 21h4" />`,
};

function Glyph({ name }) {
  return html`
    <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"
         fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round">${GLYPH[name]}</svg>`;
}

/** The four you go to; everything else is the bell or the sheet. */
const TABS = [
  ['dashboard', 'Home'],
  ['ready', 'Ready'],
  ['plans', 'Plans'],
  ['runs', 'Runs'],
];

const SHEET_LINKS = [
  ['notifications', 'Notifications', 'Everything the console has announced'],
  ['stats', 'Statistics', 'Throughput, cost and the shape of the portfolio'],
  ['search', 'Search', 'Every plan, handoff and phase at once'],
  ['guide', 'Guide', 'How the runner works, and the phone setup'],
  ['settings', 'Settings', 'Notifications, permission rules, devices'],
];

function TopBar({ state, counts, route, onPickSource }) {
  const current = route.segments[0] || 'dashboard';
  return html`
    <header class="topbar">
      <button class="topbar-brand" onClick=${() => navigate('dashboard')} aria-label="Phase Console — dashboard">
        <${RouteGlyph} />
        <span class="brand-name">Phase</span>
      </button>

      <button
        class="topbar-source"
        onClick=${onPickSource}
        title=${`${state.root?.path ?? ''}\nTap to open a different directory`}>
        <span class="truncate">${state.root?.label ?? 'Choose a directory'}</span>
      </button>

      <button
        class="topbar-bell"
        aria-current=${current === 'notifications' ? 'page' : null}
        onClick=${() => navigate('notifications')}
        aria-label=${counts.unread ? `Notifications, ${counts.unread} unread` : 'Notifications'}>
        <${Glyph} name="bell" />
        ${counts.unread ? html`<span class="badge">${counts.unread > 99 ? '99+' : counts.unread}</span>` : null}
      </button>
    </header>`;
}

function TabBar({ counts, route, moreOpen, onMore }) {
  const head = route.segments[0] || 'dashboard';
  // A plan page is somewhere you arrived from Plans, so Plans stays lit while
  // you are on one — a tab bar that goes dark whenever you go deeper reads as
  // though you have left the app.
  const current = head === 'plan' ? 'plans' : head;
  const badge = { ready: counts.ready, runs: counts.approvals };

  return html`
    <nav class="tabbar" aria-label="Main">
      ${TABS.map(([id, label]) => html`
        <button
          key=${id}
          class="tab-item"
          aria-current=${current === id && !moreOpen ? 'page' : null}
          onClick=${() => navigate(id)}>
          <span class="tab-glyph"><${Glyph} name=${id} />
            ${badge[id] ? html`<span class="badge">${badge[id] > 99 ? '99+' : badge[id]}</span>` : null}
          </span>
          <span class="tab-label">${label}</span>
        </button>`)}
      <button
        class="tab-item"
        aria-expanded=${String(moreOpen)}
        aria-current=${moreOpen ? 'page' : null}
        onClick=${onMore}>
        <span class="tab-glyph"><${Glyph} name="more" /></span>
        <span class="tab-label">More</span>
      </button>
    </nav>`;
}

function MoreSheet({ state, counts, route, onClose, onPickSource }) {
  const [prefs, setPrefs] = usePrefs();
  const current = route.segments[0];

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return html`
    <div class="scrim sheet-scrim" onClick=${(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="More">
        <div class="sheet-grip" aria-hidden="true"></div>

        <div class="sheet-links">
          ${SHEET_LINKS.map(([id, label, note]) => html`
            <button
              key=${id}
              class="sheet-link"
              aria-current=${current === id ? 'page' : null}
              onClick=${() => { navigate(id); onClose(); }}>
              <span class="row">
                <strong>${label}</strong>
                ${id === 'notifications' && counts.unread
                  ? html`<span class="badge inline">${counts.unread}</span>` : null}
              </span>
              <span class="faint">${note}</span>
            </button>`)}
        </div>

        <div class="sheet-row">
          <span class="sheet-label">Source</span>
          <button class="btn" onClick=${() => { onPickSource(); onClose(); }}>
            <span class="truncate">${state.root?.label ?? 'Choose a directory'}</span>
          </button>
        </div>

        <div class="sheet-row">
          <span class="sheet-label">Theme</span>
          <div class="btn-group" role="group" aria-label="Theme">
            ${[['system', 'Auto'], ['dark', 'Night'], ['light', 'Paper']].map(([value, label]) => html`
              <button
                key=${value}
                class="btn"
                aria-pressed=${String(prefs.theme === value)}
                onClick=${() => setPrefs({ theme: value })}>${label}</button>`)}
          </div>
        </div>

        <div class="sheet-row">
          <span class="sheet-label">Writes</span>
          ${state.allowWrites
            ? html`<span class="tag" style="color:var(--line-ready)">enabled</span>`
            : html`<span class="tag" title="Start with --allow-writes to enable scaffolding, QA records and locks">read-only</span>`}
        </div>

        <button class="btn sheet-close" onClick=${onClose}>Close</button>
      </div>
    </div>`;
}

function Toasts() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return html`
    <div class="toast-stack" role="status" aria-live="polite">
      ${toasts.map((item) => html`
        <div class=${`toast ${item.kind}`} key=${item.id}>
          <span class="dot" style="width:7px;height:7px;border-radius:50%;background:var(--line-done)"></span>
          ${item.message}
        </div>`)}
    </div>`;
}

function App() {
  const route = useRoute();
  const [state, setState] = useState(null);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [unread, setUnread] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  // 900px is where the rail stops fitting beside the page. Below it the shell
  // is a different component rather than the same one with things hidden.
  const phone = useMediaQuery('(max-width: 900px)');
  useTapTitles(useTouch());

  // Going anywhere closes the sheet — including "back", which is the gesture a
  // sheet is most often dismissed with.
  useEffect(() => { setMoreOpen(false); }, [route.path]);
  useEffect(() => { if (!phone) setMoreOpen(false); }, [phone]);

  const reload = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      if (next.root?.ok) setPlans(await api.plans());
      setError(null);
    } catch (failure) {
      setError(String(failure.message ?? failure));
    }
  }, []);

  useEffect(() => { applyTheme(getPrefs().theme); }, []);
  useEffect(() => { void reload(); }, [reload, tick]);

  // If a service worker is already covering this browser, the page must not
  // also raise its own copy of every notification. Asked once, on boot.
  useEffect(() => { void syncSuppression(); }, []);

  // Live: the server tells us which plans changed; drop their cache and redraw.
  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);

  // A session parked on an approval is invisible until someone looks, so the
  // badge is kept current from wherever you happen to be in the app.
  useEffect(() => {
    // Nothing to poll on a server that predates the runner — asking anyway just
    // fills the browser console with 404s.
    if (!state?.autopilot) return undefined;
    let alive = true;
    const count = async () => {
      try {
        const queue = await api.approvals();
        if (alive) setPendingApprovals(queue.filter((a) => a.status === 'pending').length);
      } catch { /* transient — the badge is not worth a toast */ }
    };
    void count();
    // `approval:resolved` matters as much as `approval` here: a card answered
    // on a phone has to take the badge down on the laptop, and creation was the
    // only event that ever fired.
    const unsubscribe = subscribeRun({ approval: count, approvalResolved: count, run: count });
    return () => { alive = false; unsubscribe(); };
  }, [state?.autopilot]);

  /**
   * The in-tab notification leg — the only one, and it lives in the shell.
   *
   * It used to be wired inside the run view alone, so the console could raise a
   * notification about a run exactly when you were already looking at that run.
   * Every other page — and every closed tab — got nothing. Here it follows the
   * server's own announcements, so what you are told, what a subscribed device
   * is told, and what the inbox holds are the same three facts with the same
   * wording and the same destination.
   */
  useEffect(() => subscribeNotifications({
    notification: (record) => { announce(record); setUnread((n) => n + 1); },
    read: (data) => setUnread(data?.unread ?? 0),
    cleared: (data) => setUnread(data?.unread ?? 0),
  }), []);

  useEffect(() => { setUnread(state?.unread ?? 0); }, [state?.unread]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === '/') { event.preventDefault(); navigate('search'); }
      else if (event.key === 'r') navigate('ready');
      else if (event.key === 'p') navigate('plans');
      else if (event.key === 'd') navigate('dashboard');
      else if (event.key === 's') navigate('stats');
      else if (event.key === 'g') navigate('guide');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) {
    return html`<div class="page" style="display:grid;place-items:center;height:100%"><${Spinner} label="Starting" /></div>`;
  }

  // The guide is what you read before you have set anything up, so it is the
  // one view that does not send you to the directory picker first. It still
  // renders inside the rail, so there is always a way onwards from it.
  const needsSource = (!state.root?.ok || route.segments[0] === 'source')
    && route.segments[0] !== 'guide';
  if (needsSource) {
    return html`
      <${SourceView}
        state=${state}
        onOpened=${() => { clearCache(); setTick((n) => n + 1); navigate('plans'); }} />
      <${Toasts} />`;
  }

  const counts = {
    plans: plans.filter((p) => p.kind === 'plan').length,
    phases: plans.reduce((n, p) => n + p.phases, 0),
    ready: plans.reduce((n, p) => n + p.ready.length, 0),
    // A run parked on an approval is the one thing worth interrupting someone
    // for, so it gets a badge on the rail rather than waiting to be discovered.
    approvals: pendingApprovals,
    unread,
  };

  const [head, ...rest] = route.segments;
  let view;
  if (head === 'plan') view = html`<${PlanView} slug=${rest[0]} tab=${rest[1]} arg=${rest[2]} state=${state} />`;
  else if (head === 'runs') view = html`<${RunsView} state=${state} />`;
  else if (head === 'guide') view = html`<${GuideView} state=${state} />`;
  else if (head === 'ready') view = html`<${ReadyView} plans=${plans} state=${state} />`;
  else if (head === 'stats') view = html`<${StatsView} state=${state} />`;
  else if (head === 'search') view = html`<${SearchView} query=${route.query.q ?? ''} />`;
  else if (head === 'notifications') view = html`<${NotificationsView} route=${route} />`;
  else if (head === 'settings') view = html`<${SettingsView} state=${state} onChanged=${() => setTick((n) => n + 1)} />`;
  else if (head === 'plans') view = html`<${PlansView} plans=${plans} state=${state} />`;
  else view = html`<${DashboardView} plans=${plans} state=${state} />`;

  const pickSource = () => navigate('source');

  return html`
    <div class=${`app ${phone ? 'is-phone' : ''}`}>
      ${phone
        ? html`<${TopBar} state=${state} counts=${counts} route=${route} onPickSource=${pickSource} />`
        : html`<${Rail} state=${state} counts=${counts} route=${route} onPickSource=${pickSource} />`}
      <main class="main">
        ${state.serverStale ? html`
          <div class="page" style="padding-bottom:0">
            <${Banner} kind="warn">
              <strong>This console is running older code than is on disk.</strong>
              Node loads the server once, at startup — the page reloads from disk but the process
              cannot. Restart it, or a fix you already have will look like it did not work.
              <div style="margin-top:8px"><${RestartButton} state=${state} /></div>
            </${Banner}>
          </div>` : null}
        ${error ? html`<div class="page"><${Banner} kind="error">${error}</${Banner}></div>` : view}
      </main>
      ${phone ? html`
        <${TabBar} counts=${counts} route=${route} moreOpen=${moreOpen} onMore=${() => setMoreOpen((open) => !open)} />` : null}
    </div>
    ${phone && moreOpen ? html`
      <${MoreSheet}
        state=${state}
        counts=${counts}
        route=${route}
        onClose=${() => setMoreOpen(false)}
        onPickSource=${pickSource} />` : null}
    <${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
