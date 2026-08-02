/**
 * The guarded write verbs.
 *
 * Every action shows the exact script invocation before it runs, and the
 * server refuses all of them unless it was started with `--allow-writes`. The
 * console never commits or pushes — `--git` is not available to it.
 */

import { html, useState, useEffect } from '../html.js';
import { api, clearCache } from '../api.js';
import { toast } from '../store.js';
import { Modal, Banner } from './ui.js';

const OWNER_KEY = 'phase-console.owner';

const FORMS = {
  'new-handoff': {
    title: 'Scaffold a handoff',
    hint: 'Runs new-handoff.sh, which also creates or updates INDEX.md and generates the boot prompts for whatever this phase unblocks.',
    fields: [
      { name: 'title', label: 'Title (kebab-case)', placeholder: 'front-admin-review-console', required: true },
      { name: 'status', label: 'Status', type: 'select', options: ['complete', 'in-progress', 'blocked', 'pending'] },
      { name: 'qa', label: 'Turn QA on for this plan (--qa)', type: 'checkbox' },
      { name: 'force', label: 'Overwrite an existing handoff (--force)', type: 'checkbox' },
    ],
  },
  'qa-record': {
    title: 'Record a QA result',
    hint: 'Writes one row into test-status.md. A recorded fail holds every dependent until it is re-run.',
    fields: [
      { name: 'result', label: 'Result', type: 'select', options: ['pass', 'fail', 'waived', 'pending'] },
      { name: 'report', label: 'Report path (relative)', placeholder: 'reports/phase-08-qa.md', required: true },
    ],
  },
  'lock-claim': {
    title: 'Claim the phase',
    hint: 'Cooperative lock so two sessions never build the same phase. Written locally only — it is not committed or pushed from here.',
    fields: [
      { name: 'owner', label: 'Owner (account/session)', placeholder: 'you@example.com/session-name', required: true, remember: OWNER_KEY },
      { name: 'force', label: 'Take over a live lock (--force)', type: 'checkbox' },
    ],
  },
  'lock-release': {
    title: 'Release the phase',
    hint: 'Clears the lock file. Use this when a session ended without releasing.',
    fields: [
      { name: 'owner', label: 'Owner (account/session)', placeholder: 'you@example.com/session-name', required: true, remember: OWNER_KEY },
    ],
  },
  'new-plan': {
    title: 'Scaffold a plan',
    hint: 'Runs new-plan.sh to create docs/plans/<slug>.md from the template. Fill in the phases yourself — that part is thinking, not scaffolding.',
    fields: [
      { name: 'slug', label: 'Slug (kebab-case)', placeholder: 'customer-tool-requests', required: true },
    ],
  },
};

