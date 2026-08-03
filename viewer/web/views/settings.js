/** Settings and what the console is reading. */

import { html, useState, useEffect, useCallback } from '../html.js';
import { navigate } from '../router.js';
import { api } from '../api.js';
import { usePrefs, toast } from '../store.js';
import { KeyValue, Banner, weight } from '../components/ui.js';
import { RestartButton } from '../components/restart.js';

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
/**
 * The rule forms, and what each one builds.
 *
 * A free-text box alone is what the card used to be, and it assumes the writer
 * remembers that `:*` only works at the end, that `ls *` and `ls*` are
 * different rules, and that `Write(…)` paths are silently ignored. Almost
 * nobody does. The builder makes the common forms unmissable and keeps the
 * escape hatch for everything else.
 */
const FORMS = [
  {
    id: 'prefix',
    label: 'Command prefix',
    tool: 'Bash',
    placeholder: 'git commit',
    build: (tool, value) => `${tool}(${value}:*)`,
    hint: 'Matches the command and anything after it, at a word boundary. Bash(ls:*) is Bash(ls *) — it does not match lsof.',
  },
  {
    id: 'glob',
    label: 'Command glob',
    tool: 'Bash',
    placeholder: 'npm run test *',
    build: (tool, value) => `${tool}(${value})`,
    hint: '* spans anything. Mind the space: `ls *` is not `ls*`.',
  },
  {
    id: 'tool',
    label: 'A whole tool',
    tool: 'WebFetch',
    placeholder: '',
    build: (tool) => tool,
    hint: 'Every use of that tool. As a deny rule, this removes the tool from the session entirely.',
  },
  {
    id: 'param',
    label: 'One parameter',
    tool: 'Agent',
    placeholder: 'model:opus',
    build: (tool, value) => `${tool}(${value})`,
    hint: 'One parameter per rule; * is allowed in the value. Bash(command:…) is NOT one of these — it is ignored.',
  },
  {
    id: 'path',
    label: 'A path',
    tool: 'Read',
    placeholder: '~/.ssh/**',
    build: (tool, value) => `${tool}(${value})`,
    hint: '//abs · ~/home · ./cwd · a bare name means anywhere, so Read(.env) is Read(**/.env). Only Read(…) and Edit(…) are consulted.',
  },
  {
    id: 'domain',
    label: 'A web domain',
    tool: 'WebFetch',
    placeholder: '*.example.com',
    build: (tool, value) => `${tool}(domain:${value})`,
    hint: '*.example.com covers subdomains of it, not the bare domain.',
  },
  {
    id: 'mcp',
    label: 'An MCP server or tool',
    tool: 'mcp__server',
    placeholder: '',
    build: (tool) => tool,
    hint: 'mcp__server covers everything it exposes; mcp__server__tool is one of them.',
  },
  {
    id: 'agent',
    label: 'A subagent type',
    tool: 'Agent',
    placeholder: 'Explore',
    build: (tool, value) => `${tool}(${value})`,
    hint: 'The agent type as it is dispatched.',
  },
  {
    id: 'cd',
    label: 'A directory',
    tool: 'Cd',
    placeholder: '~/code/**',
    build: (tool, value) => `${tool}(${value})`,
    hint: '~/code/* is one segment deep; ~/code/** is any depth.',
  },
  {
    id: 'free',
    label: 'Write it myself',
    tool: '',
    placeholder: 'Bash(task deploy:*)',
    build: (tool, value) => value,
    hint: 'Anything the syntax accepts. Checked before it is written.',
  },
];

const LIST_NOTE = {
  deny: 'the wall — enforced by the CLI, holds with this console dead',
  ask: 'raises a card and waits — via the hook, which fails open',
  allow: 'runs unasked, and outranks the ask list when you wrote it',
};

