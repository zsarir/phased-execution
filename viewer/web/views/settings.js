/** Settings and what the console is reading. */

import { html } from '../html.js';
import { navigate } from '../router.js';
import { usePrefs } from '../store.js';
import { KeyValue, weight } from '../components/ui.js';

const MODELS = ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'];

export function SettingsView({ state }) {
  const [prefs, setPrefs] = usePrefs();

  return html`
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Phase Console</div>
          <h1>Settings</h1>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head">
            <h3>Source</h3>
            <button class="btn small" onClick=${() => navigate('source')}>Change</button>
          </div>
          <div class="card-body">
            <${KeyValue} items=${[
              ['Directory', html`<code>${state.root?.path}</code>`],
              ['Plans', `${state.root?.planCount} files in docs/plans`],
              ['Handoff folders', String(state.root?.handoffCount ?? 0)],
              ['Repository', state.repo?.available
                ? html`<span>${state.repo.branch}${state.repo.ahead ? ` · ${state.repo.ahead} ahead` : ''}${state.repo.behind ? ` · ${state.repo.behind} behind` : ''}</span>`
                : 'not a git repository'],
              ['Uncommitted under docs/', state.repo?.dirty?.length
                ? html`<span class="mono" style="font-size:var(--text-xs)">${state.repo.dirty.slice(0, 6).join(', ')}${state.repo.dirty.length > 6 ? ` +${state.repo.dirty.length - 6}` : ''}</span>`
                : 'none'],
              ['Indexed sections', String(state.searchDocs ?? 0)],
            ]} />
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Engine</h3></div>
          <div class="card-body">
            <${KeyValue} items=${[
              ['Scripts', html`<code>${state.scriptsDir}</code>`],
              ['Writes', state.allowWrites
                ? 'enabled — scaffolds, QA records and locks'
                : html`<span>read-only · restart with <code>--allow-writes</code></span>`],
              ['Phase weights', `S ${weight(state.sizing?.S)} · M ${weight(state.sizing?.M)} · L ${weight(state.sizing?.L)}`],
              ['Session budgets', `1M-class ${weight(state.sizing?.budgetBig)} · 200K-class ${weight(state.sizing?.budgetHaiku)}`],
            ]} />
            <p class="faint" style="font-size:var(--text-xs);margin-top:var(--s3)">
              Status, session batches, boot prompts and lint always come from these scripts. The console
              parses the markdown only for the parts they do not expose.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Appearance</h3></div>
          <div class="card-body stack">
            <div class="row" style="justify-content:space-between">
              <span>Theme</span>
              <div class="btn-group">
                ${[['system', 'Auto'], ['dark', 'Night'], ['light', 'Paper']].map(([value, label]) => html`
                  <button key=${value} class="btn small" aria-pressed=${String(prefs.theme === value)}
                    onClick=${() => setPrefs({ theme: value })}>${label}</button>`)}
              </div>
            </div>
            <div class="row" style="justify-content:space-between">
              <span>Show documents in the plan list</span>
              <button class="btn small" aria-pressed=${String(prefs.showDocuments)}
                onClick=${() => setPrefs({ showDocuments: !prefs.showDocuments })}>
                ${prefs.showDocuments ? 'Shown' : 'Hidden'}
              </button>
            </div>
            <div class="row" style="justify-content:space-between">
              <span>Session plan model</span>
              <select value=${prefs.model} onChange=${(event) => setPrefs({ model: event.target.value })}>
                ${MODELS.map((model) => html`<option key=${model} value=${model}>${model || "each plan's own target"}</option>`)}
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Keyboard</h3></div>
          <div class="card-body">
            <${KeyValue} items=${[
              ['/', 'search'],
              ['r', 'ready now'],
              ['p', 'plans'],
              ['s', 'statistics'],
              ['Esc', 'close a dialog'],
            ]} />
          </div>
        </div>
      </div>
    </div>`;
}
