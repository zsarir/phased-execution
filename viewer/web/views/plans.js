/** Every plan in the source directory, newest activity first. */

import { html, useState, useMemo } from '../html.js';
import { navigate, planHref } from '../router.js';
import { usePrefs } from '../store.js';
import { Progress, Chip, relativeTime, weight, Empty } from '../components/ui.js';

const SORTS = [
  { id: 'activity', label: 'Latest activity', compare: (a, b) => b.activity - a.activity },
  { id: 'ready', label: 'Ready first', compare: (a, b) => b.ready.length - a.ready.length || b.activity - a.activity },
  { id: 'progress', label: 'Least complete', compare: (a, b) => a.percent - b.percent || b.activity - a.activity },
  { id: 'remaining', label: 'Most work left', compare: (a, b) => b.remainingWeight - a.remainingWeight },
  { id: 'phases', label: 'Most phases', compare: (a, b) => b.phases - a.phases },
  { id: 'created', label: 'Newest plan', compare: (a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')) },
  { id: 'name', label: 'Name', compare: (a, b) => a.slug.localeCompare(b.slug) },
];

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'complete', label: 'Complete' },
  { id: 'other', label: 'Other' },
];

function PlanRow({ plan }) {
  const hasReady = plan.ready.length > 0;
  const done = plan.status === 'complete';
  const locks = plan.locks.filter((lock) => !lock.expired);

  return html`
    <button
      class=${`plan-row ${hasReady ? 'has-ready' : ''} ${done ? 'complete' : ''}`}
      onClick=${() => navigate(planHref(plan.slug).slice(2))}>
      <div class="grow" style="min-width:0">
        <div class="plan-title truncate">${plan.title}</div>
        <div class="plan-slug truncate">${plan.slug}</div>
        <div class="plan-meta">
          ${plan.status ? html`<span class="tag">${plan.status}</span>` : null}
          ${plan.kind === 'document' ? html`<span class="tag" title="No phase graph — a design document">document</span>` : null}
          ${plan.kind === 'orphan-handoffs' ? html`<span class="tag" title="Handoffs with no plan file">orphan</span>` : null}
          ${plan.targetModel ? html`<span class="tag">${plan.targetModel}</span>` : null}
          ${plan.qaMode === 'on' ? html`<span class="tag" style="color:var(--line-progress)">QA on</span>` : null}
          ${plan.qaFailures.length ? html`<${Chip} kind="warn">QA fail p${plan.qaFailures.join(', p')}</${Chip}>` : null}
          ${locks.length ? html`<${Chip} kind="lock" title=${locks.map((l) => `p${l.phase} · ${l.owner}`).join('\n')}>locked p${locks.map((l) => l.phase).join(', ')}</${Chip}>` : null}
          ${plan.issueCounts.error ? html`<${Chip} kind="warn">${plan.issueCounts.error} issue${plan.issueCounts.error === 1 ? '' : 's'}</${Chip}>` : null}
        </div>
      </div>

      <div class="plan-progress col-hide-sm">
        ${plan.phases ? html`
          <${Progress}
            total=${plan.phases}
            done=${plan.done}
            inProgress=${plan.inProgress.length}
            ready=${plan.ready.length}
            stuck=${plan.stuck.length} />
          <div class="figures">
            <span>${plan.done}/${plan.phases}</span>
            <span>${plan.percent}%</span>
          </div>` : html`<span class="faint">—</span>`}
      </div>

      <div class="col-hide-md">
        ${plan.ready.length ? html`
          <div class="ready-chips">
            ${plan.ready.map((phase) => html`<span class="ready-chip" key=${phase}>P${phase}</span>`)}
          </div>`
          : plan.inProgress.length ? html`<span class="chip state state-in-progress"><span class="dot"></span>P${plan.inProgress.join(', P')}</span>`
            : html`<span class="faint">—</span>`}
      </div>

      <div class="col-hide-md plan-when">
        ${plan.remainingWeight
          ? html`<span class="mono">${weight(plan.remainingWeight)}</span> left<br /><span class="faint">≈${plan.remainingSessions} session${plan.remainingSessions === 1 ? '' : 's'}</span>`
          : html`<span class="faint">complete</span>`}
      </div>

      <div class="col-hide-sm plan-when">${relativeTime(plan.activity)}</div>
    </button>`;
}