/**
 * What an unattended session is allowed to do, and — the part that matters —
 * which layer actually stops it.
 *
 * These lists look alike and are nothing alike. `deny` is evaluated inside the
 * CLI with no network involved, and was measured holding with this console
 * unreachable: it is the wall. `ask` goes through the HTTP hook, and that hook
 * **fails open** — with nothing listening the tool call simply proceeds.
 * Showing them as one list would be the most dangerous thing this page could
 * do, so the difference is the first thing said about each.
 */
function PolicyCard({ allowWrites }) {
  const [policy, setPolicy] = useState(null);
  const [plans, setPlans] = useState([]);
  const [scope, setScope] = useState('global');
  const [slug, setSlug] = useState('');
  const [form, setForm] = useState(FORMS[0]);
  const [tool, setTool] = useState(FORMS[0].tool);
  const [value, setValue] = useState('');
  const [list, setList] = useState('ask');
  const [busy, setBusy] = useState(false);
  const [showTraps, setShowTraps] = useState(false);

  const load = useCallback(async (forSlug) => {
    try { setPolicy(await api.policy(forSlug || undefined)); } catch { /* the card stays hidden */ }
  }, []);
  useEffect(() => { void load(slug); }, [load, slug]);
  useEffect(() => {
    api.plans().then((all) => setPlans(all.map((p) => p.slug))).catch(() => {});
  }, []);

  if (!policy) return null;

  const rule = form.build(tool.trim(), value.trim()).trim();
  const planScope = scope === 'plan';
  const targetKnown = !planScope || Boolean(slug);
  // Only rules that are actually in a file can be taken out of one. A shipped
  // default has no line to delete, and offering a Remove that silently does
  // nothing is worse than not offering it.
  const mine = (name) => (planScope
    ? policy.plan?.extra?.[name] ?? []
    : policy.extra[name] ?? []);

  const write = async (edit, said) => {
    setBusy(true);
    try {
      setPolicy(await api.editPolicy({ scope, slug: slug || null, ...edit }));
      toast(said, 'ok');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  };

  const add = () => {
    if (!rule || !targetKnown) return;
    void write({ add: { [list]: [rule] } }, `Added ${rule} to ${list}${planScope ? ` for ${slug}` : ''}`)
      .then(() => setValue(''));
  };

  const chips = (name) => {
    const own = mine(name);
    return html`
      <div class="row wrap" style="gap:4px;margin-top:var(--s2)">
        ${policy.effective[name].map((r) => {
          const removable = own.includes(r) && allowWrites;
          return html`
            <span key=${r} class=${`chip${own.includes(r) ? ' is-picked' : ''}`}
                  title=${own.includes(r)
                    ? `yours, at ${planScope ? `the ${slug} scope` : 'the global scope'}`
                    : 'shipped default — not removable from here'}>
              ${r}
              ${removable ? html`
                <button class="chip-x" aria-label=${`Remove ${r}`} disabled=${busy}
                        onClick=${() => write({ remove: { [name]: [r] } }, `Removed ${r}`)}>×</button>` : null}
            </span>`;
        })}
        ${policy.effective[name].length ? null : html`<span class="faint">none</span>`}
      </div>`;
  };

  return html`
    <div class="card" style="grid-column:1/-1">
      <div class="card-head">
        <h3>What an unattended session may do</h3>
        <span class="faint" style="font-size:var(--text-xs)">
          yours are highlighted · <code>${planScope && policy.plan ? policy.plan.path : policy.file}</code>
        </span>
      </div>
      <div class="card-body stack">
        <div class="row wrap" style="gap:8px;align-items:flex-end">
          <label class="field">
            <span>These rules apply</span>
            <select value=${scope} disabled=${busy}
                    onChange=${(e) => { setScope(e.target.value); if (e.target.value === 'global') setSlug(''); }}>
              <option value="global">everywhere</option>
              <option value="plan">to one plan only</option>
            </select>
          </label>
          ${planScope ? html`
            <label class="field">
              <span>Plan</span>
              <select value=${slug} disabled=${busy} onChange=${(e) => setSlug(e.target.value)}>
                <option value="">choose a plan…</option>
                ${plans.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
              </select>
            </label>` : null}
        </div>

        ${planScope && slug ? html`
          <p class="faint" style="font-size:var(--text-xs)">
            Showing the global rules plus <code>${slug}</code>'s own. Highlighted chips are the
            plan's; global ones are edited by switching the scope above.
          </p>` : null}

        <div>
          <strong>Denied — the wall.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            Evaluated inside the CLI, with no network involved. Verified to hold with this console
            stopped. Nothing can approve past it; you run these yourself, deliberately.
          </span>
          ${chips('deny')}
        </div>

        <div>
          <strong>Asked — the workflow.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            These raise a card and wait for you. They go through the HTTP hook, and that hook
            <b>fails open</b>: if this console is not running, the call proceeds unasked. Useful,
            and never the thing to rely on for anything that must not happen.
          </span>
          ${chips('ask')}
        </div>

        <div>
          <strong>Allowed.</strong>
          <span class="faint" style="font-size:var(--text-xs)">
            Never round-trip to the hook. The shipped ones are read-only work a phase does
            constantly; the ones <b>you</b> add also outrank the ask list, which is what makes
            “Always allow this” on a card actually stop the asking.
          </span>
          ${chips('allow')}
        </div>

        ${policy.inert?.length ? html`
          <${Banner} kind="warn">
            <strong>These parse and do nothing.</strong>
            <ul style="margin:6px 0 0;padding-left:18px">
              ${policy.inert.map((r) => html`
                <li key=${r.raw}><code>${r.raw}</code> — ${r.note}</li>`)}
            </ul>
          </${Banner}>` : null}

        ${allowWrites ? html`
          <div class="stack" style="gap:var(--s2)">
            <strong>Add a rule</strong>
            <div class="row wrap" style="gap:8px;align-items:flex-end">
              <label class="field">
                <span>Form</span>
                <select value=${form.id} disabled=${busy}
                        onChange=${(e) => {
                          const next = FORMS.find((f) => f.id === e.target.value);
                          setForm(next); setTool(next.tool); setValue('');
                        }}>
                  ${FORMS.map((f) => html`<option key=${f.id} value=${f.id}>${f.label}</option>`)}
                </select>
              </label>
              ${form.id !== 'free' ? html`
                <label class="field">
                  <span>Tool</span>
                  <input class="mono" value=${tool} disabled=${busy} spellcheck="false"
                         list="policy-tools" onInput=${(e) => setTool(e.target.value)} />
                </label>` : null}
              ${form.placeholder ? html`
                <label class="field grow">
                  <span>${form.id === 'free' ? 'Rule' : 'Value'}</span>
                  <input class="mono" value=${value} placeholder=${form.placeholder}
                         disabled=${busy} spellcheck="false"
                         onInput=${(e) => setValue(e.target.value)}
                         onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} />
                </label>` : null}
              <label class="field">
                <span>to</span>
                <select value=${list} disabled=${busy} onChange=${(e) => setList(e.target.value)}>
                  <option value="deny">deny — never, whatever I click</option>
                  <option value="ask">ask — stop and show me</option>
                  <option value="allow">allow — stop asking about it</option>
                </select>
              </label>
            </div>

            <datalist id="policy-tools">
              ${[...new Set([...(policy.hookTools ?? []), ...(policy.seen ?? []),
                'Read', 'Edit', 'Write', 'Agent', 'Cd', 'Glob', 'Grep', 'NotebookEdit',
                'WebFetch', 'WebSearch', 'TodoWrite'])]
                .map((t) => html`<option key=${t} value=${t}></option>`)}
            </datalist>

            <p class="faint" style="font-size:var(--text-xs)">${form.hint}</p>

            ${policy.seen?.length ? html`
              <div class="row wrap" style="gap:4px;align-items:center">
                <span class="faint" style="font-size:var(--text-xs)">Tools this console has been asked about:</span>
                ${policy.seen.map((t) => html`
                  <button key=${t} class="chip is-clickable" disabled=${busy}
                          onClick=${() => setTool(t)}>${t}</button>`)}
              </div>` : null}

            <div class="row wrap" style="gap:8px;align-items:center">
              <code class="rule-preview">${rule || '—'}</code>
              <button class="btn" disabled=${busy || !rule || !targetKnown} onClick=${add}>
                ${busy ? 'Writing…' : planScope ? `Add for ${slug || 'a plan'}` : 'Add everywhere'}
              </button>
            </div>
            ${!targetKnown ? html`
              <p class="faint" style="font-size:var(--text-xs)">Choose a plan first.</p>` : null}

            <${Banner} kind=${list === 'allow' ? 'warn' : 'info'}>
              ${list === 'allow'
                ? html`<span><strong>This widens what an unattended run may do.</strong> It is written
                  with your name on it, recorded in the live run's journal, and removable with the ×
                  on its chip. <code>deny</code> still refuses it whatever this says.</span>`
                : html`<span>Adding to <code>deny</code> or <code>ask</code> makes a run more careful.
                  Shipped defaults cannot be removed from here — only rules you added.</span>`}
            </${Banner}>

            <button class="linkish small" onClick=${() => setShowTraps(!showTraps)}
                    aria-expanded=${showTraps}>
              ${showTraps ? '▾' : '▸'} How these are evaluated (the parts that surprise people)
            </button>
            ${showTraps ? html`
              <ul class="faint" style="font-size:var(--text-xs);padding-left:18px;margin:0">
                <li><b>deny → allow-you-wrote → ask → allow.</b> First match wins and specificity is
                  irrelevant — a more specific rule does not beat an earlier one.</li>
                <li>Wrappers are seen through: <code>timeout time nice nohup stdbuf command builtin
                  noglob</code> and bare <code>xargs</code>. <b>Not</b>
                  ${(policy.wrappersNotStripped ?? []).map((w) => html` <code>${w}</code>`)} — a rule
                  about what those run will not fire.</li>
                <li><code>watch</code>, <code>setsid</code>, <code>flock</code> and
                  <code>find -exec</code> never auto-approve: what they actually run cannot be seen
                  from the outside, so they get a card.</li>
                <li>Only <code>Read(…)</code> and <code>Edit(…)</code> path rules are consulted.
                  <code>Write(…)</code>, <code>NotebookEdit(…)</code> and <code>Glob(…)</code> paths
                  are ignored.</li>
                <li><code>Bash(command:rm *)</code> looks like a parameter rule and is dropped.</li>
                <li>Only ${(policy.hookTools ?? []).map((t) => html`<code>${t}</code> `)} reach this
                  console's hook. Rules about anything else are real, but the CLI enforces them and
                  nothing here can show you them being hit.</li>
              </ul>` : null}
          </div>` : html`
          <p class="faint" style="font-size:var(--text-xs)">
            Restart with <code>--allow-writes</code> to edit rules here, or edit
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
            <h3>Notifications</h3>
            <button class="btn small" onClick=${() => navigate('notifications/settings')}>Open</button>
          </div>
          <div class="card-body stack">
            <p class="muted small" style="margin:0">
              Devices, categories and the delivery test now live on their own page, beside the
              inbox of everything the console has announced — including the ones that arrived
              while nothing was open to hear them.
            </p>
            <p class="muted small" style="margin:0">
              <code>${'PHASE_CONSOLE_NOTIFY=<command>'}</code> is run with the title and body of
              every one of them, for a machine with no browser in the picture at all.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>This process</h3>
          </div>
          <div class="card-body stack">
            <${KeyValue} items=${[
              ['Server code', state.serverStale
                ? html`<span style="color:var(--line-ready)">older than what is on disk</span>`
                : 'current with what is on disk'],
              ['Supervisor', state.supervisor?.detail ?? 'unknown'],
            ]} />
            <${RestartButton} state=${state} verbose=${false} />
            <p class="faint" style="font-size:var(--text-xs);margin:0">
              Node reads <code>server/</code> once, at startup. Reloading the page reloads the
              client and nothing else, so a server fix you already have looks like it did not
              work until this process is replaced.
            </p>
          </div>
        </div>

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
