/**
 * Boot-prompt cards.
 *
 * The text is whatever `phase-graph.sh --boot-prompt` or
 * `next-phase-prompt.sh` printed, copied to the clipboard byte for byte — this
 * console never writes a prompt of its own.
 */

import { html, useState, useEffect } from '../html.js';
import { CopyButton, Spinner, Banner } from './ui.js';

export function PromptCard({ title, load, note, collapsed = false }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(!collapsed);

  useEffect(() => {
    if (!open || text != null) return;
    let live = true;
    load()
      .then((body) => { if (live) setText(String(body).trim()); })
      .catch((failure) => { if (live) setError(String(failure.message ?? failure)); });
    return () => { live = false; };
  }, [open, load, text]);

  return html`
    <div class="prompt-card">
      <header>
        <span class="title">${title}</span>
        <div class="row">
          ${note ? html`<span class="faint" style="font-size:var(--text-xs)">${note}</span>` : null}
          ${!open
            ? html`<button class="btn small" onClick=${() => setOpen(true)}>Show</button>`
            : html`<${CopyButton} text=${() => text ?? ''} label="Copy prompt" />`}
        </div>
      </header>
      ${open ? html`
        ${error ? html`<div style="padding:var(--s3)"><${Banner} kind="error">${error}</${Banner}></div>`
          : text == null ? html`<div style="padding:var(--s3)"><${Spinner} label="Reading the engine" /></div>`
            : html`<pre class="code">${text}</pre>`}` : null}
    </div>`;
}