function WriteDialog({ action, base, onClose, onDone }) {
  const form = FORMS[action];
  const [values, setValues] = useState(() => {
    const initial = {};
    for (const field of form.fields) {
      if (field.type === 'checkbox') initial[field.name] = false;
      else if (field.type === 'select') initial[field.name] = field.options[0];
      else initial[field.name] = field.remember ? (localStorage.getItem(field.remember) ?? '') : '';
    }
    return initial;
  });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [busy, setBusy] = useState(false);

  const payload = { action, ...base, ...values };

  useEffect(() => {
    let live = true;
    setError(null);
    api.write(payload, true)
      .then((result) => { if (live) setPreview(result.command); })
      .catch((failure) => { if (live) { setPreview(null); setError(String(failure.message ?? failure)); } });
    return () => { live = false; };
  }, [JSON.stringify(payload)]);

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.write(payload);
      setOutcome(result);
      for (const field of form.fields) {
        if (field.remember && values[field.name]) localStorage.setItem(field.remember, values[field.name]);
      }
      clearCache();
      toast(result.ok ? 'Done' : 'The script reported a problem', result.ok ? 'ok' : 'error');
      onDone?.();
    } catch (failure) {
      setError(String(failure.message ?? failure));
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${Modal}
      title=${form.title}
      onClose=${onClose}
      footer=${html`
        <div class="row-wrap grow" style="justify-content:space-between">
          <span class="faint" style="font-size:var(--text-xs)">Nothing is committed or pushed.</span>
          <div class="row">
            <button class="btn" onClick=${onClose}>${outcome ? 'Close' : 'Cancel'}</button>
            ${!outcome ? html`
              <button class="btn primary" disabled=${!preview || busy} onClick=${run}>
                ${busy ? 'Running…' : 'Run'}
              </button>` : null}
          </div>
        </div>`}>

      <p class="muted" style="margin:0">${form.hint}</p>

      ${form.fields.map((field) => html`
        <label class="field" key=${field.name} style="align-items:center">
          <span style="min-width:190px;font-family:var(--font-display);font-size:var(--text-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)">
            ${field.label}
          </span>
          ${field.type === 'checkbox' ? html`
            <input
              type="checkbox"
              checked=${values[field.name]}
              onChange=${(event) => setValues({ ...values, [field.name]: event.target.checked })} />`
            : field.type === 'select' ? html`
              <select
                class="grow"
                value=${values[field.name]}
                onChange=${(event) => setValues({ ...values, [field.name]: event.target.value })}>
                ${field.options.map((option) => html`<option key=${option} value=${option}>${option}</option>`)}
              </select>`
              : html`
                <input
                  class="grow mono"
                  placeholder=${field.placeholder ?? ''}
                  value=${values[field.name]}
                  onInput=${(event) => setValues({ ...values, [field.name]: event.target.value })} />`}
        </label>`)}

      ${error ? html`<${Banner} kind="error">${error}</${Banner}>` : null}

      ${preview ? html`
        <div>
          <div class="faint" style="font-size:var(--text-2xs);letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px">
            Will run
          </div>
          <pre class="code wrap">${preview}</pre>
        </div>` : null}

      ${outcome ? html`
        <div>
          <${Banner} kind=${outcome.ok ? 'info' : 'error'}>
            ${outcome.ok ? 'Completed' : `Exit code ${outcome.code}`}
          </${Banner}>
          ${outcome.stdout ? html`<pre class="code wrap">${outcome.stdout}</pre>` : null}
          ${outcome.stderr ? html`<pre class="code wrap">${outcome.stderr}</pre>` : null}
        </div>` : null}
    </${Modal}>`;
}

export function WriteMenu({ detail, phase, state, onChanged, inline = false }) {
  const [action, setAction] = useState(null);
  const slug = detail?.summary?.slug;

  const base = phase ? { slug, phase: phase.phase } : { slug };

  const actions = phase
    ? [
        ['new-handoff', 'Scaffold handoff'],
        ['qa-record', 'Record QA'],
        phase.lock && !phase.lock.expired ? ['lock-release', 'Release lock'] : ['lock-claim', 'Claim phase'],
      ]
    : [];

  const openEditor = async (path) => {
    try {
      await api.write({ action: 'open-editor', path });
      toast('Handed to your editor');
    } catch (failure) {
      toast(String(failure.message ?? failure), 'error');
    }
  };

  if (!state?.allowWrites) {
    // The rail already says the session is read-only; repeating it in every
    // header is noise.
    if (!inline) return null;
    return html`
      <div class="card">
        <div class="card-head"><h3>Actions</h3></div>
        <div class="card-body faint" style="font-size:var(--text-sm)">
          Writes are off. Restart with <code>--allow-writes</code> to scaffold handoffs, record QA
          results and manage phase locks from here.
        </div>
      </div>`;
  }

  const buttons = html`
    <div class="row-wrap">
      ${actions.map(([id, label]) => html`
        <button class="btn small" key=${id} onClick=${() => setAction(id)}>${label}</button>`)}
      ${!phase && detail?.plan?.path ? html`
        <button class="btn small" onClick=${() => openEditor(detail.plan.path)}>Open in editor</button>` : null}
    </div>`;

  return html`
    ${inline ? html`
      <div class="card">
        <div class="card-head"><h3>Actions</h3></div>
        <div class="card-body">${buttons}</div>
      </div>` : buttons}
    ${action ? html`
      <${WriteDialog}
        action=${action}
        base=${base}
        onClose=${() => setAction(null)}
        onDone=${onChanged} />` : null}`;
}

/** Standalone "new plan" button for the plans list. */
export function NewPlanButton({ state, onChanged }) {
  const [open, setOpen] = useState(false);
  if (!state?.allowWrites) return null;
  return html`
    <button class="btn small" onClick=${() => setOpen(true)}>New plan</button>
    ${open ? html`
      <${WriteDialog} action="new-plan" base=${{}} onClose=${() => setOpen(false)} onDone=${onChanged} />` : null}`;
}