export function PlansView({ plans }) {
  const [prefs, setPrefs] = usePrefs();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [onlyReady, setOnlyReady] = useState(false);
  const [onlyLocked, setOnlyLocked] = useState(false);
  const [repo, setRepo] = useState('');

  const repos = useMemo(() => {
    const counts = new Map();
    for (const plan of plans) for (const r of plan.repos) counts.set(r, (counts.get(r) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [plans]);

  const sort = SORTS.find((s) => s.id === prefs.sort) ?? SORTS[0];

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return plans
      .filter((plan) => {
        if (!prefs.showDocuments && plan.kind !== 'plan') return false;
        if (!prefs.showComplete && plan.status === 'complete') return false;
        if (status === 'active' && plan.status !== 'active') return false;
        if (status === 'complete' && plan.status !== 'complete') return false;
        if (status === 'other' && (plan.status === 'active' || plan.status === 'complete')) return false;
        if (onlyReady && !plan.ready.length) return false;
        if (onlyLocked && !plan.locks.some((lock) => !lock.expired)) return false;
        if (repo && !plan.repos.includes(repo)) return false;
        if (text && !(`${plan.slug} ${plan.title}`.toLowerCase().includes(text))) return false;
        return true;
      })
      .sort(sort.compare);
  }, [plans, query, status, onlyReady, onlyLocked, repo, sort, prefs.showDocuments, prefs.showComplete]);

  const readyTotal = visible.reduce((n, plan) => n + plan.ready.length, 0);
  const counts = {
    plans: plans.filter((p) => p.kind === 'plan').length,
    documents: plans.filter((p) => p.kind === 'document').length,
    orphans: plans.filter((p) => p.kind === 'orphan-handoffs').length,
  };

  return html`
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">
            ${counts.plans} plans
            ${counts.documents ? ` · ${counts.documents} documents` : ''}
            ${counts.orphans ? ` · ${counts.orphans} orphan handoff folders` : ''}
          </div>
          <h1>Plans</h1>
        </div>
        <div class="row-wrap">
          <span class="chip plain">${visible.length} shown</span>
          ${readyTotal ? html`<span class="chip state state-ready"><span class="dot"></span>${readyTotal} ready</span>` : null}
        </div>
      </div>

      <div class="filter-bar">
        <div class="field grow" style="min-width:220px">
          <label for="plan-filter">Find</label>
          <input
            id="plan-filter"
            class="grow"
            placeholder="plan name or slug"
            value=${query}
            onInput=${(event) => setQuery(event.target.value)} />
        </div>

        <div class="btn-group">
          ${STATUS_FILTERS.map((option) => html`
            <button
              key=${option.id}
              class="btn small"
              aria-pressed=${String(status === option.id)}
              onClick=${() => setStatus(option.id)}>${option.label}</button>`)}
        </div>

        <button class="btn small" aria-pressed=${String(onlyReady)} onClick=${() => setOnlyReady(!onlyReady)}>Has ready</button>
        <button class="btn small" aria-pressed=${String(onlyLocked)} onClick=${() => setOnlyLocked(!onlyLocked)}>Locked</button>
        <button class="btn small" aria-pressed=${String(prefs.showDocuments)} onClick=${() => setPrefs({ showDocuments: !prefs.showDocuments })}>
          Documents
        </button>

        <div class="field">
          <label for="repo-filter">Repo</label>
          <select id="repo-filter" value=${repo} onChange=${(event) => setRepo(event.target.value)}>
            <option value="">any</option>
            ${repos.map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
          </select>
        </div>

        <div class="field">
          <label for="sort">Sort</label>
          <select id="sort" value=${prefs.sort} onChange=${(event) => setPrefs({ sort: event.target.value })}>
            ${SORTS.map((option) => html`<option key=${option.id} value=${option.id}>${option.label}</option>`)}
          </select>
        </div>
      </div>

      ${visible.length ? html`
        <div class="plan-list">
          ${visible.map((plan) => html`<${PlanRow} key=${plan.slug} plan=${plan} />`)}
        </div>`
        : html`<${Empty}
            title="No plans match"
            hint="Relax a filter, or turn on Documents to include files in docs/plans that have no phase graph." />`}
    </div>`;
}
