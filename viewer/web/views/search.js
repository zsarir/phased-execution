/** Full-text search across every plan and handoff. */

import { html, useState, useEffect, useRef } from '../html.js';
import { api } from '../api.js';
import { navigate, planHref, phaseHref, handoffHref } from '../router.js';
import { Spinner, Empty, Banner } from '../components/ui.js';

const KIND_LABEL = { plan: 'plan', phase: 'phase', handoff: 'handoff', document: 'document' };

function Snippet({ text, terms }) {
  const parts = [];
  let rest = text;
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  let match;
  let last = 0;
  while (terms.length && (match = pattern.exec(rest)) !== null) {
    if (match.index > last) parts.push(rest.slice(last, match.index));
    parts.push(html`<mark key=${match.index}>${match[0]}</mark>`);
    last = match.index + match[0].length;
    if (parts.length > 40) break;
  }
  parts.push(rest.slice(last));
  return html`<span class="snippet">${parts}</span>`;
}

export function SearchView({ query }) {
  const [value, setValue] = useState(query ?? '');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const text = value.trim();
    if (text.length < 2) { setResult(null); return; }
    let live = true;
    setBusy(true);
    const id = setTimeout(() => {
      api.search(text)
        .then((found) => { if (live) { setResult(found); setError(null); } })
        .catch((failure) => { if (live) setError(String(failure.message ?? failure)); })
        .finally(() => { if (live) setBusy(false); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [value]);

  const terms = value.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 1);

  const openHit = (hit) => {
    if (hit.kind === 'handoff' && hit.phase != null) navigate(handoffHref(hit.slug, hit.phase).slice(2));
    else if (hit.kind === 'phase' && hit.phase != null) navigate(phaseHref(hit.slug, hit.phase).slice(2));
    else navigate(planHref(hit.slug, 'overview').slice(2));
  };

  return html`
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Plans and handoffs</div>
          <h1>Search</h1>
        </div>
        ${result ? html`<span class="chip plain">${result.total} hits in ${result.groups.length} plans</span>` : null}
      </div>

      <div class="filter-bar">
        <div class="field grow">
          <label for="q">Find</label>
          <input
            id="q"
            ref=${input}
            class="grow"
            placeholder="content guard · a423b9b5 · trade-frontend/src · &quot;exit criteria&quot;"
            value=${value}
            onInput=${(event) => setValue(event.target.value)} />
          ${busy ? html`<span class="spinner"></span>` : null}
        </div>
      </div>

      ${error ? html`<${Banner} kind="error">${error}</${Banner}>` : null}

      ${!result && value.trim().length < 2 ? html`
        <${Empty}
          title="Search the whole library"
          hint="Every plan section, phase block and handoff body is indexed — file paths, commit shas, exit criteria and gotchas included." />` : null}

      ${result && !result.groups.length ? html`
        <${Empty} title=${`Nothing matches “${value.trim()}”`} hint="Every term has to appear in the same section." />` : null}

      ${result?.groups.length ? html`
        <div class="stack">
          ${result.groups.map((group) => html`
            <div class="search-group" key=${group.slug}>
              <header>
                <button class="chip plain" onClick=${() => navigate(planHref(group.slug).slice(2))}>${group.slug}</button>
                <span class="truncate faint" style="font-size:var(--text-xs);flex:1;text-align:right">${group.title}</span>
              </header>
              ${group.hits.map((hit, i) => html`
                <button class="search-hit" key=${i} onClick=${() => openHit(hit)}>
                  <div class="where">${KIND_LABEL[hit.kind] ?? hit.kind} · ${hit.section}</div>
                  <${Snippet} text=${hit.snippet} terms=${terms} />
                </button>`)}
            </div>`)}
        </div>` : null}
    </div>`;
}
