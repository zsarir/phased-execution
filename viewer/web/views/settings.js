/** Settings and what the console is reading. */

import { html, useState, useEffect, useCallback } from '../html.js';
import { navigate } from '../router.js';
import { api } from '../api.js';
import { usePrefs, toast } from '../store.js';
import { KeyValue, Banner, weight } from '../components/ui.js';

const MODELS = ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'];

/**
 * What an unattended session is allowed to do, and — the part that matters —
 * which layer actually stops it.
 *
 * These two lists look alike and are nothing alike. `deny` is evaluated inside
 * the CLI with no network involved, and was measured holding with this console
 * unreachable: it is the wall. `ask` goes through the HTTP hook, and that hook
 * **fails open** — with nothing listening the tool call simply proceeds. Showing
 * them as one list would be the most dangerous thing this page could do, so the
 * difference is the first thing said about each.
 */
function PolicyCard({ allowWrites }) {
  const [policy, setPolicy] = useState(null);
  const [rule, setRule] = useState('');
  const [kind, setKind] = useState('deny');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setPolicy(await api.policy()); } catch { /* the card stays hidden */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!policy) return null;

  const add = async () => {
    const text = rule.trim();
    if (!text) return;
    setBusy(true);
    try {
      setPolicy(await api.addPolicy({ [kind]: [text] }));
      setRule('');
      toast(`Added to the ${kind} list`, 'ok');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  };

  const list = (rules, extra) => html`
    <div class="row wrap" style="gap:4px;margin-top:var(--s2)">
      ${rules.map((r) => html`
        <span key=${r} class=${`chip${extra.includes(r) ? ' is-picked' : ''}`}
              title=${extra.includes(r) ? 'yours' : 'shipped default'}>${r}</span>`)}
    </div>`;

  return html`
    <div class="card" style="grid-column:1/-1">
      <div class="card-head">
        <h3>What an unattended session may do</h3>
        <span class="faint" style="font-size:var(--text-xs)">
          yours are highlighted · <code>${policy.file}</code>
        </span>
      </div>
      <div class="card-body stack">
        <div>
          <strong>Denied — the wall.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            Evaluated inside the CLI, with no network involved. Verified to hold with this console
            stopped. Nothing can approve past it; you run these yourself, deliberately.
          </span>
          ${list(policy.effective.deny, policy.extra.deny)}
        </div>

        <div>
          <strong>Asked — the workflow.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            These raise a card and wait for you. They go through the HTTP hook, and that hook
            <b>fails open</b>: if this console is not running, the call proceeds unasked. Useful,
            and never the thing to rely on for anything that must not happen.
          </span>
          ${list(policy.effective.ask, policy.extra.ask)}
        </div>

        <div>
          <strong>Pre-approved reads.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            Never round-trip to the hook. A queue that fills with <code>find docs -type f</code> is
            a queue nobody reads, and one nobody reads trains the answer “yes”.
          </span>
          ${list(policy.effective.allow, policy.extra.allow)}
        </div>

        ${allowWrites ? html`
          <div class="row wrap" style="gap:8px;align-items:flex-end">
            <label class="field">
              <span>Add a rule</span>
              <input value=${rule} placeholder="Bash(task deploy:*)" disabled=${busy}
                     onInput=${(e) => setRule(e.target.value)}
                     onKeyDown=${(e) => { if (e.key === 'Enter') void add(); }} />
            </label>
            <label class="field">
              <span>to</span>
              <select value=${kind} onChange=${(e) => setKind(e.target.value)} disabled=${busy}>
                <option value="deny">deny — never, whatever I click</option>
                <option value="ask">ask — stop and show me</option>
              </select>
            </label>
            <button class="btn" disabled=${busy || !rule.trim()} onClick=${add}>
              ${busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          <${Banner} kind="info">
            Only these two lists can be added to from here, and rules can only be added — both
            directions that make a run <em>more</em> careful. Widening what an agent may do at 3am,
            or removing a rule, means editing <code>${policy.file}</code> yourself.
          </${Banner}>` : html`
          <p class="faint" style="font-size:var(--text-xs)">
            Restart with <code>--allow-writes</code> to add rules here, or edit
            <code>${policy.file}</code> directly.
          </p>`}
      </div>
    </div>`;
}

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

        <${PolicyCard} allowWrites=${state.allowWrites} />

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
