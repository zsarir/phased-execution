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

import { html, useState, useEffect, useCallback, useRef } from '../html.js';
import { api, subscribeRun } from '../api.js';
import { toast } from '../store.js';
import { Banner, Chip, Empty, Modal, Spinner, StateChip, Tile, relativeTime, useNow, elapsed }
  from '../components/ui.js';
import { LiveConsole, useLiveLines } from '../components/live-console.js';
import { SkillPicker } from '../components/skill-picker.js';
import { mergePhases, boardCounts, phaseActions, fellOverToAnotherModel, BOARD_ORDER }
  from '../components/phase-model.js';
// Raising the notification itself is the shell's job now (`app.js`), off the
// server's `notification` event — one leg, one wording, one destination.
import { notifyState, askToNotify } from '../notify.js';

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
  frozen: 'warn',
};

/**
 * Statuses that mean a loop is genuinely behind this run right now.
 *
 * `frozen` belongs here even though nothing is being scheduled: there is a live
 * child holding a warm session, so the controls that act on one — Stop, Steer,
 * Continue — all still apply, and treating it as idle would offer a Start
 * button that refuses because a run is already in progress.
 */
const LIVE_STATUSES = ['running', 'waiting', 'pausing', 'stopping', 'frozen'];

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
  const [eta, setEta] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [auth, setAuth] = useState(null);
  const [skills, setSkills] = useState([]);
  const { lines, activity, record, clear, hydrate } = useLiveLines();

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
      // Null until a phase of this plan has actually finished. Absent is the
      // right rendering of "no evidence" — a hedged guess is still a number,
      // and a number on screen gets believed.
      setEta(detail.eta ?? null);
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
    run: () => { void refresh(); },
    // Actions taken against a run no loop is driving — a pause or a stop from
    // another tab, or from a phone — arrive on this channel and nowhere else.
    state: () => { void refresh(); },
    approval: () => { void refresh(); },
    // Somebody else answered it — another tab, a phone, the timeout, or the run
    // ending underneath it. The card has to leave this screen without a reload,
    // or two people looking at one queue disagree about what is still waiting
    // and the second to press a button gets a 404 for a decision already made.
    approvalResolved: () => { void refresh(); },
    // The raw event, not a rendered line: the console is only one of the two
    // things an event becomes now, and the panels need the payload.
    phase: (data) => { record('phase', data); void refresh(); },
    verify: (data) => record('verify', data),
    stream: (data) => record('stream', data),
  }), [refresh, record, stale]);

  /**
   * The refresh is in `finally`, not in `try`, and that is the whole fix.
   *
   * A card answered on a phone leaves this tab holding one that no longer
   * exists; pressing it 404s, the error is toasted — and with the refresh
   * inside the `try` it was skipped, so the phantom stayed on screen and the
   * next press 404'd again. The failure is exactly the case where re-reading
   * the queue matters most.
   */
  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(''); await refresh(); }
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
      ${run ? html`<${RunHeader} run=${run} live=${live} eta=${eta} />` : null}

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
        onDecide=${(id, decision, reason, remember, rule) => act('decide', async () => {
          const result = await api.decide(id, decision, reason, remember, rule);
          // The rule is reported back rather than assumed: a card can be
          // answered and the remembering still refused (an unparseable rule),
          // and saying "Approved" to both would hide the half that failed.
          if (result?.error) toast(result.error, 'warn');
          else if (result?.wrote) {
            toast(`${decision === 'allow' ? 'Approved' : 'Denied'} · wrote ${result.wrote} (${result.scope})`, 'ok');
          } else {
            toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
          }
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

      ${run?.status === 'frozen' ? html`
        <${Banner} kind="warn">
          <strong>Frozen mid-phase.</strong>
          ${run.freeze?.phase != null ? html` Phase ${run.freeze.phase} is` : html` The session is`}
          stopped where it stood — the process is alive and holding its session, it is simply not
          being scheduled. Continue picks up mid-token.
          ${run.freeze?.escalateAt ? html`
            <p style="margin-top:8px" class="muted">
              Left frozen past ${new Date(run.freeze.escalateAt).toLocaleTimeString()} it converts to a
              checkpoint instead: the session is asked to stop and its id is saved, so Continue resumes
              it rather than starting the phase over. A stopped process holds memory and a prompt cache
              that expires anyway, so an overnight freeze is not the cheap option it looks like.
            </p>` : null}
        </${Banner}>` : null}

      ${run?.status === 'paused' ? html`
        <${Banner} kind="info">
          <strong>Paused between phases.</strong> Continue picks up from the board, so nothing has to
          be remembered about where it stopped.
        </${Banner}>` : null}

      ${/* Why the loop stopped, in one place, for every ending that is not a halt
            (halts have their own banner above). A run that stops after one phase
            because it was scoped to one phase is the most-reported "it doesn't
            advance", and it was invisible. */
        !live && !run?.halt && run?.finishedReason ? html`
        <${Banner} kind=${run.status === 'finished' ? 'ok' : 'info'}>
          <strong>${run.status === 'finished' ? 'Run finished.' : 'Run stopped.'}</strong>
          ${' '}${run.finishedReason}
        </${Banner}>` : null}

      ${run?.onlyPhases?.length ? html`
        <${Banner} kind="info">
          <strong>Scoped run.</strong> This run drives
          ${run.onlyPhases.length === 1
            ? html` phase ${run.onlyPhases[0]} only`
            : html` phases ${run.onlyPhases.join(', ')} only`}, then stops — it will not carry on
          into whatever those unblock. That is set by <em>Run only this</em> on a phase row.
          ${state.allowRun ? html`
            <p style="margin-top:8px">
              <button class="btn small" disabled=${Boolean(busy)}
                      onClick=${() => act('scope', async () => {
                        await api.runSettings(slug, { onlyPhases: [] });
                        toast('Scope cleared — this run continues through the whole plan', 'ok');
                      })}>
                ${busy === 'scope' ? 'Clearing…' : 'Run the whole plan from here'}
              </button>
            </p>` : null}
        </${Banner}>` : null}

      ${/* A run with the guard rails down must never look like an ordinary one.
            The selector is inside Controls, which is collapsible and scrolls
            away; this is at the top and stays. */
        run?.permissionProfile && run.permissionProfile !== 'guarded' ? html`
        <${Banner} kind="warn">
          <strong>${run.permissionProfile === 'bypass' ? 'Bypass permissions.' : 'Trusted run.'}</strong>
          ${run.permissionProfile === 'bypass'
            ? ' Nothing raises an approval card and the CLI is not asking either — this run is'
              + ' held only by the deny list.'
            : ' Nothing raises an approval card. The deny list still refuses pushes, destructive git,'
              + ' deploys and publishes, and does so even if this console dies.'}
          ${live && state.allowRun ? html`
            <p style="margin-top:8px">
              <button class="btn small" disabled=${Boolean(busy)}
                      onClick=${() => act('profile', async () => {
                        await api.runSettings(slug, { permissionProfile: 'guarded' });
                        toast('Back to Guarded — the next call that matters raises a card', 'ok');
                      })}>
                ${busy === 'profile' ? 'Switching…' : 'Go back to Guarded'}
              </button>
            </p>` : null}
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

      ${planPhases.length ? html`<${PhaseTable} slug=${slug} run=${run} planPhases=${planPhases} live=${live} allowRun=${state.allowRun} onAct=${act} />` : html`
        <${Empty}
          title="No run yet"
          hint=${`Nothing has been run for ${slug}. Starting one works the same whether the plan is fresh or half finished — the board decides where to begin.`} />`}

      <${ActivityPanels} activity=${activity} live=${live} />

      <${LiveConsole}
        lines=${lines}
        onClear=${clear}
        subtitle=${run?.activePhase ? `phase ${run.activePhase} · ${run.model}` : run?.status ?? 'idle'}
        footer=${html`
          <${AskBox}
            slug=${slug}
            enabled=${Boolean(state.allowRun && live && run?.activePhase != null)}
            allowRun=${state.allowRun}
            phase=${run?.activePhase} />`} />

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
 * The header: status, a clock that moves, and how much is left
 * ------------------------------------------------------------------ */

/**
 * What the run is doing right now, above everything that explains it.
 *
 * The line this replaces said "started 20 minutes ago" and then said it for the
 * next forty, because nothing in the client had an interval in it: every figure
 * on the page moved only when the server spoke. On a phase that thinks quietly
 * for four minutes that is indistinguishable from a page that has died, which
 * is the single most common reason someone reloads a console that was working
 * perfectly.
 */
function RunHeader({ run, live, eta }) {
  // Frozen is the one live status whose clock is genuinely not running: the
  // child is stopped, so counting on would claim work that is not happening.
  const ticking = Boolean(live) && run.status !== 'frozen';
  const now = useNow(ticking);

  const runMs = ticking
    ? now - Date.parse(run.createdAt)
    : Date.parse(run.updatedAt) - Date.parse(run.createdAt);

  const startedAt = run.child?.startedAt ? Date.parse(run.child.startedAt) : null;
  const frozenAt = run.freeze?.at ? Date.parse(run.freeze.at) : null;
  const phaseMs = startedAt == null ? null : (frozenAt ?? (ticking ? now : Date.parse(run.updatedAt))) - startedAt;

  return html`
    <header class="run-head">
      <div class="run-head-main">
        <${Chip} kind=${RUN_TONE[run.status] ?? ''}>${run.status}</${Chip}>
        ${run.activePhase != null ? html`
          <span class="run-phase">phase ${run.activePhase}</span>` : null}
        ${phaseMs != null ? html`
          <span class=${`run-clock tabular${frozenAt ? ' is-held' : ''}`}
                title=${frozenAt
                  ? 'The session is stopped where it stood, so this clock is stopped too.'
                  : 'How long the phase running now has been going'}>
            ${elapsed(phaseMs)}
          </span>` : null}
      </div>
      <div class="run-head-meta muted small">
        <span>run <code>${run.id}</code></span>
        <span title=${`started ${new Date(run.createdAt).toLocaleString()}`}>
          ${ticking ? 'running for' : 'ran for'} ${elapsed(Math.max(0, runMs))}
        </span>
        ${/* Suppressed entirely until a phase of this plan has finished, and a
              range rather than a countdown even then. The thing being predicted
              is a model's throughput on work nobody has looked at yet. */
          eta ? html`
          <span class="run-eta"
                title=${`Estimated from ${eta.samples} finished phase(s) of this plan and `
                  + `${Math.round(eta.remainingWeight / 1000)}K of remaining weight. `
                  + 'Weight-normalised, recency-weighted, and deliberately coarse.'}>
            ${eta.label} <em>(estimate)</em>
          </span>` : null}
      </div>
    </header>`;
}

/* ------------------------------------------------------------------ *
 * What the session is doing: tasks, tools, subagents
 * ------------------------------------------------------------------ */

/** Tool calls worth showing at once; the rest are in the console. */
const TOOLS_SHOWN = 24;

const TODO_TONE = { completed: 'done', in_progress: 'busy' };

/**
 * The three things a `claude -p` process does that a scrolling log cannot show.
 *
 * A transcript answers "what has it said". These answer "what is it doing" —
 * which is a question about *state*, and state read off a log is the reader
 * doing the folding in their head: scrolling back for the last `TodoWrite`,
 * remembering which `Bash` never came back, unpicking two subagents' sentences
 * from one interleaved paragraph. All three are derived from the same events
 * the console renders, so they replay after a reload for the same reason it
 * does.
 */
function ActivityPanels({ activity, live }) {
  const { todos, tools, agents } = activity;
  if (!todos.length && !tools.length && !agents.length) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const recent = tools.slice(-TOOLS_SHOWN).reverse();
  const running = tools.filter((t) => t.ok === null).length;

  return html`
    <section class="card run-activity">
      <h2 class="card-title">What it is doing</h2>
      <div class="activity-grid">

        ${todos.length ? html`
          <div class="activity-panel">
            <div class="row spread">
              <h3>Task list</h3>
              <span class="muted small tabular">${doneCount}/${todos.length}</span>
            </div>
            <ol class="todo-list">
              ${todos.map((todo, i) => html`
                <li key=${i} class=${`todo ${TODO_TONE[todo.status] ?? ''}`}>
                  <span class="todo-dot"></span>
                  <span class="todo-text">
                    ${todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                  </span>
                </li>`)}
            </ol>
            <p class="muted small">
              The session's own list, as it last wrote it — not the plan's phases.
            </p>
          </div>` : null}

        ${tools.length ? html`
          <div class="activity-panel">
            <div class="row spread">
              <h3>Tool activity</h3>
              <span class="muted small tabular">
                ${tools.length}${tools.length === TOOLS_SHOWN ? '+' : ''}${running ? ` · ${running} running` : ''}
              </span>
            </div>
            <ul class="tool-list">
              ${recent.map((tool, i) => html`
                <li key=${tool.id ?? `${tool.name}-${i}`}
                    class=${`tool-row${tool.ok === null ? ' is-running' : ''}${tool.ok === false ? ' is-bad' : ''}`}>
                  <span class="tool-name">
                    ${tool.name}${tool.agent ? html` <span class="tool-agent">${tool.agent}</span>` : null}
                  </span>
                  ${tool.summary ? html`<code class="tool-summary">${tool.summary}</code>` : null}
                  <span class="tool-ms tabular"
                        title=${tool.ok === false ? tool.detail || 'the call failed' : ''}>
                    ${/* No result yet means it is still going, and on an
                          unattended run that is the interesting state — a
                          `Bash` six minutes in reads identically to one that
                          finished, without this. */
                      tool.ok === null ? (live ? '…' : '—')
                        : tool.ms == null ? (tool.ok ? 'ok' : 'failed')
                          : `${tool.ok ? '' : '✗ '}${toolTime(tool.ms)}`}
                  </span>
                </li>`)}
            </ul>
          </div>` : null}

        ${agents.length ? html`
          <div class="activity-panel activity-agents">
            <div class="row spread">
              <h3>Subagents</h3>
              <span class="muted small tabular">
                ${agents.filter((a) => !a.done).length} running · ${agents.length} total
              </span>
            </div>
            ${agents.map((agent) => html`
              <div key=${agent.id} class=${`agent-lane${agent.done ? ' is-done' : ''}`}>
                <div class="row spread">
                  <strong>${agent.agent || 'agent'}</strong>
                  <span class="muted small">${agent.done ? 'finished' : 'working'}</span>
                </div>
                ${agent.title ? html`<div class="muted small agent-title">${agent.title}</div>` : null}
                ${agent.text ? html`<p class="agent-text">${agent.text.slice(-600)}</p>` : null}
              </div>`)}
            <p class="muted small">
              One lane per delegated agent, matched to the <code>Agent</code> call that started it.
              Unnamed when that call did not say which agent — the field is optional. Their words
              used to arrive as one voice and read as neither.
            </p>
          </div>` : null}
      </div>
    </section>`;
}

/** Tool durations run from milliseconds to minutes; one format cannot serve both. */
function toolTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
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

/**
 * What each level is for, read while choosing it rather than after.
 *
 * These were a note beside the select, which made `.field` — a horizontal flex
 * row of label + control — lay out three columns and overlap. Putting them in
 * the options is both a smaller layout and a better moment to read them.
 */
const EFFORT_NOTE = {
  '': "default · this machine's",
  low: 'low · mechanical work',
  medium: 'medium · balanced',
  high: 'high · implementation',
  xhigh: 'xhigh · hard reasoning',
  max: 'max · hardest, slowest',
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
  const [profile, setProfile] = useState(run?.permissionProfile ?? 'guarded');
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
    setProfile(run?.permissionProfile ?? 'guarded');
  }, [run?.id, run?.model, run?.effort, run?.autonomy, run?.phaseBudgetUsd, run?.runBudgetUsd,
    run?.permissionProfile]);

  const resumable = run && !live && run.status !== 'finished';
  const disabled = !allowRun || Boolean(busy);
  const pausing = run?.status === 'pausing';
  const stopping = run?.status === 'stopping';
  const frozen = run?.status === 'frozen';
  /** A freeze that ran past its threshold left a session to resume, not a fresh start. */
  const checkpointed = Object.values(run?.phases ?? {}).some((p) => p.resumeSessionId);

  const settings = {
    model,
    effort,
    autonomy,
    phaseBudgetUsd: Number(phaseBudget) || null,
    runBudgetUsd: Number(runBudget) || null,
    phaseOptions: overrides,
    skills: runSkills,
    permissionProfile: profile,
  };
  const changed = live && (
    model !== run?.model
    || effort !== (run?.effort ?? '')
    || autonomy !== run?.autonomy
    || profile !== (run?.permissionProfile ?? 'guarded')
    || (Number(phaseBudget) || null) !== (run?.phaseBudgetUsd ?? null)
    || (Number(runBudget) || null) !== (run?.runBudgetUsd ?? null)
    || JSON.stringify(overrides) !== JSON.stringify(run?.phaseOptions ?? {})
    || JSON.stringify(runSkills) !== JSON.stringify(run?.skills ?? [])
  );

  return html`
    <section class="card">
      <div class="row spread">
        <h2 class="card-title">
          ${frozen ? 'Frozen' : live ? 'Running' : resumable ? 'Continue this run' : 'Start a run'}
        </h2>
        <span class="muted small">
          ${frozen
            ? 'The session is alive and stopped. Nothing has been lost.'
            : resumable
              ? checkpointed
                ? 'Picks up the checkpointed session with --resume, rather than starting the phase over.'
                : 'Picks up from the board, not from a saved position.'
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
          <select value=${effort} disabled=${disabled}
                  title=${EFFORT_NOTE[effort]}
                  onChange=${(e) => setEffort(e.target.value)}>
            ${EFFORTS.map((e) => html`
              <option key=${e} value=${e}>${EFFORT_NOTE[e]}</option>`)}
          </select>
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
        <label class="field">
          <span>Permissions</span>
          <select value=${profile} disabled=${disabled}
                  onChange=${(e) => setProfile(e.target.value)}>
            <option value="guarded">Guarded — ask me about the irreversible</option>
            <option value="trusted">Trusted — only the deny list stops it</option>
            <option value="bypass">Bypass — the CLI stops asking too</option>
          </select>
        </label>
      </div>

      <p class=${`muted small profile-note ${profile !== 'guarded' ? 'hot' : ''}`}>
        ${profile === 'guarded' ? html`
          Commits, installs, merges and fetches raise a card. The deny list — pushes, destructive
          git, deploys, publishes — is refused outright and no card can approve it.`
    : profile === 'trusted' ? html`
          <strong>Nothing raises a card.</strong> The deny list still holds, and still holds with
          this console dead — it is enforced by the CLI, not by the hook. Everything else runs
          unattended, including every commit.`
    : html`
          <strong>Nothing raises a card, and the CLI stops asking too</strong>
          (<code>--permission-mode bypassPermissions</code>). The deny list is the only thing left
          between this run and your repository — it does still hold, because bypass auto-approves
          everything <em>except</em> explicit deny rules. Journaled for as long as it is in force.
          <br />Requires the bypass disclaimer to have been accepted once, interactively, in a
          normal <code>claude</code> session on this machine. Without it the CLI silently downgrades
          to <code>default</code>, which refuses every edit in headless mode — the run would do
          <em>less</em> than Guarded. The console reports that if it happens; if you have not
          accepted it, use Trusted.`}
      </p>

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
          ${/* Two pauses, deliberately named apart. The one above waits for the
                phase to finish and be verified; this one stops the session where
                it stands. Labelling both "Pause" is how an operator ends up
                pressing the wrong one while watching a phase do the wrong thing. */
            frozen ? html`
            <button class="btn primary" disabled=${disabled}
                    onClick=${() => onAct('thaw', async () => {
                      const { run: after } = await api.runThaw(slug);
                      toast(after?.status === 'frozen'
                        ? 'The session could not be continued — reload and look at the status'
                        : 'Continued — the session picks up mid-token',
                      after?.status === 'frozen' ? 'warn' : 'ok');
                    })}>
              ${busy === 'thaw' ? 'Continuing…' : 'Continue the frozen session'}
            </button>` : html`
            <button class="btn" disabled=${disabled || stopping || run?.activePhase == null}
                    title="Stops the session where it stands, losing nothing. The opposite of waiting for the phase to finish."
                    onClick=${() => onAct('freeze', async () => {
                      const { run: after } = await api.runFreeze(slug);
                      toast(after?.status === 'frozen'
                        ? `Frozen — phase ${after.freeze?.phase ?? ''} is stopped where it stood`.trim()
                        : 'Nothing to freeze: no session is running on this run.',
                      after?.status === 'frozen' ? 'ok' : 'warn');
                    })}>
              ${busy === 'freeze' ? 'Freezing…' : 'Freeze now'}
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
 * The `/btw` box, and beside it the thing it kept being misused for.
 *
 * A phase used to be a process you could watch and not speak to: the only way
 * to ask it anything was to stop it, which throws the session away. Its stdin
 * is held open now, so a message is one more turn in the same conversation —
 * the context is intact, the cache is warm, and the phase carries on after.
 *
 * Two modes, because they are genuinely different acts. **Ask** is framed to be
 * inert: it says out loud that it is not a change to the phase, which is what
 * stops "why did you skip the cache?" being read as an instruction to go back
 * and do it. That framing makes it useless for the case people reached for it
 * anyway — watching a phase head somewhere wrong and wanting to say so — so
 * **Steer** is the honest version of that, framed as an instruction and
 * journaled under its own name.
 *
 * The `/btw` prefix is optional and stripped if typed. It is there because it
 * is what people reach for, not because anything needs it.
 */
function AskBox({ slug, enabled, allowRun, phase }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('ask');
  const [sending, setSending] = useState(false);
  // A ref, not the `sending` state, and this is the whole point: an `onClick`
  // and an `onKeyDown` firing in the same tick both read the state captured at
  // the last render — which is `false` for both — so the guard passed twice and
  // the question went to the model twice. A ref is written and read in the same
  // tick, so the second caller sees the first.
  const inFlight = useRef(false);

  const send = async () => {
    const body = text.replace(/^\/(btw|steer)\s*/i, '').trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    // Belt to the ref's braces: the key survives a retry the browser makes on
    // its own, which no amount of client-side guarding can see.
    const key = `${mode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const sent = mode === 'steer'
        ? await api.runSteer(slug, body, key)
        : await api.runAsk(slug, body, key);
      setText('');
      // Nothing is pushed into the console here. The server emits the line the
      // instant it writes to stdin, and the CLI's echo folds into that same
      // line as a delivery tick — an optimistic third copy is what made one
      // `/btw` appear three times.
      if (sent?.repeated) toast('Already sent — this one was a duplicate', 'ok');
    } catch (error) {
      // The server distinguishes "nothing is listening" from "bad request", so
      // the message is worth showing verbatim rather than flattening to failed.
      toast(error.message, 'warn');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const steering = mode === 'steer';
  return html`
    <div class=${`live-ask${steering ? ' is-steer' : ''}`}>
      <select value=${mode} disabled=${!enabled || sending}
              title=${steering
                ? 'An instruction the phase should act on'
                : 'A question that must not change what the phase is doing'}
              onChange=${(e) => setMode(e.target.value)}>
        <option value="ask">Ask</option>
        <option value="steer">Steer</option>
      </select>
      <input
        value=${text}
        disabled=${!enabled || sending}
        placeholder=${enabled
          ? steering
            ? `tell the session running phase ${phase} to do something differently…`
            : `/btw ask the session running phase ${phase}…`
          : allowRun ? 'Nothing is running to ask' : 'Asking needs --allow-run'}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
      <button class="btn small" disabled=${!enabled || sending || !text.trim()} onClick=${send}>
        ${sending ? 'Sending…' : steering ? 'Steer' : 'Ask'}
      </button>
      <span class="hint">
        ${!enabled
          ? 'Available while a phase is running'
          : steering
            ? 'Folded into the work — the plan\'s verification still decides if the phase passes'
            : 'Answered in the same session, then it carries on'}
      </span>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

function PhaseTable({ slug, run, planPhases, live, allowRun, onAct }) {
  if (!planPhases.length) {
    return html`
      <${Empty}
        title="This plan has no phase graph"
        hint="The autopilot drives phases from the plan's own graph table, so there is nothing here to run." />`;
  }

  const rows = mergePhases(planPhases, run);
  const counts = boardCounts(rows);
  const asked = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const spent = rows.reduce((sum, r) => sum + (r.record?.costUsd ?? 0), 0);

  return html`
    <section class="card phase-board">
      <div class="row spread wrap" style="gap:var(--s3)">
        <h2 class="card-title">Phases</h2>
        <div class="row wrap board-counts">
          ${BOARD_ORDER.filter((state) => counts[state]).map((state) => html`
            <span key=${state} class="board-count">
              <${StateChip} state=${state} board=${true} small=${true} />
              <b>${counts[state]}</b>
            </span>`)}
        </div>
      </div>

      <p class="muted small board-note">
        Status is the plan's own board, so a phase finished by any other session reads as finished
        here.${asked ? ` This run was asked for phase${asked.size === 1 ? '' : 's'} ${[...asked].join(', ')} only.` : ''}
      </p>

      <div class="table-scroll">
        <table class="table phase-table">
          <thead>
            <tr>
              <th scope="col" class="col-num">#</th>
              <th scope="col">Phase</th>
              <th scope="col" class="col-state">Status</th>
              <th scope="col" class="col-run">This run</th>
              <th scope="col" class="num col-cost">Cost</th>
              <th scope="col" class="num col-turns">Turns</th>
              <th scope="col" class="num col-took">Took</th>
              <th scope="col" class="col-actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((p) => PhaseRow({ phase: p, slug, run, live, allowRun, onAct }))}
          </tbody>
        </table>
      </div>

      ${spent > 0 ? html`
        <p class="muted small" style="margin:var(--s3) 0 0">
          This run has spent <b class="tabular">$${spent.toFixed(2)}</b> across
          ${rows.filter((r) => r.record).length} phase(s) it touched.
        </p>` : null}
    </section>`;
}

function PhaseRow({ phase: p, slug, run, live, allowRun, onAct }) {
  const r = p.record;
  const isActive = run?.activePhase === p.phase;

  // Gated on the BOARD, never on the run record. Offering to run a phase the
  // board calls done is the defect this table was rebuilt for.
  const can = phaseActions(p, { live, allowRun });
  const fellOver = fellOverToAnotherModel(r);

  return html`
    <tr key=${p.phase}
        class=${`${isActive ? 'is-active' : ''} ${p.state === 'done' ? 'is-done' : ''}`}>
      <td class="phase-num tabular">${String(p.phase).padStart(2, '0')}</td>

      <td>
        <a class="phase-link" href=${`#/plan/${encodeURIComponent(slug)}/phase/${p.phase}`}>${p.title}</a>
        <div class="row wrap phase-flags">
          ${p.gated ? html`<${Chip} kind="gate">gated</${Chip}>` : null}
          ${isActive ? html`<${Chip} kind="busy">running now</${Chip}>` : null}
          ${p.elsewhere ? html`
            <span class="muted"
                  title="The run record beside this is what this run did; the board is what is true now.">
              finished outside this run
            </span>` : null}
        </div>
      </td>

      <td><${StateChip} state=${p.state} board=${true} /></td>

      <td class="small">
        ${r ? html`
          <${Chip} kind=${PHASE_TONE[r.status] ?? ''}>${r.status}</${Chip}>
          <div class="muted phase-ran">
            ${r.model ?? '—'}${r.effort ? ` · ${r.effort}` : ''}${r.attempts > 1 ? ` · ${r.attempts} tries` : ''}
          </div>
          ${fellOver ? html`
            <div class="muted" title="the session fell over to another model without restarting">
              ran on ${r.actualModel}
            </div>` : null}`
        : html`<span class="muted">not attempted</span>`}
      </td>

      <td class="num tabular">${r?.costUsd ? `$${r.costUsd.toFixed(2)}` : '—'}</td>
      <td class="num tabular">${r?.turns ?? '—'}</td>
      <td class="num tabular">${r?.durationMs ? duration(r.durationMs) : '—'}</td>

      <td>
        <div class="row wrap phase-actions">
          ${can.retry ? html`
            <button class="btn small" onClick=${() => onAct('retry', () => api.runRetry(slug, p.phase))}>
              Retry
            </button>` : null}
          ${can.skip ? html`
            <button class="btn small" onClick=${() => onAct('skip', () => api.runSkip(slug, p.phase))}>
              Skip
            </button>` : null}
          ${can.runAlone ? html`
            <button class="btn small"
                    title="Run this phase on its own, then stop — the loop does not carry on into the rest of the plan"
                    onClick=${() => onAct('only', () => api.runStart(slug, {
                      model: run?.model,
                      effort: run?.effort,
                      autonomy: run?.autonomy,
                      phaseBudgetUsd: run?.phaseBudgetUsd,
                      runBudgetUsd: run?.runBudgetUsd,
                      resumeRunId: run && run.status !== 'finished' ? run.id : undefined,
                      onlyPhases: [p.phase],
                    }))}>Run only this</button>` : null}
        </div>
      </td>
    </tr>
    ${r?.note || r?.verification ? html`
      <tr key=${`${p.phase}-note`} class="phase-note">
        <td></td>
        <td colspan="7">
          ${r.note ? html`<div class="muted small">${r.note}</div>` : null}
          ${r.verification ? html`
            <div class=${`small ${r.verification.ok ? 'ok' : 'bad'}`}>${r.verification.reason}</div>` : null}
          ${r.verification?.notRun?.length ? html`
            <details>
              <summary class="small">${r.verification.notRun.length} step(s) a person must check</summary>
              <ul class="small">${r.verification.notRun.map((n, i) => html`
                <li key=${i}><code>${n.text}</code> — ${n.reason}</li>`)}</ul>
            </details>` : null}
        </td>
      </tr>` : null}`;
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
  // The rule is editable before it is written. "Always allow this" that writes
  // something you never saw is how a policy file fills up with rules nobody can
  // account for — and the derived one is a suggestion, not always the rule you
  // meant.
  const [rule, setRule] = useState(approval.suggestedRule ?? '');
  const [showRule, setShowRule] = useState(false);
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

      ${!asking && approval.suggestedRule ? html`
        <div class="rule-actions">
          <button class="linkish small" onClick=${() => setShowRule(!showRule)}
                  aria-expanded=${showRule}>
            ${showRule ? '▾' : '▸'} Stop asking about this
          </button>
          ${showRule ? html`
            <div class="rule-builder">
              <label class="small muted" for=${`rule-${approval.id}`}>
                The rule that gets written — check it before it goes in:
              </label>
              <input id=${`rule-${approval.id}`} class="mono" value=${rule}
                     onInput=${(e) => setRule(e.target.value)} spellcheck="false" />
              <div class="row wrap" style="gap:8px">
                <button class="btn small" disabled=${!allowRun || !rule.trim()}
                        onClick=${() => onDecide(approval.id, 'allow', reason, 'plan', rule.trim())}>
                  Always for ${approval.slug}
                </button>
                <button class="btn small" disabled=${!allowRun || !rule.trim()}
                        onClick=${() => onDecide(approval.id, 'allow', reason, 'global', rule.trim())}>
                  Always everywhere
                </button>
              </div>
              <p class="muted small">
                Allows and answers this call in one step. Written with your name on it and recorded
                in the run's journal; removable from Settings → Permissions.
              </p>
            </div>` : null}
        </div>` : null}

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
  const { lines, activity, record, clear, hydrate } = useLiveLines();

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
    run: () => { void refresh(); },
    state: () => { void refresh(); },
    approval: () => { void refresh(); },
    // Somebody else answered it — another tab, a phone, the timeout, or the run
    // ending underneath it. The card has to leave this screen without a reload,
    // or two people looking at one queue disagree about what is still waiting
    // and the second to press a button gets a 404 for a decision already made.
    approvalResolved: () => { void refresh(); },
    phase: (data) => { record('phase', data); void refresh(); },
    verify: (data) => record('verify', data),
    stream: (data) => record('stream', data),
  }), [refresh, record, state?.autopilot]);

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
        onDecide=${async (id, decision, reason, remember, rule) => {
          try {
            const result = await api.decide(id, decision, reason, remember, rule);
            if (result?.error) toast(result.error, 'warn');
            else if (result?.wrote) toast(`Answered · wrote ${result.wrote} (${result.scope})`, 'ok');
            else toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
          } catch (error) { toast(error.message, 'error'); }
          // In `finally` territory for the same reason as `act` above: a card
          // answered somewhere else 404s here, and that is precisely when the
          // queue needs re-reading rather than leaving the phantom on screen.
          finally { await refresh(); }
        }} />

      <${ActivityPanels} activity=${activity} live=${Boolean(active)} />

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
            phase=${active.activePhase} />` : null} />

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
