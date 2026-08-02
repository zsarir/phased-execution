/**
 * The autopilot view: what the run is doing, and the controls to change it.
 *
 * Two audiences at once. Sitting at the desk you want the transcript, the
 * costs and the board. On a phone at 11pm you want one question answered —
 * "does this need me?" — so approvals come first, carry their evidence, and
 * are answerable without scrolling past anything.
 *
 * Every number here comes from the server's run state. Nothing is recomputed
 * in the browser, for the same reason the board never is: two sources of truth
 * disagree eventually, and the one on screen is the one that gets believed.
 */

import { html, useState, useEffect, useCallback } from '../html.js';
import { api, subscribeRun } from '../api.js';
import { toast } from '../store.js';
import { Banner, Chip, Empty, Modal, Spinner, Tile, relativeTime } from '../components/ui.js';
import { LiveConsole, useLiveLines, toLine } from '../components/live-console.js';

const PHASE_TONE = {
  done: 'ok', running: 'busy', verifying: 'busy', failed: 'bad',
  parked: 'warn', interrupted: 'warn', gated: 'warn', skipped: '', pending: '',
};

const RUN_TONE = {
  running: 'busy', finished: 'ok', halted: 'bad', parked: 'warn',
  waiting: 'warn', paused: '', pausing: '', stopping: '',
};

