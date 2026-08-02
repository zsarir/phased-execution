/** Phase Console — client entry: shell, rail, routing and live refresh. */

import { html, render, useState, useEffect, useCallback } from './html.js';
import { api, subscribe, clearCache } from './api.js';
import { useRoute, navigate } from './router.js';
import { usePrefs, useToasts, applyTheme, getPrefs } from './store.js';
import { Spinner, Banner } from './components/ui.js';

import { SourceView } from './views/source.js';
import { PlansView } from './views/plans.js';
import { PlanView } from './views/plan.js';
import { ReadyView } from './views/ready.js';
import { StatsView } from './views/stats.js';
import { SearchView } from './views/search.js';
import { SettingsView } from './views/settings.js';

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
  const current = route.segments[0] ?? 'plans';

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
        ${item('ready', 'Ready now', counts.ready, counts.ready > 0)}
        ${item('plans', 'Plans', counts.plans)}
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
        <button class="nav-item" onClick=${() => navigate('settings')} aria-current=${current === 'settings' ? 'page' : null}>Settings</button>
      </div>
    </nav>`;
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

  // Live: the server tells us which plans changed; drop their cache and redraw.
  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === '/') { event.preventDefault(); navigate('search'); }
      else if (event.key === 'r') navigate('ready');
      else if (event.key === 'p') navigate('plans');
      else if (event.key === 's') navigate('stats');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) {
    return html`<div class="page" style="display:grid;place-items:center;height:100%"><${Spinner} label="Starting" /></div>`;
  }

  const needsSource = !state.root?.ok || route.segments[0] === 'source';
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
  };

  const [head, ...rest] = route.segments;
  let view;
  if (head === 'plan') view = html`<${PlanView} slug=${rest[0]} tab=${rest[1]} arg=${rest[2]} state=${state} />`;
  else if (head === 'ready') view = html`<${ReadyView} plans=${plans} state=${state} />`;
  else if (head === 'stats') view = html`<${StatsView} state=${state} />`;
  else if (head === 'search') view = html`<${SearchView} query=${route.query.q ?? ''} />`;
  else if (head === 'settings') view = html`<${SettingsView} state=${state} onChanged=${() => setTick((n) => n + 1)} />`;
  else view = html`<${PlansView} plans=${plans} state=${state} />`;

  return html`
    <div class="app">
      <${Rail} state=${state} counts=${counts} route=${route} onPickSource=${() => navigate('source')} />
      <main class="main">
        ${error ? html`<div class="page"><${Banner} kind="error">${error}</${Banner}></div>` : view}
      </main>
    </div>
    <${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
