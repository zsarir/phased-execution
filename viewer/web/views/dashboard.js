/**
 * The dashboard: what is happening, and where to go next.
 *
 * Ordered by how much it wants you. An approval blocks a live session and is
 * therefore the loudest thing on the page; a plan you have not touched in three
 * weeks is the quietest. Amber appears in exactly one place — whatever is
 * actionable right now — because the token file reserves it for that and a
 * dashboard where everything is urgent tells you nothing.
 *
 * Every figure comes from the server. Nothing is recomputed here.
 */

import { html, useState, useEffect, useCallback } from '../html.js';
import { api, subscribeRun } from '../api.js';
import { navigate, planHref } from '../router.js';
import { toast } from '../store.js';
import { Spinner, relativeTime } from '../components/ui.js';

const RUN_TONE = {
  running: 'progress', finished: 'done', halted: 'blocked',
  parked: 'gated', waiting: 'waiting', paused: 'waiting',
  pausing: 'waiting', stopping: 'waiting',
};

export function DashboardView({ plans, state }) {
  const [runs, setRuns] = useState(null);
  const [approvals, setApprovals] = useState([]);

  const refresh = useCallback(async () => {
    if (!state?.autopilot) { setRuns([]); return; }
    try {
      const [allRuns, queue] = await Promise.all([api.runs(), api.approvals()]);
      setRuns(allRuns);
      setApprovals(queue.filter((a) => a.status === 'pending'));
    } catch { setRuns([]); }
  }, [state?.autopilot]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => state?.autopilot ? subscribeRun({ run: refresh, approval: refresh }) : undefined,
    [refresh, state?.autopilot]);

  if (!runs) return html`<div class="page"><${Spinner} label="Reading status" /></div>`;

  const real = plans.filter((p) => p.kind === 'plan');
  const ready = real.flatMap((p) => p.ready.map((phase) => ({ slug: p.slug, title: p.title, phase })));
  const active = runs.find((r) => ['running', 'waiting', 'pausing', 'stopping'].includes(r.status));
  const attention = runs.filter((r) => ['halted', 'parked'].includes(r.status));
  const donePhases = real.reduce((n, p) => n + p.done, 0);
  const allPhases = real.reduce((n, p) => n + p.phases, 0);

  return html`
    <div class="page dash">
      <header class="dash-head">
        <div>
          <h1>${greeting()}</h1>
          <p class="sub">
            ${real.length} plan${real.length === 1 ? '' : 's'} in${' '}
            <strong>${state.root?.label ?? 'this repository'}</strong>
            ${' '}· ${donePhases} of ${allPhases} phases done
          </p>
        </div>
        <div class="dash-head-actions">
          <button class="btn" onClick=${() => navigate('guide')}>Guide</button>
          <button class="btn" onClick=${() => navigate('source')}>Change source</button>
        </div>
      </header>

      <${Attention} approvals=${approvals} attention=${attention} state=${state} />

      <div class="dash-grid">
        <${ActiveRun} run=${active} state=${state} />
        <${ReadyNow} ready=${ready} />
        <${Progress} plans=${real} done=${donePhases} total=${allPhases} />
        <${Health} state=${state} runs=${runs} />
      </div>

      <section class="dash-section">
        <div class="row spread">
          <h2 class="dash-title">Plans</h2>
          <button class="btn small ghost" onClick=${() => navigate('plans')}>All plans</button>
        </div>
        <div class="plan-cards">
          ${real.slice(0, 6).map((p) => html`<${PlanCard} key=${p.slug} plan=${p} runs=${runs} />`)}
          ${!real.length ? html`
            <p class="muted">
              No plans here yet. Scaffold one with <code>scripts/new-plan.sh &lt;slug&gt;</code>,
              or read the ${' '}<a href="#/guide">guide</a>.
            </p>` : null}
        </div>
      </section>

      <section class="dash-section">
        <h2 class="dash-title">Everywhere else</h2>
        <div class="link-grid">
          ${[
            ['runs', 'Runs', 'Every autopilot run, live and finished'],
            ['ready', 'Ready now', 'Phases whose dependencies are met'],
            ['stats', 'Statistics', 'Throughput, weight and critical path'],
            ['search', 'Search', 'Across plans, phases and handoffs'],
            ['guide', 'Guide', 'How the system works, end to end'],
            ['settings', 'Settings', 'Model, theme and preferences'],
          ].map(([id, label, note]) => html`
            <button key=${id} class="link-card" onClick=${() => navigate(id)}>
              <strong>${label}</strong>
              <span>${note}</span>
            </button>`)}
        </div>
      </section>
    </div>`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ---- the one thing that might be urgent ---- */

function Attention({ approvals, attention, state }) {
  if (!approvals.length && !attention.length) return null;
  return html`
    <section class="attention">
      ${approvals.length ? html`
        <button class="attention-row urgent" onClick=${() => navigate('runs')}>
          <span class="pulse"></span>
          <span class="grow">
            <strong>${approvals.length} approval${approvals.length === 1 ? '' : 's'} waiting</strong>
            <span class="muted"> — a session is paused until you answer</span>
          </span>
          <span class="go">Answer →</span>
        </button>` : null}
      ${attention.map((r) => html`
        <button key=${r.id} class="attention-row" onClick=${() => navigate(planHref(r.slug, 'run').slice(2))}>
          <span class=${`bar tone-${RUN_TONE[r.status]}`}></span>
          <span class="grow">
            <strong>${r.slug}</strong>
            <span class="muted"> ${r.status} — ${r.halt?.reason?.slice(0, 120) ?? 'needs a look'}</span>
          </span>
          <span class="go">Open →</span>
        </button>`)}
      ${!state.allowRun && approvals.length ? html`
        <p class="attention-note">
          This console cannot answer them — it was started without <code>--allow-run</code>.
        </p>` : null}
    </section>`;
}

/* ---- cards ---- */

function Card({ label, children, action, tone }) {
  return html`
    <article class=${`dash-card ${tone ? `tone-${tone}` : ''}`}>
      <h3>${label}</h3>
      ${children}
      ${action ? html`<div class="dash-card-foot">${action}</div>` : null}
    </article>`;
}

function ActiveRun({ run, state }) {
  if (!state.autopilot) {
    return html`
      <${Card} label="Autopilot">
        <p class="figure-note">
          This console predates the runner. Restart it to pick up the run endpoints.
        </p>
      </${Card}>`;
  }
  if (!run) {
    return html`
      <${Card}
        label="Autopilot"
        action=${html`<button class="btn small" onClick=${() => navigate('runs')}>Runs</button>`}>
        <p class="figure idle">Idle</p>
        <p class="figure-note">
          ${state.allowRun
            ? 'Open a plan and start one from its Autopilot tab.'
            : 'Started without --allow-run, so runs can be watched but not started.'}
        </p>
      </${Card}>`;
  }
  return html`
    <${Card}
      label="Running now"
      tone=${RUN_TONE[run.status]}
      action=${html`
        <button class="btn small" onClick=${() => navigate(planHref(run.slug, 'run').slice(2))}>Watch</button>`}>
      <p class="figure">${run.slug}</p>
      <p class="figure-note">
        ${run.activePhase ? `phase ${run.activePhase}` : run.status} ·
        $${(run.spentUsd ?? 0).toFixed(2)}${run.runBudgetUsd ? ` of $${run.runBudgetUsd}` : ''} ·
        ${run.model}
      </p>
    </${Card}>`;
}

function ReadyNow({ ready }) {
  return html`
    <${Card}
      label="Ready now"
      tone=${ready.length ? 'ready' : null}
      action=${ready.length
        ? html`<button class="btn small" onClick=${() => navigate('ready')}>See all</button>`
        : null}>
      <p class=${`figure ${ready.length ? 'hot' : 'idle'}`}>${ready.length}</p>
      <p class="figure-note">
        ${ready.length
          ? ready.slice(0, 2).map((r) => `${r.slug} p${r.phase}`).join(', ')
            + (ready.length > 2 ? ` and ${ready.length - 2} more` : '')
          : 'Nothing unblocked. Finish a phase or clear a gate.'}
      </p>
    </${Card}>`;
}

function Progress({ plans, done, total }) {
  const complete = plans.filter((p) => p.status === 'complete').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return html`
    <${Card} label="Across all plans">
      <p class="figure">${pct}<span class="unit">%</span></p>
      <div class="bar-track"><span class="bar-fill" style=${`width:${pct}%`}></span></div>
      <p class="figure-note">${complete} plan${complete === 1 ? '' : 's'} finished · ${total - done} phases left</p>
    </${Card}>`;
}

function Health({ state, runs }) {
  const watcher = state.watcher;
  const degraded = state.health && !state.health.healthy;
  const ok = !degraded && watcher?.healthy !== false;
  return html`
    <${Card} label="Console" tone=${ok ? null : 'blocked'}>
      <p class=${`figure ${ok ? 'idle' : ''}`}>${ok ? 'Healthy' : 'Degraded'}</p>
      <p class="figure-note">
        ${ok
          ? html`Watching for changes${state.allowRun ? ' · runs enabled' : ''}${state.allowWrites ? ' · writes enabled' : ''}`
          : (state.health?.recent?.at(-1)?.message ?? 'A subsystem reported a fault')}
        ${runs.length ? html` · ${runs.length} run${runs.length === 1 ? '' : 's'} recorded` : null}
      </p>
    </${Card}>`;
}

function PlanCard({ plan, runs }) {
  const run = runs.find((r) => r.slug === plan.slug);
  const pct = plan.percent ?? 0;
  return html`
    <button class="plan-card" onClick=${() => navigate(planHref(plan.slug).slice(2))}>
      <span class="row spread">
        <strong class="truncate">${plan.title || plan.slug}</strong>
        ${run ? html`<span class=${`tag tone-${RUN_TONE[run.status]}`}>${run.status}</span>` : null}
      </span>
      <span class="bar-track"><span class="bar-fill" style=${`width:${pct}%`}></span></span>
      <span class="plan-card-foot">
        <span>${plan.done}/${plan.phases} phases</span>
        ${plan.ready.length ? html`<span class="hot">${plan.ready.length} ready</span>` : null}
        <span class="muted">${relativeTime(plan.activity)}</span>
      </span>
    </button>`;
}
