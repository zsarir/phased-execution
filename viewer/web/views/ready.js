/** Everything that can be started right now, across every plan. */

import { html, useState, useEffect } from '../html.js';
import { api } from '../api.js';
import { navigate, phaseHref, planHref } from '../router.js';
import { PromptCard } from '../components/prompt.js';
import { Chip, Spinner, Empty, Banner, weight, relativeTime } from '../components/ui.js';

export function ReadyView() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let live = true;
    api.stats()
      .then((result) => { if (live) setStats(result); })
      .catch((failure) => { if (live) setError(String(failure.message ?? failure)); });
    return () => { live = false; };
  }, []);

  if (error) return html`<div class="page"><${Banner} kind="error">${error}</${Banner}></div>`;
  if (!stats) return html`<div class="page"><${Spinner} label="Reading every plan" /></div>`;

  const queue = stats.readyQueue;
  const blockedByQa = stats.qaFailures;

  return html`
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Across ${stats.totals.plans} plans</div>
          <h1>Ready now</h1>
        </div>
        <div class="row-wrap">
          <span class="chip state state-ready"><span class="dot"></span>${queue.length} phases</span>
          <span class="chip plain">${weight(queue.reduce((sum, item) => sum + item.weight, 0))} of work</span>
        </div>
      </div>

      ${blockedByQa.length ? html`
        <${Banner} kind="error">
          <span>
            QA failures hold dependents in
            ${blockedByQa.map((failure) => html`
              <button class="chip plain" key=${`${failure.slug}-${failure.phase}`}
                onClick=${() => navigate(phaseHref(failure.slug, failure.phase).slice(2))}>
                ${failure.slug} P${failure.phase}
              </button>`)}
          </span>
        </${Banner}>` : null}

      ${queue.length ? html`
        <div class="stack" style="margin-top:var(--s4)">
          ${queue.map((item) => {
            const id = `${item.slug}-${item.phase}`;
            const isOpen = open === id;
            return html`
              <div key=${id} class="stack" style="gap:var(--s2)">
                <div class="ready-card">
                  <div class="phase-badge">P${item.phase}</div>
                  <div style="min-width:0">
                    <div class="what truncate">${item.title}</div>
                    <div class="where truncate">
                      <button class="chip plain" onClick=${() => navigate(planHref(item.slug).slice(2))}>${item.slug}</button>
                      <span class="faint"> · ${item.planTitle}</span>
                    </div>
                    <div class="row-wrap" style="margin-top:5px">
                      <span class="chip size">${item.size}</span>
                      <span class="chip plain">${weight(item.weight)}</span>
                      ${item.unblocks ? html`<${Chip} title="Phases this releases">unblocks ${item.unblocks}</${Chip}>` : null}
                      ${item.gated ? html`<${Chip} kind="gate">gated — confirm gates first</${Chip}>` : null}
                      ${item.lockedBy && !item.lockExpired ? html`<${Chip} kind="lock" title=${item.lockedBy}>claimed</${Chip}>` : null}
                      ${item.lockExpired ? html`<${Chip} kind="lock expired" title=${item.lockedBy}>stale lock</${Chip}>` : null}
                      ${item.repos ? html`<span class="tag">${item.repos}</span>` : null}
                      <span class="faint" style="font-size:var(--text-xs)">${relativeTime(item.activity)}</span>
                    </div>
                  </div>
                  <div class="row">
                    <button class="btn small" onClick=${() => navigate(phaseHref(item.slug, item.phase).slice(2))}>Open phase</button>
                    <button class="btn small primary" onClick=${() => setOpen(isOpen ? null : id)}>
                      ${isOpen ? 'Hide prompt' : 'Boot prompt'}
                    </button>
                  </div>
                </div>
                ${isOpen ? html`
                  <${PromptCard}
                    title=${`${item.slug} — phase ${item.phase}`}
                    load=${() => api.prompt(item.slug, item.phase)} />` : null}
              </div>`;
          })}
        </div>`
        : html`<${Empty}
            title="Nothing is ready"
            hint="Every phase is done, in flight, or waiting on a dependency. Check Statistics for what is blocked." />`}

      ${stats.stalled.length ? html`
        <div class="card" style="margin-top:var(--s5)">
          <div class="card-head">
            <h3>Stalled</h3>
            <span class="faint" style="font-size:var(--text-xs)">ready phases nobody has picked up</span>
          </div>
          <div class="card-body">
            ${stats.stalled.map((item) => html`
              <div class="row" key=${item.slug} style="justify-content:space-between;padding:3px 0">
                <button class="chip plain" onClick=${() => navigate(planHref(item.slug).slice(2))}>${item.slug}</button>
                <span class="faint" style="font-size:var(--text-xs)">P${item.ready.join(', P')} · idle ${item.days} days</span>
              </div>`)}
          </div>
        </div>` : null}
    </div>`;
}