export function RunView({ slug, state }) {
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const { lines, push, clear } = useLiveLines();

  // The client is served fresh from disk; the server is whatever Node loaded at
  // startup. Upgrading the skill under a running console leaves this page
  // talking to an API that has no run endpoints, and the honest thing to show
  // is why — not a stack of failed requests.
  const stale = state && !state.autopilot;

  const refresh = useCallback(async () => {
    if (stale) { setLoading(false); return; }
    try {
      const [detail, queue] = await Promise.all([api.run(slug), api.approvals()]);
      setRun(detail.run);
      setHistory(detail.history ?? []);
      setApprovals(queue.filter((a) => a.status === 'pending'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [slug, stale]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => stale ? undefined : subscribeRun({
    run: () => void refresh(),
    approval: () => void refresh(),
    phase: (data) => { push(toLine('phase', data)); void refresh(); },
    verify: (data) => push(toLine('verify', data)),
    stream: (data) => push(toLine('stream', data)),
  }), [refresh, push, stale]);

  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); await refresh(); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(''); }
  };

  if (stale) {
    return html`
      <${Banner} kind="warn">
        <strong>This console is running an older build.</strong> The page you are looking at was
        loaded from disk, but the server behind it started before the autopilot existed, so its
        run endpoints are not there — that is what the 404s in the browser console are.
        <p style="margin-top:8px">Stop it and start it again to pick up the new server. Adding
        <code>--allow-run</code> is what actually turns the autopilot on; without it this page
        works but stays read-only.</p>
      </${Banner}>`;
  }

  if (loading) return html`<${Spinner} label="Reading run state" />`;

  const live = run && ['running', 'waiting', 'pausing', 'stopping'].includes(run.status);
  const phases = Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase);

  // No page wrapper or heading: this renders inside the plan's own page, which
  // has already said which plan you are looking at.
  return html`
    <div class="run-view">
      ${run ? html`
        <div class="row spread" style="margin-bottom:var(--s3)">
          <span class="muted small">run <code>${run.id}</code> · started ${relativeTime(Date.parse(run.createdAt))}</span>
          <${Chip} kind=${RUN_TONE[run.status] ?? ''}>${run.status}</${Chip}>
        </div>` : null}

      ${!state.allowRun ? html`
        <${Banner} kind="warn">
          This console is read-only for runs. Restart it with <code>--allow-run</code> to start,
          pause or approve anything. You can still watch a run that another console started.
        </${Banner}>` : null}

      <${ApprovalQueue}
        approvals=${approvals}
        allowRun=${state.allowRun}
        onDecide=${(id, decision, reason) => act('decide', async () => {
          await api.decide(id, decision, reason);
          toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
        })} />

      ${run?.halt ? html`
        <${Banner} kind="error">
          <strong>Halted.</strong> ${run.halt.reason}
          ${run.halt.phase != null ? html` <span class="muted">(phase ${run.halt.phase})</span>` : null}
        </${Banner}>` : null}

      ${run?.waitUntil ? html`
        <${Banner} kind="warn">
          Waiting for a usage window to reopen at ${new Date(run.waitUntil).toLocaleString()}.
          Nothing is wrong — the run resumes by itself.
        </${Banner}>` : null}

      <${Controls}
        slug=${slug} run=${run} live=${live} busy=${busy}
        allowRun=${state.allowRun}
        onAct=${act} />

      ${run ? html`
        <div class="tiles">
          <${Tile} label="Spent" figure=${`$${(run.spentUsd ?? 0).toFixed(2)}`}
                   note=${run.runBudgetUsd ? `of $${run.runBudgetUsd}` : 'no run budget set'} />
          <${Tile} label="Phases done" figure=${phases.filter((p) => p.status === 'done').length}
                   unit=${`/ ${phases.length || '—'}`} />
          <${Tile} label="Model" figure=${run.model} note=${run.autonomy} />
          <${Tile} label="Updated" figure=${relativeTime(Date.parse(run.updatedAt))} />
        </div>` : null}

      ${run ? html`<${PhaseTable} slug=${slug} run=${run} phases=${phases} allowRun=${state.allowRun} onAct=${act} />` : html`
        <${Empty}
          title="No run yet"
          hint=${`Nothing has been run for ${slug}. Starting one works the same whether the plan is fresh or half finished — the board decides where to begin.`} />`}

      <${LiveConsole}
        lines=${lines}
        onClear=${clear}
        subtitle=${run?.activePhase ? `phase ${run.activePhase} · ${run.model}` : run?.status ?? 'idle'} />

      ${history.length > 1 ? html`
        <section class="card">
          <h2 class="card-title">Earlier runs</h2>
          <table class="table">
            <tbody>
              ${history.slice(1).map((r) => html`
                <tr key=${r.id}>
                  <td><code>${r.id}</code></td>
                  <td><${Chip} kind=${RUN_TONE[r.status] ?? ''}>${r.status}</${Chip}></td>
                  <td class="muted">${relativeTime(Date.parse(r.updatedAt))}</td>
                  <td class="num">$${(r.spentUsd ?? 0).toFixed(2)}</td>
                </tr>`)}
            </tbody>
          </table>
        </section>` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function Controls({ slug, run, live, busy, allowRun, onAct }) {
  const [model, setModel] = useState(run?.model ?? 'sonnet');
  const [autonomy, setAutonomy] = useState(run?.autonomy ?? 'halt-on-everything');
  const [phaseBudget, setPhaseBudget] = useState(run?.phaseBudgetUsd ?? '');
  const [runBudget, setRunBudget] = useState(run?.runBudgetUsd ?? '');
  const [confirmStop, setConfirmStop] = useState(false);

  const resumable = run && !live && run.status !== 'finished';
  const disabled = !allowRun || Boolean(busy);

  return html`
    <section class="card">
      <div class="row spread">
        <h2 class="card-title">
          ${live ? 'Running' : resumable ? 'Continue this run' : 'Start a run'}
        </h2>
        <span class="muted small">
          ${resumable
            ? 'Picks up from the board, not from a saved position.'
            : 'Fresh or half-finished is the same button — the done-set decides where it begins.'}
        </span>
      </div>

      <div class="row wrap" style="gap:10px;margin:10px 0">
        <label class="field">
          <span>Model</span>
          <select value=${model} disabled=${live || disabled} onChange=${(e) => setModel(e.target.value)}>
            ${['opus', 'sonnet', 'haiku'].map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>If something is unclear</span>
          <select value=${autonomy} disabled=${live || disabled} onChange=${(e) => setAutonomy(e.target.value)}>
            <option value="halt-on-everything">Stop and ask me</option>
            <option value="keep-going">Keep going where it safely can</option>
          </select>
        </label>
        <label class="field">
          <span>Budget per phase ($)</span>
          <input type="number" min="0" step="0.5" value=${phaseBudget} disabled=${live || disabled}
                 onInput=${(e) => setPhaseBudget(e.target.value)} placeholder="none" />
        </label>
        <label class="field">
          <span>Budget for the run ($)</span>
          <input type="number" min="0" step="1" value=${runBudget} disabled=${live || disabled}
                 onInput=${(e) => setRunBudget(e.target.value)} placeholder="none" />
        </label>
      </div>

      <div class="row wrap" style="gap:8px">
        ${!live ? html`
          <button class="btn primary" disabled=${disabled}
                  onClick=${() => onAct('start', () => api.runStart(slug, {
                    model, autonomy,
                    phaseBudgetUsd: Number(phaseBudget) || null,
                    runBudgetUsd: Number(runBudget) || null,
                    resumeRunId: resumable ? run.id : undefined,
                  }))}>
            ${busy === 'start' ? 'Starting…' : resumable ? 'Continue' : 'Start'}
          </button>` : html`
          <button class="btn" disabled=${disabled}
                  onClick=${() => onAct('pause', () => api.runPause(slug))}>
            ${busy === 'pause' ? 'Pausing…' : 'Pause after this phase'}
          </button>
          <button class="btn danger" disabled=${disabled} onClick=${() => setConfirmStop(true)}>
            ${busy === 'stop' ? 'Stopping…' : 'Stop now'}
          </button>`}
        ${!allowRun ? html`<span class="muted small">Controls need <code>--allow-run</code>.</span>` : null}
      </div>

      ${confirmStop ? html`
        <${Modal}
          title="Stop the run now?"
          onClose=${() => setConfirmStop(false)}
          footer=${html`
            <button class="btn" onClick=${() => setConfirmStop(false)}>Keep running</button>
            <button class="btn danger" onClick=${() => { setConfirmStop(false); onAct('stop', () => api.runStop(slug)); }}>
              Stop now
            </button>`}>
          <p>
            The session gets SIGTERM, so its own end-of-session hooks still run. Anything it has
            already written to the repository stays written — stopping does not undo work.
          </p>
          <p class="muted">
            The phase is recorded as <strong>interrupted</strong> rather than failed, because a phase
            cut off partway may have half-finished something. Continuing later will ask you about it
            instead of silently running it again.
          </p>
        </${Modal}>` : null}
    </section>`;
}

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

function PhaseTable({ slug, run, phases, allowRun, onAct }) {
  if (!phases.length) {
    return html`<${Empty} title="No phases attempted yet" hint="The first one appears here as soon as it starts." />`;
  }
  return html`
    <section class="card">
      <h2 class="card-title">Phases in this run</h2>
      <table class="table">
        <thead>
          <tr><th>Phase</th><th>Status</th><th>Tries</th><th class="num">Cost</th><th>Notes</th><th></th></tr>
        </thead>
        <tbody>
          ${phases.map((p) => html`
            <tr key=${p.phase} class=${run.activePhase === p.phase ? 'is-active' : ''}>
              <td><a href=${`#/plan/${encodeURIComponent(slug)}/phase/${p.phase}`}>Phase ${p.phase}</a></td>
              <td><${Chip} kind=${PHASE_TONE[p.status] ?? ''}>${p.status}</${Chip}></td>
              <td>${p.attempts}</td>
              <td class="num">$${(p.costUsd ?? 0).toFixed(2)}</td>
              <td class="muted small">
                ${p.note ?? ''}
                ${p.verification ? html`
                  <div class=${p.verification.ok ? 'ok' : 'bad'}>${p.verification.reason}</div>` : null}
                ${p.verification?.notRun?.length ? html`
                  <details>
                    <summary>${p.verification.notRun.length} step(s) a person must check</summary>
                    <ul>${p.verification.notRun.map((n, i) => html`
                      <li key=${i}><code>${n.text}</code> — ${n.reason}</li>`)}</ul>
                  </details>` : null}
              </td>
              <td class="row" style="gap:4px">
                ${allowRun && ['failed', 'interrupted', 'parked'].includes(p.status) ? html`
                  <button class="btn small" onClick=${() => onAct('retry', () => api.runRetry(slug, p.phase))}>Retry</button>` : null}
                ${allowRun && p.status !== 'done' && p.status !== 'skipped' ? html`
                  <button class="btn small" onClick=${() => onAct('skip', () => api.runSkip(slug, p.phase))}>Skip</button>` : null}
              </td>
            </tr>`)}
        </tbody>
      </table>
    </section>`;
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

function ApprovalQueue({ approvals, allowRun, onDecide }) {
  if (!approvals.length) return null;
  return html`
    <section class="card approvals">
      <h2 class="card-title">
        Waiting on you
        <span class="count hot">${approvals.length}</span>
      </h2>
      ${approvals.map((a) => html`<${ApprovalCard} key=${a.id} approval=${a} allowRun=${allowRun} onDecide=${onDecide} />`)}
    </section>`;
}

function ApprovalCard({ approval, allowRun, onDecide }) {
  const [reason, setReason] = useState('');
  const left = Math.max(0, Date.parse(approval.expiresAt) - Date.now());

  return html`
    <article class="approval">
      <div class="row spread">
        <strong>${approval.title}</strong>
        <span class="muted small">
          ${approval.phase != null ? `phase ${approval.phase} · ` : ''}
          ${left > 0 ? `${Math.ceil(left / 60000)} min to answer` : 'expiring'}
        </span>
      </div>
      <p class="muted">${approval.detail}</p>

      ${approval.tool?.input?.command ? html`
        <pre class="code">${approval.tool.input.command}</pre>` : null}

      ${approval.evidence?.length ? html`
        <div class="evidence">
          ${approval.evidence.map((e, i) => html`
            <details key=${i} open=${i === 0}>
              <summary>${e.label}</summary>
              <pre class="code">${e.body}</pre>
            </details>`)}
        </div>` : null}

      <div class="row wrap" style="gap:8px;margin-top:8px">
        <input class="grow" placeholder="Why (optional — the session is told)"
               value=${reason} onInput=${(e) => setReason(e.target.value)} />
        <button class="btn primary" disabled=${!allowRun}
                onClick=${() => onDecide(approval.id, 'allow', reason)}>Allow</button>
        <button class="btn danger" disabled=${!allowRun}
                onClick=${() => onDecide(approval.id, 'deny', reason)}>Deny</button>
      </div>
      ${!allowRun ? html`
        <p class="muted small">This console cannot answer — it was started without <code>--allow-run</code>.</p>` : null}
    </article>`;
}

/* ------------------------------------------------------------------ *
 * Every run, across every plan
 * ------------------------------------------------------------------ */

/**
 * Operations across every plan: what is running, what is waiting on a person,
 * and the live session console for whichever run is active. This is the page to
 * leave open on a second monitor.
 */
export function RunsView({ state }) {
  const [runs, setRuns] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const { lines, push, clear } = useLiveLines();

  const refresh = useCallback(async () => {
    if (state && !state.autopilot) { setRuns([]); return; }
    try {
      const [all, queue] = await Promise.all([api.runs(), api.approvals()]);
      setRuns(all);
      setApprovals(queue.filter((a) => a.status === 'pending'));
    } catch (error) { toast(error.message, 'error'); setRuns([]); }
  }, [state?.autopilot]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => (state && !state.autopilot) ? undefined : subscribeRun({
    run: refresh,
    approval: refresh,
    phase: (data) => { push(toLine('phase', data)); void refresh(); },
    verify: (data) => push(toLine('verify', data)),
    stream: (data) => push(toLine('stream', data)),
  }), [refresh, push, state?.autopilot]);

  if (state && !state.autopilot) {
    return html`
      <div class="page">
        <${Banner} kind="warn">
          <strong>This console is running an older build.</strong> Restart it to pick up the run
          endpoints — the page you are looking at was loaded from disk, but the server behind it
          started before the autopilot existed.
        </${Banner}>
      </div>`;
  }
  if (!runs) return html`<div class="page"><${Spinner} label="Reading runs" /></div>`;

  const active = runs.find((r) => ['running', 'waiting', 'pausing', 'stopping'].includes(r.status));

  return html`
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Runs</h1>
          <p class="sub">
            ${active ? html`<strong>${active.slug}</strong> is running — phase ${active.activePhase ?? '?'}`
              : 'Nothing running right now'}
          </p>
        </div>
        ${approvals.length ? html`<${Chip} kind="warn">${approvals.length} waiting on you</${Chip}>` : null}
      </header>

      <${ApprovalQueue}
        approvals=${approvals}
        allowRun=${state?.allowRun}
        onDecide=${async (id, decision, reason) => {
          try {
            await api.decide(id, decision, reason);
            toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
            await refresh();
          } catch (error) { toast(error.message, 'error'); }
        }} />

      <${LiveConsole}
        lines=${lines}
        onClear=${clear}
        title="Session console"
        subtitle=${active ? `${active.slug} · phase ${active.activePhase ?? '?'} · ${active.model}` : 'idle'} />

      ${runs.length ? html`
        <section class="card" style="margin-top:var(--s4)">
          <table class="table">
            <thead><tr><th>Plan</th><th>Run</th><th>Status</th><th>Phase</th><th class="num">Spent</th><th>Updated</th></tr></thead>
            <tbody>
              ${runs.map((r) => html`
                <tr key=${`${r.slug}-${r.id}`}>
                  <td><a href=${`#/plan/${encodeURIComponent(r.slug)}/run`}>${r.slug}</a></td>
                  <td><code>${r.id}</code></td>
                  <td><${Chip} kind=${RUN_TONE[r.status] ?? ''}>${r.status}</${Chip}></td>
                  <td>${r.activePhase ?? '—'}</td>
                  <td class="num">$${(r.spentUsd ?? 0).toFixed(2)}</td>
                  <td class="muted">${relativeTime(Date.parse(r.updatedAt))}</td>
                </tr>`)}
            </tbody>
          </table>
        </section>`
        : html`<${Empty}
            title="No runs yet"
            hint="Open a plan and use its Autopilot tab to start one. Runs are recorded outside the repository, so nothing here shows up in git status." />`}
    </div>`;
}

export { PHASE_TONE, RUN_TONE };
