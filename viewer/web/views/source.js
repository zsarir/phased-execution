/** First screen: choose the directory the console reads. */

import { html, useState, useEffect } from '../html.js';
import { api } from '../api.js';
import { Banner, Empty } from '../components/ui.js';
import { toast } from '../store.js';

export function SourceView({ state, onOpened }) {
  const [path, setPath] = useState(state.root?.path ?? '');
  const [browsePath, setBrowsePath] = useState(state.root?.path ?? '');
  const [listing, setListing] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.browse(browsePath).then((result) => { if (live) { setListing(result); setPath(result.path); } })
      .catch(() => { if (live) setListing(null); });
    return () => { live = false; };
  }, [browsePath]);

  useEffect(() => {
    if (!path) { setCheck(null); return; }
    let live = true;
    const id = setTimeout(() => {
      api.checkRoot(path).then((result) => { if (live) setCheck(result); }).catch(() => { if (live) setCheck(null); });
    }, 120);
    return () => { live = false; clearTimeout(id); };
  }, [path]);

  const open = async (target) => {
    setBusy(true);
    try {
      const result = await api.openRoot(target ?? path);
      if (!result.check?.ok) { toast(result.check?.reason ?? 'Could not open that directory', 'error'); return; }
      toast(`Opened ${result.check.label}`);
      onOpened(result);
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="picker">
      <div class="picker-hero">
        <h1>Choose a source directory</h1>
        <p>
          <!-- htm drops whitespace at line breaks, so each inline code element
               stays on the same line as the words around it. -->
          Point the console at a repository that holds <code>docs/plans</code>. A <code>docs/handoffs</code> folder
          beside it is read too, when there is one.
        </p>
        <p>
          Everything on screen comes from those files and from the phased-execution scripts. The
          plans stay where they are — nothing is written unless the server was started with <code>--allow-writes</code>.
        </p>
      </div>

      ${state.recentRoots?.length ? html`
        <div class="card" style="margin-bottom:var(--s4)">
          <div class="card-head"><h3>Recent</h3></div>
          <div class="card-body">
            <div class="recent-grid">
              ${state.recentRoots.map((recent) => html`
                <button class="source-chip" key=${recent.path} onClick=${() => open(recent.path)}>
                  <span class="label">${recent.label}</span>
                  <span class="path">${recent.path}</span>
                </button>`)}
            </div>
          </div>
        </div>` : null}

      <div class="card">
        <div class="card-head">
          <h3>Browse</h3>
          <div class="row">
            ${listing?.parent ? html`
              <button class="btn small" onClick=${() => setBrowsePath(listing.parent)}>↑ Parent</button>` : null}
            <button class="btn small" onClick=${() => setBrowsePath('~')}>Home</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="field grow">
            <label for="root-path">Path</label>
            <input
              id="root-path"
              class="grow mono"
              value=${path}
              placeholder="/path/to/your-repo"
              onInput=${(event) => setPath(event.target.value)}
              onKeyDown=${(event) => { if (event.key === 'Enter' && check?.ok) void open(); }} />
          </div>
        </div>

        <div class="dir-list">
          ${(listing?.entries ?? []).map((entry) => html`
            <button class="dir-item" key=${entry.path} onClick=${() => { setBrowsePath(entry.path); setPath(entry.path); }}>
              <span aria-hidden="true">📁</span>
              <span class="truncate">${entry.name}</span>
              ${entry.hasDocs ? html`<span class="badge">plans</span>` : null}
            </button>`)}
          ${listing && !listing.entries.length
            ? html`<${Empty} title="Nothing to browse here" hint="This directory has no sub-directories." />`
            : null}
        </div>

        <div class="card-head" style="border-top:1px solid var(--rule);border-bottom:0">
          <div class="grow">
            ${check?.ok ? html`
              <${Banner} kind="info">
                <span>
                  <b class="mono">${check.planCount}</b> plans ·
                  <b class="mono">${check.handoffCount}</b> handoff folders found in
                  <code>${check.docsDir}</code>
                </span>
              </${Banner}>`
              : check ? html`<${Banner} kind="warn">${check.reason ?? 'Not a source directory'}</${Banner}>`
                : html`<span class="faint">Pick a directory that contains <code>docs/plans</code>.</span>`}
          </div>
          <button class="btn primary" disabled=${!check?.ok || busy} onClick=${() => open()}>
            ${busy ? 'Opening…' : 'Open'}
          </button>
        </div>
      </div>
    </div>`;
}
