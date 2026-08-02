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
import { SkillPicker } from '../components/skill-picker.js';
import { announceRun, announceApproval, notifyState, askToNotify } from '../notify.js';

const PHASE_TONE = {
  done: 'ok', running: 'busy', verifying: 'busy', failed: 'bad',
  parked: 'warn', interrupted: 'warn', gated: 'warn', skipped: '', pending: '',
  'awaiting-verification': 'warn',
};

const RUN_TONE = {
  running: 'busy', finished: 'ok', halted: 'bad', parked: 'warn',
  // `pausing` is a state the operator asked for and is waiting on, so it reads
  // as one. Neutral grey made an armed pause look identical to an idle run,
  // which is half the reason pressing Pause felt like nothing had happened.
  waiting: 'warn', paused: '', pausing: 'warn', stopping: 'warn', interrupted: 'warn',
};

/** Statuses that mean a loop is genuinely behind this run right now. */
const LIVE_STATUSES = ['running', 'waiting', 'pausing', 'stopping'];

/** Wall-clock, at the precision a person reading a phase table cares about. */
function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function RunView({ slug, state, planPhases = [], planSkills = [] }) {
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [auth, setAuth] = useState(null);
  const [skills, setSkills] = useState([]);
  const { lines, push, clear, hydrate } = useLiveLines();

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

  // Replay before subscribing, so the window is populated on arrival rather
  // than waiting for the next thing to happen — which, on a run that already
  // finished, is never.
  useEffect(() => {
    if (stale) return;
    api.runTranscript(slug).then(hydrate).catch(() => { /* a missing replay is not worth a toast */ });
  }, [slug, stale, hydrate]);

  const checkAuth = useCallback(async (force) => {
    try { setAuth(await api.auth(force)); } catch { /* the card simply stays hidden */ }
  }, []);
  useEffect(() => { if (!stale) void checkAuth(false); }, [stale, checkAuth]);

  // Cached by the api layer, so switching tabs does not rescan a few hundred
  // SKILL.md files; an empty list simply hides the picker.
  useEffect(() => {
    if (stale) return;
    api.skills().then(setSkills).catch(() => { /* the picker stays empty */ });
  }, [stale]);

  useEffect(() => stale ? undefined : subscribeRun({
    run: (data) => { announceRun(data?.state); void refresh(); },
    // Actions taken against a run no loop is driving — a pause or a stop from
    // another tab, or from a phone — arrive on this channel and nowhere else.
    state: (data) => { announceRun(data?.state); void refresh(); },
    approval: (data) => { announceApproval(data); void refresh(); },
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

  const live = run && LIVE_STATUSES.includes(run.status);
  const phases = Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase);
  const authBroken = auth && auth.loggedIn === false;

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

      ${authBroken || /sign(ed)? in|authenticat/i.test(run?.halt?.reason ?? '') ? html`
        <${AuthCard} auth=${auth} allowRun=${state.allowRun} onRecheck=${() => checkAuth(true)} />` : null}

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

      ${run?.status === 'pausing' ? html`
        <${Banner} kind="warn">
          <strong>Pause armed.</strong>
          ${run.pause?.afterPhase != null
            ? html` Phase ${run.pause.afterPhase} will finish and be verified, then the run stops.`
            : html` The run stops at the next phase boundary.`}
          ${run.pause?.requestedAt
            ? html` <span class="muted">(asked for ${relativeTime(Date.parse(run.pause.requestedAt))})</span>`
            : null}
          <p style="margin-top:8px" class="muted">
            Nothing is cut off — a pause always waits for a phase to reach a boundary, so the work
            in flight is finished and checked rather than abandoned. Use <strong>Stop now</strong> if
            you need it to end sooner than that.
          </p>
        </${Banner}>` : null}

      ${run?.status === 'paused' ? html`
        <${Banner} kind="info">
          <strong>Paused between phases.</strong> Continue picks up from the board, so nothing has to
          be remembered about where it stopped.
        </${Banner}>` : null}

      <${Controls}
        slug=${slug} run=${run} live=${live} busy=${busy}
        allowRun=${state.allowRun}
        planPhases=${planPhases}
        planSkills=${planSkills}
        skills=${skills}
        onAct=${act} />

      ${run ? html`
        <div class="tiles">
          <${Tile} label="Spent" figure=${`$${(run.spentUsd ?? 0).toFixed(2)}`}
                   note=${run.runBudgetUsd ? `of $${run.runBudgetUsd}` : 'no run budget set'} />
          <${Tile} label="Phases done" figure=${phases.filter((p) => p.status === 'done').length}
                   unit=${`/ ${phases.length || '—'}`} />
          <${Tile} label="Model" figure=${run.model} note=${`${run.effort ?? 'default'} effort · ${run.autonomy}`} />
          ${run.limits?.utilization != null ? html`
            <${Tile}
              label=${`${(run.limits.window ?? 'usage').replace(/_/g, ' ')} window`}
              figure=${`${Math.round(run.limits.utilization * 100)}%`}
              note=${run.limits.resetsAt
                ? `used · resets ${new Date(run.limits.resetsAt * 1000).toLocaleString()}`
                : 'used'} />`
            : html`<${Tile} label="Updated" figure=${relativeTime(Date.parse(run.updatedAt))} />`}
        </div>` : null}

      ${run?.limits && run.limits.status !== 'allowed' && (run.limits.utilization ?? 0) >= 0.75 ? html`
        <${Banner} kind="warn">
          <strong>${Math.round((run.limits.utilization ?? 0) * 100)}% of your
          ${(run.limits.window ?? 'usage').replace(/_/g, ' ')} window is used.</strong>
          ${run.limits.resetsAt
            ? html` It resets ${new Date(run.limits.resetsAt * 1000).toLocaleString()}.` : null}
          A long run started now may stop partway and wait — the session reports this itself, so it
          is the account's own figure rather than an estimate.
        </${Banner}>` : null}

      ${run ? html`<${PhaseTable} slug=${slug} run=${run} phases=${phases} live=${live} allowRun=${state.allowRun} onAct=${act} />` : html`
        <${Empty}
          title="No run yet"
          hint=${`Nothing has been run for ${slug}. Starting one works the same whether the plan is fresh or half finished — the board decides where to begin.`} />`}

      <${LiveConsole}
        lines=${lines}
        onClear=${clear}
        subtitle=${run?.activePhase ? `phase ${run.activePhase} · ${run.model}` : run?.status ?? 'idle'}
        footer=${html`
          <${AskBox}
            slug=${slug}
            enabled=${Boolean(state.allowRun && live && run?.activePhase != null)}
            allowRun=${state.allowRun}
            phase=${run?.activePhase}
            onAsked=${(text) => push({ kind: 'injected', text })} />`} />

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

/** Every model the autopilot may start a phase on, strongest first. */
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * The five the CLI accepts. Blank means "whatever this machine's settings
 * default to", which is what every run did before there was a control for it.
 */
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const EFFORT_NOTE = {
  '': "this machine's default",
  low: 'fastest and cheapest — mechanical phases',
  medium: 'balanced',
  high: 'most implementation phases',
  xhigh: 'hard reasoning',
  max: 'the hardest phases, and the slowest',
};

/**
 * Per-phase model and effort.
 *
 * Three things can decide what a phase runs as, and the table says which did.
 * The plan's own `**Model:**` / `**Effort:**` bullets have been in the format
 * from the beginning and were read by nothing, so a phase that said it wanted
 * Opus quietly ran on whatever the run defaulted to; here they show as the
 * inherited value, and choosing something overrules them for this run only —
 * per field, so setting a model does not discard an effort the plan asked for.
 */
function PhaseMatrix({ planPhases, overrides, runModel, runEffort, skills = [], disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const [skillsFor, setSkillsFor] = useState(null);
  if (!planPhases.length) return null;

  const set = (phase, key, value) => {
    const next = { ...overrides, [phase]: { ...(overrides[phase] ?? {}) } };
    if (value && (!Array.isArray(value) || value.length)) next[phase][key] = value;
    else delete next[phase][key];
    if (!Object.keys(next[phase]).length) delete next[phase];
    onChange(next);
  };

  const count = Object.keys(overrides).length;

  return html`
    <details class="phase-matrix" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Per phase
        ${count ? html` <span class="chip">${count} overridden</span>` : html`
          <span class="muted small"> — every phase inherits the run's model and effort</span>`}
      </summary>
      <table class="table">
        <thead>
          <tr>
            <th>Phase</th><th></th>
            <th style="width:120px">Model</th><th style="width:120px">Effort</th>
            ${skills.length ? html`<th style="width:110px">Skills</th>` : null}
          </tr>
        </thead>
        <tbody>
          ${planPhases.map((p) => {
            const own = overrides[p.phase] ?? {};
            // What it would run as with nothing chosen here: the plan if the
            // plan says, otherwise the run's own default.
            const planModel = modelAlias(p.model);
            const planEffort = effortAlias(p.effort);
            const inheritModel = planModel ? `${planModel} (plan)` : `${runModel} (run)`;
            const inheritEffort = planEffort ? `${planEffort} (plan)` : `${runEffort || 'default'} (run)`;
            return html`
              <tr key=${p.phase} class=${p.state === 'done' ? 'muted' : ''}>
                <td><strong>${p.phase}</strong></td>
                <td class="small">
                  ${p.title}
                  ${p.state === 'done' ? html` <span class="muted">· done</span>` : null}
                </td>
                <td>
                  <select value=${own.model ?? ''} disabled=${disabled}
                          onChange=${(e) => set(p.phase, 'model', e.target.value)}>
                    <option value="">${inheritModel}</option>
                    ${MODELS.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
                  </select>
                </td>
                <td>
                  <select value=${own.effort ?? ''} disabled=${disabled}
                          onChange=${(e) => set(p.phase, 'effort', e.target.value)}>
                    <option value="">${inheritEffort}</option>
                    ${EFFORTS.filter(Boolean).map((e) => html`<option key=${e} value=${e}>${e}</option>`)}
                  </select>
                </td>
                ${skills.length ? html`
                  <td>
                    <button class="btn small" disabled=${disabled}
                            onClick=${() => setSkillsFor(skillsFor === p.phase ? null : p.phase)}>
                      ${own.skills?.length ? `${own.skills.length} extra` : 'add'}
                    </button>
                  </td>` : null}
              </tr>
              ${skillsFor === p.phase ? html`
                <tr key=${`${p.phase}-skills`}>
                  <td colspan="5">
                    <${SkillPicker}
                      label=${`Extra skills for phase ${p.phase} only`}
                      skills=${skills}
                      chosen=${own.skills ?? []}
                      disabled=${disabled}
                      onChange=${(next) => set(p.phase, 'skills', next)} />
                  </td>
                </tr>` : null}`;
          })}
        </tbody>
      </table>
      <p class="muted small">
        A phase already running keeps what it started with — these apply to phases that have not
        begun. Clearing a row hands it back to the plan, or to the run's own default.
      </p>
    </details>`;
}

/** Plans write these as prose; only a known alias is a choice. */
function modelAlias(text) {
  const match = /\b(fable|opus|sonnet|haiku)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

function effortAlias(text) {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

function Controls({ slug, run, live, busy, allowRun, planPhases = [], planSkills = [], skills = [], onAct }) {
  const [model, setModel] = useState(run?.model ?? 'sonnet');
  const [effort, setEffort] = useState(run?.effort ?? '');
  const [autonomy, setAutonomy] = useState(run?.autonomy ?? 'halt-on-everything');
  const [phaseBudget, setPhaseBudget] = useState(run?.phaseBudgetUsd ?? '');
  const [runBudget, setRunBudget] = useState(run?.runBudgetUsd ?? '');
  const [overrides, setOverrides] = useState(run?.phaseOptions ?? {});
  const [runSkills, setRunSkills] = useState(run?.skills ?? []);
  const [confirmStop, setConfirmStop] = useState(false);

  // Follow the run when it changes underneath us — a different run id, or the
  // server applying settings we did not send. Without this the form keeps
  // showing whatever it was first mounted with, which is a quiet way to start a
  // run on a model the operator can see on screen and did not choose.
  useEffect(() => {
    setModel(run?.model ?? 'sonnet');
    setEffort(run?.effort ?? '');
    setAutonomy(run?.autonomy ?? 'halt-on-everything');
    setPhaseBudget(run?.phaseBudgetUsd ?? '');
    setRunBudget(run?.runBudgetUsd ?? '');
    setOverrides(run?.phaseOptions ?? {});
    setRunSkills(run?.skills ?? []);
  }, [run?.id, run?.model, run?.effort, run?.autonomy, run?.phaseBudgetUsd, run?.runBudgetUsd]);

  const resumable = run && !live && run.status !== 'finished';
  const disabled = !allowRun || Boolean(busy);
  const pausing = run?.status === 'pausing';
  const stopping = run?.status === 'stopping';

  const settings = {
    model,
    effort,
    autonomy,
    phaseBudgetUsd: Number(phaseBudget) || null,
    runBudgetUsd: Number(runBudget) || null,
    phaseOptions: overrides,
    skills: runSkills,
  };
  const changed = live && (
    model !== run?.model
    || effort !== (run?.effort ?? '')
    || autonomy !== run?.autonomy
    || (Number(phaseBudget) || null) !== (run?.phaseBudgetUsd ?? null)
    || (Number(runBudget) || null) !== (run?.runBudgetUsd ?? null)
    || JSON.stringify(overrides) !== JSON.stringify(run?.phaseOptions ?? {})
    || JSON.stringify(runSkills) !== JSON.stringify(run?.skills ?? [])
  );

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
          <select value=${model} disabled=${disabled} onChange=${(e) => setModel(e.target.value)}>
            ${MODELS.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Effort</span>
          <select value=${effort} disabled=${disabled} onChange=${(e) => setEffort(e.target.value)}>
            ${EFFORTS.map((e) => html`
              <option key=${e} value=${e}>${e || 'default'}${e ? '' : ''}</option>`)}
          </select>
          <span class="muted small">${EFFORT_NOTE[effort]}</span>
        </label>
        <label class="field">
          <span>If something is unclear</span>
          <select value=${autonomy} disabled=${disabled} onChange=${(e) => setAutonomy(e.target.value)}>
            <option value="halt-on-everything">Stop and ask me</option>
            <option value="keep-going">Keep going where it safely can</option>
          </select>
        </label>
        <label class="field">
          <span>Budget per phase ($)</span>
          <input type="number" min="0" step="0.5" value=${phaseBudget} disabled=${disabled}
                 onInput=${(e) => setPhaseBudget(e.target.value)} placeholder="none" />
        </label>
        <label class="field">
          <span>Budget for the run ($)</span>
          <input type="number" min="0" step="1" value=${runBudget} disabled=${disabled}
                 onInput=${(e) => setRunBudget(e.target.value)} placeholder="none" />
        </label>
      </div>

      ${skills.length ? html`
        <${SkillPicker}
          skills=${skills}
          chosen=${runSkills}
          planSkills=${planSkills}
          disabled=${disabled}
          onChange=${setRunSkills} />` : null}

      <${PhaseMatrix}
        planPhases=${planPhases}
        overrides=${overrides}
        runModel=${model}
        runEffort=${effort}
        skills=${skills}
        disabled=${disabled}
        onChange=${setOverrides} />

      ${changed ? html`
        <p class="muted small" style="margin:8px 0">
          These apply from the <strong>next</strong> phase. The session already running was started
          with its model and budget fixed in its own command line, and there is no honest way to
          change those underneath it.
        </p>` : null}

      <div class="row wrap" style="gap:8px">
        ${!live ? html`
          <button class="btn primary" disabled=${disabled}
                  onClick=${() => onAct('start', () => api.runStart(slug, {
                    ...settings,
                    resumeRunId: resumable ? run.id : undefined,
                  }))}>
            ${busy === 'start' ? 'Starting…' : resumable ? 'Continue' : 'Start'}
          </button>` : html`
          ${pausing ? html`
            <button class="btn primary" disabled=${disabled}
                    onClick=${() => onAct('resume', async () => {
                      const { run: after } = await api.runResume(slug);
                      toast(after?.status === 'pausing'
                        ? 'The pause could not be cancelled — reload and look at the status'
                        : 'Pause cancelled — the run carries on', after?.status === 'pausing' ? 'warn' : 'ok');
                    })}>
              ${busy === 'resume' ? 'Cancelling…' : 'Cancel pause — keep going'}
            </button>` : html`
            <button class="btn" disabled=${disabled || stopping}
                    onClick=${() => onAct('pause', async () => {
                      // Report what the SERVER did, not what the click intended.
                      // A pause that lands on nothing used to answer 200 and
                      // say nothing at all, which read as "it worked".
                      const { run: after } = await api.runPause(slug);
                      if (after?.status === 'pausing') {
                        toast(after.pause?.afterPhase != null
                          ? `Pause armed — phase ${after.pause.afterPhase} finishes first`
                          : 'Pause armed — stopping at the next phase boundary', 'ok');
                      } else {
                        toast('Nothing to pause: no phase is running on this run.', 'warn');
                      }
                    })}>
              ${busy === 'pause' ? 'Arming…' : 'Pause after this phase'}
            </button>`}
          ${changed ? html`
            <button class="btn" disabled=${disabled}
                    onClick=${() => onAct('settings', () => api.runSettings(slug, settings))}>
              ${busy === 'settings' ? 'Applying…' : 'Apply from next phase'}
            </button>` : null}
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
 * Asking the running session something
 * ------------------------------------------------------------------ */

/**
 * The `/btw` box.
 *
 * A phase used to be a process you could watch and not speak to: the only way
 * to ask it anything was to stop it, which throws the session away. Its stdin
 * is held open now, so a question is one more turn in the same conversation —
 * the context is intact, the cache is warm, and the phase carries on after
 * answering.
 *
 * The `/btw` prefix is optional and stripped if typed. It is there because it
 * is what people reach for, not because anything needs it.
 */
function AskBox({ slug, enabled, allowRun, phase, onAsked }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const question = text.replace(/^\/btw\s*/i, '').trim();
    if (!question || sending) return;
    setSending(true);
    try {
      await api.runAsk(slug, question);
      setText('');
      onAsked?.(question);
    } catch (error) {
      // The server distinguishes "nothing is listening" from "bad request", so
      // the message is worth showing verbatim rather than flattening to failed.
      toast(error.message, 'warn');
    } finally { setSending(false); }
  };

  return html`
    <div class="live-ask">
      <input
        value=${text}
        disabled=${!enabled || sending}
        placeholder=${enabled
          ? `/btw ask the session running phase ${phase}…`
          : allowRun ? 'Nothing is running to ask' : 'Asking needs --allow-run'}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
      <button class="btn small" disabled=${!enabled || sending || !text.trim()} onClick=${send}>
        ${sending ? 'Sending…' : 'Ask'}
      </button>
      <span class="hint">
        ${enabled
          ? 'Answered in the same session, then it carries on'
          : 'Available while a phase is running'}
      </span>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

function PhaseTable({ slug, run, phases, live, allowRun, onAct }) {
  if (!phases.length) {
    return html`<${Empty} title="No phases attempted yet" hint="The first one appears here as soon as it starts." />`;
  }
  return html`
    <section class="card">
      <div class="row spread">
        <h2 class="card-title">Phases in this run</h2>
        ${run.onlyPhases?.length ? html`
          <span class="muted small">
            this run was asked for phase${run.onlyPhases.length === 1 ? '' : 's'}
            ${' '}${run.onlyPhases.join(', ')} only
          </span>` : null}
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>Phase</th><th>Status</th><th>Ran as</th><th>Tries</th>
            <th class="num">Cost</th><th class="num">Turns</th><th class="num">Took</th>
            <th>Notes</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${phases.map((p) => html`
            <tr key=${p.phase} class=${run.activePhase === p.phase ? 'is-active' : ''}>
              <td><a href=${`#/plan/${encodeURIComponent(slug)}/phase/${p.phase}`}>Phase ${p.phase}</a></td>
              <td><${Chip} kind=${PHASE_TONE[p.status] ?? ''}>${p.status}</${Chip}></td>
              <td class="small">
                ${p.model ?? '—'}${p.effort ? html` · ${p.effort}` : null}
                ${p.actualModel && !p.actualModel.includes(p.model ?? ' ') ? html`
                  <div class="muted" title="the session fell back to another model in-place">
                    ran on ${p.actualModel}
                  </div>` : null}
              </td>
              <td>${p.attempts}</td>
              <td class="num">$${(p.costUsd ?? 0).toFixed(2)}</td>
              <td class="num">${p.turns ?? '—'}</td>
              <td class="num">${p.durationMs ? duration(p.durationMs) : '—'}</td>
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
                ${allowRun && !live && p.status !== 'done' ? html`
                  <button class="btn small"
                          title="Run this phase on its own, then stop — the loop does not carry on into the rest of the plan"
                          onClick=${() => onAct('only', () => api.runStart(slug, {
                            model: run.model,
                            autonomy: run.autonomy,
                            phaseBudgetUsd: run.phaseBudgetUsd,
                            runBudgetUsd: run.runBudgetUsd,
                            resumeRunId: run.status === 'finished' ? undefined : run.id,
                            onlyPhases: [p.phase],
                          }))}>Run only this</button>` : null}
              </td>
            </tr>`)}
        </tbody>
      </table>
    </section>`;
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

/**
 * An expired login is the cheapest thing here to fix and the most confusing to
 * hit, because a signed-out session does not look like a failure: it reports
 * `success`, uses one turn, costs nothing and changes nothing. The card names
 * what happened and puts the fix one click away, because "run /login in this
 * workspace" is an instruction a browser cannot carry out.
 */
function AuthCard({ auth, allowRun, onRecheck }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const command = 'claude auth login';

  const signIn = async () => {
    setBusy(true);
    try {
      const result = await api.authLogin();
      setOpened(true);
      toast(result.opened
        ? 'A terminal is open on the sign-in — finish there, then choose Check again.'
        : result.detail ?? 'Run the command below in a terminal.', result.opened ? 'ok' : 'warn');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  };

  return html`
    <section class="card auth-card">
      <div class="row spread">
        <h2 class="card-title">Claude Code is signed out</h2>
        ${auth?.checkedAt ? html`<span class="muted small">checked ${relativeTime(Date.parse(auth.checkedAt))}</span>` : null}
      </div>
      <p class="muted">
        Sessions still start, spend a turn and report success — they simply cannot do anything.
        That is why a run can look like it worked and change nothing.
        ${auth?.detail ? html` <span class="small">(${auth.detail})</span>` : null}
      </p>

      <div class="row wrap" style="gap:8px;margin-top:10px">
        <button class="btn primary" disabled=${!allowRun || busy} onClick=${signIn}>
          ${busy ? 'Opening a terminal…' : 'Open a terminal and sign in'}
        </button>
        <button class="btn" onClick=${onRecheck}>Check again</button>
      </div>

      ${opened ? html`
        <p class="muted small" style="margin-top:8px">
          Finish signing in over there, then choose <strong>Check again</strong> and start the run.
        </p>` : null}
      <p class="muted small" style="margin-top:8px">Or run it yourself:</p>
      <pre class="code">${command}</pre>
      ${!allowRun ? html`
        <p class="muted small">Opening a terminal needs <code>--allow-run</code>; the command above works regardless.</p>` : null}
    </section>`;
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

function ApprovalQueue({ approvals, allowRun, onDecide }) {
  if (!approvals.length) return null;
  return html`
    <section class="card approvals">
      <div class="row spread">
        <h2 class="card-title">
          Waiting on you
          <span class="count hot">${approvals.length}</span>
        </h2>
        <${NotifyToggle} />
      </div>
      ${approvals.map((a) => html`<${ApprovalCard} key=${a.id} approval=${a} allowRun=${allowRun} onDecide=${onDecide} />`)}
    </section>`;
}

/**
 * Offered here, where the value of it is on screen: you are looking at a queue
 * that waited for you to notice it. Asking on page load instead gets refused by
 * reflex, and that refusal sticks.
 */
function NotifyToggle() {
  const [state, setState] = useState(notifyState());
  if (state === 'unsupported' || state === 'granted') {
    return state === 'granted'
      ? html`<span class="muted small">You will be notified when this happens again.</span>`
      : null;
  }
  if (state === 'denied') {
    return html`<span class="muted small">
      Notifications are blocked for this site — your browser's settings can undo that.
    </span>`;
  }
  return html`
    <button class="btn small" onClick=${async () => setState(await askToNotify())}>
      Notify me next time
    </button>`;
}

function ApprovalCard({ approval, allowRun, onDecide }) {
  const [reason, setReason] = useState('');
  const left = Math.max(0, Date.parse(approval.expiresAt) - Date.now());

  // A permission question and a "did you check this?" question deserve
  // different words. Labelling both Allow/Deny is how a card that means "the
  // plan asked for something only you can confirm" reads as one more thing to
  // rubber-stamp — and an approval nobody reads is not an approval.
  const asking = approval.kind === 'verify';
  const yes = asking ? 'I checked it — mark verified' : 'Allow';
  const no = asking ? 'It failed' : 'Deny';
  const placeholder = asking
    ? 'What you saw (optional — recorded against the phase)'
    : 'Why (optional — the session is told)';

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

      ${asking ? html`
        <p class="muted small">
          The runner will not execute prose out of a plan file, so these were left for you.
          Marking them verified records that you checked them, against this phase, with your name on it.
        </p>` : null}

      <div class="row wrap" style="gap:8px;margin-top:8px">
        <input class="grow" placeholder=${placeholder}
               value=${reason} onInput=${(e) => setReason(e.target.value)} />
        <button class="btn primary" disabled=${!allowRun}
                onClick=${() => onDecide(approval.id, 'allow', reason)}>${yes}</button>
        <button class="btn danger" disabled=${!allowRun}
                onClick=${() => onDecide(approval.id, 'deny', reason)}>${no}</button>
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
  const [auth, setAuth] = useState(null);
  const { lines, push, clear, hydrate } = useLiveLines();

  const refresh = useCallback(async () => {
    if (state && !state.autopilot) { setRuns([]); return; }
    try {
      const [all, queue] = await Promise.all([api.runs(), api.approvals()]);
      setRuns(all);
      setApprovals(queue.filter((a) => a.status === 'pending'));
      // Replay the run worth watching: the live one, else the most recent.
      const show = all.find((r) => LIVE_STATUSES.includes(r.status)) ?? all[0];
      if (show) api.runTranscript(show.slug, show.id).then(hydrate).catch(() => {});
    } catch (error) { toast(error.message, 'error'); setRuns([]); }
  }, [state?.autopilot, hydrate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const checkAuth = useCallback(async (force) => {
    try { setAuth(await api.auth(force)); } catch { /* the card simply stays hidden */ }
  }, []);
  useEffect(() => { if (!state || state.autopilot) void checkAuth(false); }, [state?.autopilot, checkAuth]);
  useEffect(() => (state && !state.autopilot) ? undefined : subscribeRun({
    run: (data) => { announceRun(data?.state); void refresh(); },
    state: (data) => { announceRun(data?.state); void refresh(); },
    approval: (data) => { announceApproval(data); void refresh(); },
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

  const active = runs.find((r) => LIVE_STATUSES.includes(r.status));

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

      ${auth && auth.loggedIn === false ? html`
        <${AuthCard} auth=${auth} allowRun=${state?.allowRun} onRecheck=${() => checkAuth(true)} />` : null}

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
        subtitle=${active ? `${active.slug} · phase ${active.activePhase ?? '?'} · ${active.model}` : 'idle'}
        footer=${active ? html`
          <${AskBox}
            slug=${active.slug}
            enabled=${Boolean(state?.allowRun && active.activePhase != null)}
            allowRun=${state?.allowRun}
            phase=${active.activePhase}
            onAsked=${(text) => push({ kind: 'injected', text })} />` : null} />

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
