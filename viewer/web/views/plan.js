/** One plan: its route, its board, its phases, handoffs and analysis. */

import { html, useState, useEffect, useMemo, useCallback } from '../html.js';
import { api } from '../api.js';
import { navigate, planHref, phaseHref, handoffHref } from '../router.js';
import { Markdown } from '../components/markdown.js';
import { RouteMap } from '../components/dag.js';
import { PromptCard } from '../components/prompt.js';
import { WriteMenu } from '../components/writes.js';
import { RunView } from './run.js';
import {
  StateChip, Chip, Tabs, Progress, KeyValue, CopyButton, Spinner, Banner, Empty,
  relativeTime, weight, countdown, STATE_BOARD,
} from '../components/ui.js';

const TABS = [
  { id: 'route', label: 'Route' },
  { id: 'phases', label: 'Phases' },
  { id: 'run', label: 'Autopilot' },
  { id: 'handoffs', label: 'Handoffs' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'overview', label: 'Overview' },
  { id: 'raw', label: 'Raw' },
];

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function PlanHeader({ detail, state, onChanged }) {
  const s = detail.summary;
  const budget = detail.plan?.sessionBudget ?? {};

  return html`
    <div class="plan-head">
      <div class="title-row">
        <h1>${s.title}</h1>
        ${s.status ? html`<span class="tag">${s.status}</span>` : null}
        ${s.kind !== 'plan' ? html`<span class="tag">${s.kind === 'document' ? 'document' : 'orphan handoffs'}</span>` : null}
        <span class="grow"></span>
        <${WriteMenu} detail=${detail} state=${state} onChanged=${onChanged} />
      </div>

      <div class="row-wrap">
        <span class="plan-slug mono">${s.slug}</span>
        ${s.phases ? html`
          <span style="width:min(320px,40vw)">
            <${Progress}
              total=${s.phases} done=${s.done}
              inProgress=${s.inProgress.length} ready=${s.ready.length} stuck=${s.stuck.length} />
          </span>
          <span class="mono faint">${s.done}/${s.phases} · ${s.percent}%</span>` : null}
        ${s.ready.map((phase) => html`
          <button class="ready-chip" key=${phase} onClick=${() => navigate(phaseHref(s.slug, phase).slice(2))}>
            P${phase} ready
          </button>`)}
        ${s.inProgress.map((phase) => html`<${StateChip} key=${phase} state="in-progress" />`)}
      </div>

      <div class="facts">
        ${budget.targetModel ? html`<span>model <b>${budget.targetModel}</b></span>` : null}
        ${s.budget ? html`<span>budget <b>${weight(s.budget)}</b>/session</span>` : null}
        ${budget.branch ? html`<span>branch <b>${budget.branch}</b></span>` : null}
        <span>QA <b>${s.qaMode}</b></span>
        ${s.remainingWeight ? html`<span>left <b>${weight(s.remainingWeight)}</b> ≈ ${s.remainingSessions} session${s.remainingSessions === 1 ? '' : 's'}</span>` : null}
        ${detail.git?.sha ? html`<span>last commit <b>${detail.git.sha}</b> ${detail.git.relativeDate}</span>` : null}
        ${detail.git?.dirty ? html`<span class="chip warn">uncommitted</span>` : null}
        ${budget.skills?.length ? html`<span>skills ${budget.skills.map((skill) => html`<b key=${skill}>${skill} </b>`)}</span>` : null}
      </div>

      ${s.engineError ? html`<${Banner} kind="warn">Engine: ${s.engineError}</${Banner}>` : null}
      ${detail.lint?.timedOut ? html`<${Banner} kind="info">${detail.lint.summary}</${Banner}>` : null}
      ${detail.lint && !detail.lint.ok ? html`
        <${Banner} kind="error">
          <div>
            <b>${detail.lint.summary}</b>
            <ul style="margin:4px 0 0;padding-left:18px">
              ${detail.lint.issues.map((issue, i) => html`<li key=${i}>${issue}</li>`)}
            </ul>
          </div>
        </${Banner}>` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Departures board
 * ------------------------------------------------------------------ */

function DeparturesBoard({ detail }) {
  const slug = detail.summary.slug;
  return html`
    <div class="card">
      <div class="card-head">
        <h3>Departures</h3>
        <span class="faint" style="font-size:var(--text-xs)">${detail.phases.length} phases · click a row for the full phase</span>
      </div>
      <div class="table-scroll">
        <table class="departures">
          <thead>
            <tr>
              <th style="width:52px">#</th>
              <th>Phase</th>
              <th style="width:96px">Status</th>
              <th style="width:60px">Size</th>
              <th style="width:150px">Platform</th>
              <th style="width:190px">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${detail.phases.map((phase) => html`
              <tr
                key=${phase.phase}
                class=${phase.state === 'ready' ? 'is-ready' : ''}
                onClick=${() => navigate(phaseHref(slug, phase.phase).slice(2))}>
                <td class="phase-num">${String(phase.phase).padStart(2, '0')}</td>
                <td>
                  <div class="phase-title">${phase.title}</div>
                  ${phase.state === 'waiting' && phase.analysis?.dependsOn.length
                    ? html`<div class="needs">needs ${phase.analysis.dependsOn.map((d) => `P${d}`).join(' · ')}</div>`
                    : phase.goal ? html`<div class="needs truncate" style="max-width:46ch">${phase.goal.replace(/[*`]/g, '')}</div>` : null}
                </td>
                <td><${StateChip} state=${phase.state} board=${true} /></td>
                <td><span class="chip size">${phase.size}</span></td>
                <td class="mono" style="font-size:var(--text-2xs);color:var(--ink-faint)">${phase.row?.repos ?? '—'}</td>
                <td>
                  <div class="row-wrap">
                    ${phase.gated ? html`<${Chip} kind="gate">gated</${Chip}>` : null}
                    ${phase.lock && !phase.lock.expired ? html`<${Chip} kind="lock" title=${phase.lock.owner}>locked</${Chip}>` : null}
                    ${phase.lock?.expired ? html`<${Chip} kind="lock expired" title=${phase.lock.owner}>stale lock</${Chip}>` : null}
                    ${phase.qa && phase.qa.result !== 'waived' ? html`<${Chip} kind=${phase.qa.result === 'fail' ? 'warn' : ''}>QA ${phase.qa.result}</${Chip}>` : null}
                    ${phase.analysis?.onCriticalPath ? html`<${Chip} title="On the longest remaining chain">critical</${Chip}>` : null}
                    ${phase.handoff ? html`<${Chip} title=${`Handoff: ${phase.handoff.status}`}>handoff</${Chip}>` : null}
                  </div>
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Route tab
 * ------------------------------------------------------------------ */

function RouteTab({ detail }) {
  const slug = detail.summary.slug;
  const ready = detail.summary.ready;
  const lastDone = detail.summary.done ? Math.max(...(detail.summary.criticalPath.length ? [] : []), ...detail.phases.filter((p) => p.state === 'done').map((p) => p.phase)) : null;

  return html`
    <div class="stack">
      <${RouteMap}
        route=${detail.route}
        batches=${detail.batches}
        budget=${detail.summary.budget}
        onSelect=${(phase) => navigate(phaseHref(slug, phase).slice(2))} />

      ${detail.batches?.groups?.length ? html`
        <div class="card">
          <div class="card-head">
            <h3>Suggested sessions</h3>
            <span class="faint" style="font-size:var(--text-xs)">
              from <code>phase-graph.sh --session-plan</code> · budget ${weight(detail.summary.budget)}
            </span>
          </div>
          <div class="card-body tight">
            <div class="row-wrap">
              ${detail.batches.groups.map((group) => html`
                <span class="chip plain" key=${group.index} title=${group.note ?? ''}>
                  <b>S${group.index}</b>&nbsp;${group.phases.map((p) => `P${p}`).join(' + ')}
                  &nbsp;<span class="faint">${group.weight}</span>
                  ${group.gated ? ' · gated' : ''}
                </span>`)}
            </div>
          </div>
        </div>` : null}

      <${DeparturesBoard} detail=${detail} />

      ${ready.length ? html`
        <div class="grid cols-2">
          ${ready.map((phase) => html`
            <${PromptCard}
              key=${phase}
              title=${`Boot prompt — phase ${phase}`}
              load=${() => api.prompt(slug, phase)} />`)}
        </div>` : null}

      ${lastDone ? html`
        <${PromptCard}
          title=${`End-of-phase banner — after phase ${lastDone}`}
          note="board · batching advice · every ready prompt"
          collapsed=${true}
          load=${() => api.nextPrompt(slug, lastDone)} />` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Phase detail
 * ------------------------------------------------------------------ */

function Field({ label, children }) {
  if (!children) return null;
  return html`
    <div class="phase-field">
      <h4>${label}</h4>
      ${children}
    </div>`;
}

function PhasePanel({ detail, phase, state, onChanged }) {
  const slug = detail.summary.slug;
  const view = detail.phases.find((p) => p.phase === Number(phase));
  const [gate, setGate] = useState(null);

  useEffect(() => {
    if (!view?.gateCheck) return;
    let live = true;
    api.gate(slug, view.phase).then((result) => { if (live) setGate(result); }).catch(() => {});
    return () => { live = false; };
  }, [slug, view?.phase, view?.gateCheck]);

  if (!view) return html`<${Empty} title=${`No phase ${phase} in this plan`} />`;

  const criteria = view.exitCriteria;

  return html`
    <div class="detail-grid">
      <div class="phase-panel">
        <div class="card">
          <div class="card-head">
            <div class="row">
              <span class="phase-num mono" style="font-size:var(--text-xl)">${String(view.phase).padStart(2, '0')}</span>
              <div>
                <h3 style="text-transform:none;letter-spacing:0">${view.title}</h3>
                <div class="row-wrap" style="margin-top:4px">
                  <${StateChip} state=${view.state} board=${true} />
                  <span class="chip size">${view.size}</span>
                  <span class="chip plain">${weight(view.weight)}</span>
                  ${view.model ? html`<span class="chip plain">${view.model}</span>` : null}
                  ${view.gated ? html`<${Chip} kind="gate">gated</${Chip}>` : null}
                  ${view.analysis?.onCriticalPath ? html`<${Chip}>critical path</${Chip}>` : null}
                </div>
              </div>
            </div>
            <div class="row">
              ${view.handoff ? html`
                <button class="btn small" onClick=${() => navigate(handoffHref(slug, view.phase).slice(2))}>Handoff</button>` : null}
            </div>
          </div>
          <div class="card-body stack">
            ${view.goal ? html`<${Field} label="Goal"><${Markdown} text=${view.goal} /></${Field}>` : null}
            ${view.gates ? html`
              <${Banner} kind="warn">
                <div>
                  <b>Gates must clear first.</b> <${Markdown} text=${view.gates} />
                  ${gate ? html`<div class="mono" style="font-size:var(--text-xs)">gate-check: ${gate.kind} — ${gate.clear ? 'clear' : 'blocked'} ${gate.detail}</div>` : null}
                </div>
              </${Banner}>` : null}
            ${view.readFirst ? html`<${Field} label="Read first"><${Markdown} text=${view.readFirst} /></${Field}>` : null}
            ${view.files ? html`<${Field} label="Files"><${Markdown} text=${view.files} /></${Field}>` : null}
            ${view.steps ? html`<${Field} label="Steps"><${Markdown} text=${view.steps} /></${Field}>` : null}
            ${criteria ? html`<${Field} label="Exit criteria"><${Markdown} text=${criteria} /></${Field}>` : null}
            ${view.verification ? html`<${Field} label="Verification"><${Markdown} text=${view.verification} /></${Field}>` : null}
            ${view.handoffMustRecord ? html`<${Field} label="Handoff must record"><${Markdown} text=${view.handoffMustRecord} /></${Field}>` : null}
            ${!view.goal && !criteria ? html`
              <${Banner} kind="info">This phase has a graph row but no <code>### Phase ${view.phase}</code> section in the plan.</${Banner}>` : null}
          </div>
        </div>

        ${view.state === 'ready' || view.state === 'in-progress' ? html`
          <${PromptCard} title=${`Boot prompt — phase ${view.phase}`} load=${() => api.prompt(slug, view.phase)} />` : null}
        ${detail.summary.qaMode === 'on' && view.state === 'done' ? html`
          <${PromptCard} title=${`QA brief — phase ${view.phase}`} collapsed=${true} load=${() => api.qaPrompt(slug, view.phase)} />` : null}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>Dependencies</h3></div>
          <div class="card-body">
            <${KeyValue} items=${[
              ['Depends on', view.analysis?.dependsOn.length
                ? html`<div class="row-wrap">${view.analysis.dependsOn.map((d) => html`
                    <button class="chip plain" key=${d} onClick=${() => navigate(phaseHref(slug, d).slice(2))}>P${d} · ${stateOf(detail, d)}</button>`)}</div>`
                : html`<span class="faint">nothing — a root phase</span>`],
              ['Unblocks', view.analysis?.dependents.length
                ? html`<div class="row-wrap">${view.analysis.dependents.map((d) => html`
                    <button class="chip plain" key=${d} onClick=${() => navigate(phaseHref(slug, d).slice(2))}>P${d}</button>`)}</div>`
                : html`<span class="faint">nothing downstream</span>`],
              ['Downstream total', view.analysis?.transitiveDependents.length
                ? `${view.analysis.transitiveDependents.length} phase${view.analysis.transitiveDependents.length === 1 ? '' : 's'} (${view.analysis.unblocks} still open)`
                : '—'],
              ['Parallel-safe with', view.row?.parallelSafe && view.row.parallelSafe !== '—' ? view.row.parallelSafe : null],
              ['Repos', view.row?.repos],
              ['Exit criteria (graph)', view.row?.exitCriteria],
            ]} />
          </div>
        </div>

        ${view.lock ? html`
          <div class="card">
            <div class="card-head"><h3>Lock</h3></div>
            <div class="card-body">
              <${KeyValue} items=${[
                ['Owner', html`<span class="mono">${view.lock.owner}</span>`],
                ['State', view.lock.expired ? 'expired — another session may take it over' : countdown(view.lock.leaseUntil)],
              ]} />
            </div>
          </div>` : null}

        ${view.handoff ? html`
          <div class="card">
            <div class="card-head">
              <h3>Handoff</h3>
              <button class="btn small" onClick=${() => navigate(handoffHref(slug, view.phase).slice(2))}>Open</button>
            </div>
            <div class="card-body">
              <${KeyValue} items=${[
                ['Status', html`<${StateChip} state=${view.handoff.status === 'complete' ? 'done' : view.handoff.status === 'blocked' ? 'stuck' : view.handoff.status} />`],
                ['Completed', view.handoff.completed],
                ['Skills used', view.handoff.skillsUsed.join(', ')],
                ['Prompts', view.handoff.prompts ? `${view.handoff.prompts} boot prompt${view.handoff.prompts === 1 ? '' : 's'}` : null],
              ]} />
              ${view.handoff.outstanding && view.handoff.outstanding.toLowerCase() !== 'none' ? html`
                <div style="margin-top:var(--s2)">
                  <h4 style="font-size:var(--text-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint)">Outstanding</h4>
                  <${Markdown} text=${view.handoff.outstanding} />
                </div>` : null}
            </div>
          </div>` : null}

        ${state.allowWrites ? html`
          <${WriteMenu} detail=${detail} phase=${view} state=${state} onChanged=${onChanged} inline=${true} />` : null}
      </div>
    </div>`;
}

function stateOf(detail, phase) {
  return detail.phases.find((p) => p.phase === phase)?.state ?? 'unknown';
}

/* ------------------------------------------------------------------ *
 * Handoffs
 * ------------------------------------------------------------------ */

function HandoffPanel({ detail, phase }) {
  const slug = detail.summary.slug;
  const [handoff, setHandoff] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setHandoff(null);
    api.handoff(slug, Number(phase))
      .then((result) => { if (live) setHandoff(result); })
      .catch((failure) => { if (live) setError(String(failure.message ?? failure)); });
    return () => { live = false; };
  }, [slug, phase]);

  if (error) return html`<${Banner} kind="error">${error}</${Banner}>`;
  if (!handoff) return html`<${Spinner} label="Reading handoff" />`;

  return html`
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div>
            <h3 style="text-transform:none;letter-spacing:0">Phase ${handoff.phase} — ${handoff.title}</h3>
            <div class="row-wrap" style="margin-top:4px">
              <${StateChip} state=${handoff.status === 'complete' ? 'done' : handoff.status === 'blocked' ? 'stuck' : handoff.status} />
              ${handoff.completed ? html`<span class="chip plain">${handoff.completed}</span>` : null}
              ${handoff.dependsOn.length ? html`<span class="chip plain">depends on P${handoff.dependsOn.join(', P')}</span>` : null}
              ${handoff.blocks.length ? html`<span class="chip plain">blocks P${handoff.blocks.join(', P')}</span>` : null}
              ${handoff.skillsUsed.map((skill) => html`<span class="tag" key=${skill}>${skill}</span>`)}
            </div>
          </div>
          <div class="row">
            <button class="btn small" onClick=${() => navigate(phaseHref(slug, handoff.phase).slice(2))}>Phase</button>
            <${CopyButton} text=${handoff.body} label="Copy markdown" />
          </div>
        </div>
        <div class="card-body">
          <${Markdown} text=${handoff.body} />
        </div>
      </div>

      ${handoff.keyFiles?.length ? html`
        <div class="card">
          <div class="card-head"><h3>Key files</h3></div>
          <div class="card-body">
            <div class="stack" style="gap:2px">
              ${handoff.keyFiles.map((file) => html`<code key=${file} class="mono" style="font-size:var(--text-xs)">${file}</code>`)}
            </div>
          </div>
        </div>` : null}
    </div>`;
}

function HandoffsTab({ detail }) {
  const slug = detail.summary.slug;
  if (!detail.handoffs.length) {
    return html`<${Empty}
      title="No handoffs yet"
      hint="A handoff is written at the end of each phase — that is what lets the next session start cold." />`;
  }

  const indexRows = new Map(detail.index.map((row) => [row.phase, row]));

  return html`
    <div class="card">
      <div class="card-head">
        <h3>Handoffs</h3>
        <span class="faint" style="font-size:var(--text-xs)">${detail.handoffs.length} of ${detail.summary.phases} phases</span>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th style="width:52px">#</th><th>Title</th><th style="width:120px">Status</th>
              <th style="width:110px">Completed</th><th style="width:120px">Skills</th>
              <th style="width:90px" class="num">Size</th><th style="width:120px">Index row</th>
            </tr>
          </thead>
          <tbody>
            ${detail.handoffs.map((handoff) => html`
              <tr key=${handoff.phase} style="cursor:pointer" onClick=${() => navigate(handoffHref(slug, handoff.phase).slice(2))}>
                <td class="mono">${String(handoff.phase).padStart(2, '0')}</td>
                <td>${handoff.title}</td>
                <td><${StateChip} state=${handoff.status === 'complete' ? 'done' : handoff.status === 'blocked' ? 'stuck' : handoff.status} /></td>
                <td class="mono" style="font-size:var(--text-xs)">${handoff.completed ?? '—'}</td>
                <td class="mono" style="font-size:var(--text-2xs)">${handoff.skillsUsed.join(', ') || '—'}</td>
                <td class="num" style="font-size:var(--text-xs)">${Math.round(handoff.bytes / 1024)}K</td>
                <td>
                  ${indexRows.has(handoff.phase)
                    ? html`<span class="faint" style="font-size:var(--text-xs)">${indexRows.get(handoff.phase).status}</span>`
                    : html`<${Chip} kind="warn">missing</${Chip}>`}
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function AnalysisTab({ detail }) {
  const s = detail.summary;
  const slug = s.slug;

  const completions = detail.handoffs
    .filter((handoff) => handoff.completed)
    .sort((a, b) => String(a.completed).localeCompare(String(b.completed)));

  return html`
    <div class="stack">
      <div class="grid cols-4">
        <${Tile2} label="Progress" figure=${`${s.percent}%`} note=${`${s.done} of ${s.phases} phases`} />
        <${Tile2} label="Work left" figure=${weight(s.remainingWeight)} note=${`≈ ${s.remainingSessions} session${s.remainingSessions === 1 ? '' : 's'} at ${weight(s.budget)}`} />
        <${Tile2} label="Critical path" figure=${s.criticalPath.length ? `${s.criticalPath.length}` : '0'} note=${s.criticalPath.length ? `P${s.criticalPath.join(' → P')} · min ${s.minimumSessions} session${s.minimumSessions === 1 ? '' : 's'}` : 'nothing left'} />
        <${Tile2} label="Ready now" figure=${String(s.ready.length)} accent=${s.ready.length > 0} note=${s.nextBest ? `best next: P${s.nextBest.phase} (unblocks ${s.nextBest.unblocks})` : 'none'} />
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h3>Where the work is</h3></div>
          <div class="card-body">
            <${KeyValue} items=${[
              ['Bottleneck', s.bottleneck ? html`
                <button class="chip plain" onClick=${() => navigate(phaseHref(slug, s.bottleneck.phase).slice(2))}>
                  P${s.bottleneck.phase}
                </button> holds up ${s.bottleneck.blocks} phase${s.bottleneck.blocks === 1 ? '' : 's'}` : 'nothing is blocking'],
              ['Critical path', s.criticalPath.length ? html`
                <div class="row-wrap">
                  ${s.criticalPath.map((phase) => html`
                    <button class="chip plain" key=${phase} onClick=${() => navigate(phaseHref(slug, phase).slice(2))}>P${phase}</button>`)}
                </div>` : '—'],
              ['Repos touched', s.repos.join(' · ') || '—'],
              ['In progress', s.inProgress.length ? `P${s.inProgress.join(', P')}` : 'none'],
              ['Blocked', s.stuck.length ? `P${s.stuck.join(', P')}` : 'none'],
              ['Median gap between phases', s.medianGapDays != null ? `${s.medianGapDays} day${s.medianGapDays === 1 ? '' : 's'}` : '—'],
              ['Span', s.spanDays != null ? `${s.spanDays} day${s.spanDays === 1 ? '' : 's'} from first to last completion` : '—'],
              ['Last completed', s.lastCompleted ?? '—'],
            ]} />
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Health</h3>
            <span class="faint" style="font-size:var(--text-xs)">${detail.lint?.summary ?? ''}</span>
          </div>
          <div class="card-body">
            ${s.issues.length ? s.issues.map((issue, i) => html`
              <div class=${`issue-row ${issue.severity}`} key=${i}>
                <span class="issue-kind">${issue.kind}</span>
                <span>
                  ${issue.message}
                  ${issue.phase ? html` <button class="chip plain" onClick=${() => navigate(phaseHref(slug, issue.phase).slice(2))}>P${issue.phase}</button>` : null}
                </span>
              </div>`)
              : html`<span class="faint">Nothing to flag — plan, handoffs and index agree.</span>`}
          </div>
        </div>
      </div>

      ${completions.length ? html`
        <div class="card">
          <div class="card-head"><h3>Completion timeline</h3></div>
          <div class="card-body">
            <div class="stack" style="gap:6px">
              ${completions.map((handoff) => html`
                <div class="row" key=${handoff.phase} style="gap:var(--s3)">
                  <span class="mono faint" style="width:96px;font-size:var(--text-xs)">${handoff.completed}</span>
                  <span class="chip size">P${handoff.phase}</span>
                  <span class="truncate">${handoff.title}</span>
                </div>`)}
            </div>
          </div>
        </div>` : null}

      ${detail.qa.length ? html`
        <div class="card">
          <div class="card-head"><h3>QA status</h3><span class="faint" style="font-size:var(--text-xs)">regime: ${s.qaMode}</span></div>
          <div class="card-body table-scroll">
            <table class="table">
              <thead><tr><th style="width:60px">Phase</th><th style="width:100px">Result</th><th>Report</th></tr></thead>
              <tbody>
                ${detail.qa.map((row) => html`
                  <tr key=${row.phase}>
                    <td class="mono">${row.phase}</td>
                    <td>${row.result === 'fail'
                      ? html`<${Chip} kind="warn">fail</${Chip}>`
                      : html`<span class="chip plain">${row.result}</span>`}</td>
                    <td class="mono" style="font-size:var(--text-xs)">${row.report ?? '—'}</td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
        </div>` : null}

      <div class="card">
        <div class="card-head">
          <h3>What the terminal shows</h3>
          <${CopyButton} text=${detail.boardText} label="Copy board" />
        </div>
        <div class="card-body flush"><pre class="code">${detail.boardText}</pre></div>
      </div>
    </div>`;
}

function Tile2({ label, figure, note, accent }) {
  return html`
    <div class=${`tile ${accent ? 'accent' : ''}`}>
      <div class="label">${label}</div>
      <div class="figure">${figure}</div>
      ${note ? html`<div class="note">${note}</div>` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function OverviewTab({ detail }) {
  const plan = detail.plan;
  if (!plan) return html`<${Empty} title="No plan file" hint="This slug has handoffs but no plan in docs/plans." />`;

  return html`
    <div class="detail-grid">
      <div class="stack">
        ${plan.provenance ? html`
          <div class="card"><div class="card-body"><${Markdown} text=${`> ${plan.provenance.replace(/\n/g, '\n> ')}`} /></div></div>` : null}

        ${plan.context ? html`
          <div class="card">
            <div class="card-head"><h3>Context</h3></div>
            <div class="card-body"><${Markdown} text=${plan.context} /></div>
          </div>` : null}

        ${plan.architecture ? html`
          <div class="card">
            <div class="card-head"><h3>Architecture</h3></div>
            <div class="card-body"><${Markdown} text=${plan.architecture} /></div>
          </div>` : null}

        <div class="card">
          <div class="card-head">
            <h3>Phase graph</h3>
            <span class="faint" style="font-size:var(--text-xs)">the machine-read table</span>
          </div>
          <div class="card-body table-scroll">
            <table class="table">
              <thead>
                <tr><th style="width:48px">#</th><th>Title</th><th style="width:110px">Depends on</th>
                <th style="width:120px">Parallel-safe</th><th style="width:140px">Repos</th><th>Exit criteria</th></tr>
              </thead>
              <tbody>
                ${plan.graph.map((row) => html`
                  <tr key=${row.phase} style="cursor:pointer" onClick=${() => navigate(phaseHref(plan.slug, row.phase).slice(2))}>
                    <td class="mono">${row.phase}</td>
                    <td>${row.title}</td>
                    <td class="mono" style="font-size:var(--text-xs)">${row.dependsOn.length ? row.dependsOn.join(', ') : '—'}</td>
                    <td class="mono" style="font-size:var(--text-xs)">${row.parallelSafe || '—'}</td>
                    <td class="mono" style="font-size:var(--text-xs)">${row.repos || '—'}</td>
                    <td style="font-size:var(--text-xs)">${row.exitCriteria}</td>
                  </tr>`)}
              </tbody>
            </table>
            ${plan.callouts.length ? html`
              <div class="card-body" style="padding-top:var(--s3)">
                ${plan.callouts.map((line, i) => html`<div key=${i}><${Markdown} text=${line} /></div>`)}
              </div>` : null}
          </div>
        </div>

        ${plan.endToEnd ? html`
          <div class="card">
            <div class="card-head"><h3>End-to-end verification</h3></div>
            <div class="card-body"><${Markdown} text=${plan.endToEnd} /></div>
          </div>` : null}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>Session budget</h3></div>
          <div class="card-body"><${Markdown} text=${plan.sessionBudget.raw} /></div>
        </div>

        ${detail.memory ? html`
          <div class="card">
            <div class="card-head">
              <h3>Memory</h3>
              <span class="mono faint" style="font-size:var(--text-2xs)">${detail.memory.key}</span>
            </div>
            <div class="card-body" style="max-height:520px;overflow:auto">
              <${Markdown} text=${detail.memory.text} />
            </div>
          </div>`
          : html`
            <div class="card">
              <div class="card-head"><h3>Memory</h3></div>
              <div class="card-body faint">
                No <code>${detail.summary.slug}</code> memory entry found in the Claude memory directories.
              </div>
            </div>`}

        ${detail.locks.length ? html`
          <div class="card">
            <div class="card-head"><h3>Locks</h3></div>
            <div class="card-body">
              ${detail.locks.map((lock) => html`
                <div class="row" key=${lock.phase} style="justify-content:space-between">
                  <span class="chip size">P${lock.phase}</span>
                  <span class="mono truncate" style="font-size:var(--text-xs)">${lock.owner}</span>
                  <span class="faint" style="font-size:var(--text-xs)">${lock.expired ? 'expired' : countdown(lock.leaseUntil)}</span>
                </div>`)}
            </div>
          </div>` : null}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Raw
 * ------------------------------------------------------------------ */

function RawTab({ slug }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    let live = true;
    api.planRaw(slug).then((body) => { if (live) setText(body); }).catch(() => { if (live) setText(''); });
    return () => { live = false; };
  }, [slug]);

  if (text == null) return html`<${Spinner} label="Reading plan" />`;
  return html`
    <div class="card">
      <div class="card-head">
        <h3>docs/plans/${slug}.md</h3>
        <${CopyButton} text=${text} label="Copy markdown" />
      </div>
      <div class="card-body flush"><pre class="code wrap" style="max-height:70vh;overflow:auto">${text}</pre></div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function PlanView({ slug, tab, arg, state }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const active = tab ?? 'route';

  const load = useCallback(() => {
    let live = true;
    setError(null);
    api.plan(slug)
      .then((result) => { if (live) setDetail(result); })
      .catch((failure) => { if (live) setError(String(failure.message ?? failure)); });
    return () => { live = false; };
  }, [slug, nonce]);

  useEffect(() => { setDetail(null); return load(); }, [load]);

  const tabs = useMemo(() => TABS.map((entry) => ({
    ...entry,
    count: entry.id === 'handoffs' ? detail?.handoffs.length
      : entry.id === 'phases' ? detail?.phases.length
        : undefined,
  })), [detail]);

  if (error) return html`<div class="page"><${Banner} kind="error">${error}</${Banner}></div>`;
  if (!detail) return html`<div class="page"><${Spinner} label="Reading plan" /></div>`;

  const onChanged = () => setNonce((n) => n + 1);

  let body;
  if (active === 'phase') body = html`<${PhasePanel} detail=${detail} phase=${arg} state=${state} onChanged=${onChanged} />`;
  else if (active === 'handoff') body = html`<${HandoffPanel} detail=${detail} phase=${arg} />`;
  else if (active === 'phases') body = html`<${PhasesTab} detail=${detail} />`;
  else if (active === 'handoffs') body = html`<${HandoffsTab} detail=${detail} />`;
  else if (active === 'analysis') body = html`<${AnalysisTab} detail=${detail} />`;
  else if (active === 'overview') body = html`<${OverviewTab} detail=${detail} />`;
  else if (active === 'raw') body = html`<${RawTab} slug=${slug} />`;
  else if (active === 'run') body = html`<${RunView} slug=${slug} state=${state} />`;
  else body = html`<${RouteTab} detail=${detail} />`;

  const tabId = ['phase', 'handoff'].includes(active) ? (active === 'phase' ? 'phases' : 'handoffs') : active;

  return html`
    <div class="page">
      <${PlanHeader} detail=${detail} state=${state} onChanged=${onChanged} />
      <${Tabs} tabs=${tabs} active=${tabId} onSelect=${(id) => navigate(planHref(slug, id).slice(2))} />
      <div style="margin-top:var(--s4)">
        ${['phase', 'handoff'].includes(active) ? html`
          <div class="row" style="margin-bottom:var(--s3)">
            <button class="btn ghost small" onClick=${() => navigate(planHref(slug, active === 'phase' ? 'phases' : 'handoffs').slice(2))}>
              ← All ${active === 'phase' ? 'phases' : 'handoffs'}
            </button>
          </div>` : null}
        ${body}
      </div>
    </div>`;
}

function PhasesTab({ detail }) {
  const slug = detail.summary.slug;
  return html`
    <div class="stack">
      ${detail.phases.map((phase) => html`
        <button
          class=${`plan-row ${phase.state === 'ready' ? 'has-ready' : ''}`}
          key=${phase.phase}
          style="grid-template-columns:56px minmax(0,1fr) 120px 120px"
          onClick=${() => navigate(phaseHref(slug, phase.phase).slice(2))}>
          <span class="phase-num mono" style="font-size:var(--text-xl)">${String(phase.phase).padStart(2, '0')}</span>
          <span style="min-width:0">
            <span class="plan-title truncate" style="display:block">${phase.title}</span>
            <span class="plan-slug truncate" style="display:block">
              ${phase.goal ? phase.goal.replace(/[*`]/g, '').slice(0, 110) : (phase.row?.exitCriteria ?? '')}
            </span>
          </span>
          <span><${StateChip} state=${phase.state} board=${true} /></span>
          <span class="row" style="justify-content:flex-end;gap:4px">
            <span class="chip size">${phase.size}</span>
            ${phase.gated ? html`<${Chip} kind="gate">gate</${Chip}>` : null}
            ${phase.handoff ? html`<span class="tag">H</span>` : null}
          </span>
        </button>`)}
    </div>`;
}
