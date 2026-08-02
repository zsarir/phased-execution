/**
 * The operating guide.
 *
 * The console's own design tokens describe a plan as a network — phases are
 * stations, dependencies are track, amber means "actionable now and nothing
 * else". This page is the manual for that network, and it is drawn the same
 * way: one line down the page, a station per step, and each station's colour
 * says who acts there. Green is the machine. Amber is you.
 *
 * That is not decoration. The single hardest thing to hold in your head about
 * an unattended runner is which parts it will do alone and which parts wait for
 * a person, so that distinction is the page's organising structure rather than
 * a paragraph somewhere in the middle of it.
 *
 * Everything here is checked against the code it describes. When a flag or a
 * script name changes, this page changes with it.
 */

import { html, useEffect, useRef } from '../html.js';

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

/** who: 'machine' (green) · 'you' (amber) · 'gate' (purple). */
const STATIONS = [
  {
    id: 'plan',
    who: 'you',
    name: 'Write the plan',
    lede: 'A plan is a dependency graph, not a checklist. Everything downstream reads it, so this is the one step worth slowing down for.',
    body: html`
      <p>
        Ask Claude for <code>/phased-execution</code> in the repo you want to work in, or scaffold
        the file yourself:
      </p>
      <pre class="cmd">scripts/new-plan.sh my-feature</pre>
      <p>
        That writes <code>docs/plans/my-feature.md</code>. Two parts of it are read by machine and
        have to be exact:
      </p>
      <dl class="defs">
        <dt>The phase graph table</dt>
        <dd>
          The <strong>Depends on</strong> column is parsed to work out what is ready. List every
          prerequisite for every phase. A cell takes <code>4</code>, <code>4, 5</code>, a range
          <code>1–7</code>, or <code>—</code> for none.
        </dd>
        <dt>Each phase's <code>**Verification:**</code> line</dt>
        <dd>
          The runnable command that proves the phase worked. Write real commands in backticks —
          this is what the autopilot executes to decide whether a phase actually landed.
          ${' '}<a href="#verified">What "verified" means</a> is worth reading before you rely on it.
        </dd>
      </dl>`,
  },
  {
    id: 'check',
    who: 'you',
    name: 'Check it parses',
    lede: 'The graph is only as good as the parser thinks it is. Confirm the machine reads what you wrote.',
    body: html`
      <pre class="cmd">scripts/validate.sh my-feature
scripts/phase-graph.sh my-feature</pre>
      <p>
        The first lints the plan. The second prints the board: which phases are done, ready,
        waiting, or blocked. If the phase count differs from the <code>phases:</code> field in the
        front matter, the graph did not parse the way you meant it to.
      </p>
      <p class="aside">
        Open the plan's <strong>Route</strong> tab to see the same graph drawn. A phase that sits
        alone when you expected it to depend on something is a mistyped ${' '}
        <strong>Depends on</strong> cell.
      </p>`,
  },
  {
    id: 'open',
    who: 'you',
    name: 'Open the console with runs enabled',
    lede: 'Two separate permissions, because they have very different blast radii.',
    body: html`
      <pre class="cmd">./start --root ~/code/my-repo --allow-writes --allow-run</pre>
      <dl class="defs">
        <dt><code>--allow-writes</code></dt>
        <dd>Lets the console scaffold plans and handoffs, record QA, and take locks.</dd>
        <dt><code>--allow-run</code></dt>
        <dd>
          Lets the console <strong>spawn Claude sessions that edit your repository</strong> for
          hours without you watching. Off by default. Nothing on the Autopilot tab can start,
          stop or approve anything without it.
        </dd>
      </dl>
      <p class="aside">
        The startup banner tells you which are on. If you upgrade the skill while a console is
        running, restart it — the browser reloads the page from disk but the server is whatever
        Node loaded at startup.
      </p>`,
  },
  {
    id: 'start',
    who: 'you',
    name: 'Start the run',
    lede: 'Fresh plan or half-finished plan — the same button. There is no cursor to set.',
    body: html`
      <p>
        Open the plan, go to <strong>Autopilot</strong>, pick a model, an effort and a budget, and
        start. Readiness is derived from the set of finished phases, so a plan with 1, 4 and 5 done
        and 2 and 3 outstanding needs no special handling: it simply begins at 2.
      </p>
      <dl class="defs">
        <dt>Model and effort</dt>
        <dd>
          Set for the run, and overridable per phase under <strong>Per phase</strong>. What a phase
          runs as is resolved from your choice for this run, then the plan's own
          <code>**Model:**</code> and <code>**Effort:**</code> bullets, then the run's defaults —
          field by field, so choosing a model does not throw away an effort the plan asked for.
        </dd>
        <dt>Skills</dt>
        <dd>
          Every skill a session could invoke — yours, this repository's, and every installed
          plugin's — with what each one is for. Ticked skills are named in the boot prompt of every
          phase, on top of whatever the plan's own <code>Skills (every session)</code> line asks
          for, which stays fixed because it belongs to the plan and not to one run.
        </dd>
        <dt>Stop and ask me <span class="hint">(default)</span></dt>
        <dd>
          Halts on anything ambiguous — a failed phase, a verification the runner could not fully
          check, a gate. Start here. Watch one run. Then decide.
        </dd>
        <dt>Keep going where it safely can</dt>
        <dd>
          Moves to the next ready phase after a failure instead of stopping. It still halts on
          two consecutive failures, an exhausted budget, or anything needing a person.
        </dd>
        <dt>Budgets</dt>
        <dd>
          Per phase and per run, in dollars. A phase that hits its cap resumes the same session
          with a larger one rather than starting over, so the work already done is kept.
        </dd>
      </dl>`,
  },
  {
    id: 'loop',
    who: 'machine',
    name: 'Each phase runs alone',
    lede: 'One phase, one process. Clearing the context between phases needs no mechanism: the process exits and the context goes with it.',
    body: html`
      <ol class="steps">
        <li><strong>Gate</strong> — if the phase declares one and it is not clear, the phase parks and the runner tries another ready phase.</li>
        <li><strong>Lock</strong> — the runner checks who holds the phase. It does not take the lock; the session doing the work does.</li>
        <li><strong>Prompt</strong> — the boot prompt comes from the engine, unaltered.</li>
        <li><strong>Session</strong> — one <code>claude -p</code> process, streamed to the Autopilot tab as it works.</li>
        <li><strong>Verify</strong> — the runner runs the plan's own verification commands itself.</li>
        <li><strong>Lint</strong> — <code>validate.sh</code> must still pass.</li>
        <li><strong>Confirm</strong> — the board is re-read from disk and must say <em>done</em>.</li>
      </ol>
      <p class="callout">
        The last three are the point. A session that exits cleanly claiming success while writing
        nothing halts the run, because nothing here takes the session's word for it.
      </p>
      <dl class="defs">
        <dt>Watching it</dt>
        <dd>
          The session console shows text as it is written, the tool calls it makes, and the work of
          any subagent it dispatches — without that last one, a phase that delegates is a silent gap
          of several minutes. <strong>Detail</strong> adds the model's own reasoning and every hook
          call, which are worth having when something is wrong and noise when it is not.
        </dd>
        <dt>Asking it something</dt>
        <dd>
          The box under the console puts a question to the session that is running <em>now</em>. It
          becomes one more turn in the same conversation — the context is intact and the phase
          carries on afterwards — rather than a reason to stop it. The same question works from any
          terminal with <code>btw "…"</code>. It is framed as out-of-band before it is sent, so an
          answer does not turn into a change of direction.
        </dd>
        <dt>Pausing it</dt>
        <dd>
          <strong>Pause after this phase</strong> arms a pause and names the phase that has to
          finish first; nothing is cut off, and it can be cancelled until it arrives.
          <strong>Stop now</strong> is the one that interrupts, and it records the phase as
          interrupted rather than failed, because a phase cut off partway may have half-finished
          something.
        </dd>
      </dl>`,
  },
  {
    id: 'approve',
    who: 'you',
    name: 'Answer what actually needs you',
    lede: 'Most tool calls are answered without troubling you. A few are not.',
    body: html`
      <p>
        When a session reaches something on the ask list — a commit, a migration, an install — the
        session pauses and a card appears on the Autopilot tab and in <strong>Runs</strong>. The
        card carries the working tree, the diff, the verification so far and the exact command, so
        you are answering a question rather than a prompt.
      </p>
      <p>
        Nobody answers within about ten minutes and the call is denied, with the reason passed back
        to the session so it can adapt or stop rather than hang.
      </p>
      <p class="aside">
        Read-only work never becomes a card. A queue that fills with <code>grep</code> and
        <code>find</code> is a queue nobody reads, and one nobody reads only teaches you to tap
        yes.
      </p>`,
  },
  {
    id: 'finish',
    who: 'machine',
    name: 'The plan closes itself out',
    lede: 'Every phase done, handoffs written, board green.',
    body: html`
      <p>
        The run reports <strong>finished</strong> when no phase is left outstanding. Each phase has
        written its handoff under <code>docs/handoffs/&lt;slug&gt;/</code>, which is what a future
        session — or a future you — reads to pick the work up cold.
      </p>
      <p>Run the plan's own end-to-end verification, then mark the plan complete.</p>`,
  },
];

const STATES = [
  {
    state: 'halted', tone: 'blocked',
    means: 'Something the runner will not decide on its own.',
    causes: 'Verification failed · the plan stopped linting · the board did not flip to done · two phases failed in a row · the budget ran out · a person is needed.',
    action: 'Read the halt reason on the Autopilot tab, fix the cause, then Retry that phase and start again.',
  },
  {
    state: 'parked', tone: 'gated',
    means: 'Every remaining phase is waiting on something outside the run.',
    causes: 'A gate that has not cleared · a lock held by another session · a phase that needs a decision.',
    action: 'Clear the gate or release the lock, then start the run again. Nothing was lost.',
  },
  {
    state: 'waiting', tone: 'waiting',
    means: 'A usage window is exhausted. Nothing is wrong.',
    causes: 'A plan-level limit that only time fixes. A limit on one model instead switches model and carries on.',
    action: 'Leave it. The run resumes itself at the stated time. Further out than twelve hours and it parks for you instead.',
  },
  {
    state: 'interrupted', tone: 'progress',
    means: 'A phase was cut off partway.',
    causes: 'You stopped the run, or the console died while a session was working.',
    action: 'The phase is never re-run silently — it may have half-landed. Look at what changed, then Retry or Skip it deliberately.',
  },
];

const FLAGS = [
  ['--root <dir>', 'Open this repository immediately, skipping the picker.'],
  ['--allow-writes', 'Enable scaffolding, QA records and locks.'],
  ['--allow-run', 'Enable the autopilot. Separate on purpose.'],
  ['--port <n>', 'Listen somewhere other than 4123.'],
  ['--remote <host>', 'Also answer to this hostname, behind a proxy that authenticates callers. Turns on strict Host checking.'],
  ['--remote-user <l>', 'A login allowed to arrive that way. Required by --remote.'],
  ['--scripts <dir>', 'Use a different phased-execution checkout.'],
  ['--log-file <p>', 'Structured log. Defaults under ~/.local/state/phase-console/.'],
];

const GATES = [
  ['phase 8', 'Clears when phase 8 of this plan is done.'],
  ['phases 6,7,9', 'Clears when all of them are done.'],
  ['plan other-slug:6,8', 'Clears on phases in a different plan.'],
  ['date 2026-12-01', 'Clears on or after that date. Range-checked, so a nonsense date fails closed.'],
  ['cmd <command>', 'Clears when the command exits 0. Off unless PHASE_EXEC_GATES=1 — running a command written in a document is worth an explicit opt-in.'],
  ['manual <who>', 'Never clears by itself. A person decides.'],
];

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

export function GuideView({ state }) {
  const root = useRef(null);

  // Stations light up as you reach them, the way the route map draws itself.
  // Anyone who has asked not to see motion gets the finished state immediately.
  useEffect(() => {
    const nodes = root.current?.querySelectorAll('.station-block');
    if (!nodes?.length) return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      for (const node of nodes) node.classList.add('is-live');
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-live');
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: '-12% 0px -55% 0px' });
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return html`
    <div class="page guide" ref=${root}>
      <${Masthead} state=${state} />
      <${Key} />

      <section class="line" aria-label="Running a plan, step by step">
        ${STATIONS.map((station, index) => html`
          <${Station} key=${station.id} station=${station} index=${index} last=${index === STATIONS.length - 1} />`)}
      </section>

      <${Safety} />
      <${Suspended} />
      <${Reference} />
    </div>`;
}

function Masthead({ state }) {
  return html`
    <header class="masthead">
      <p class="eyebrow">Phase Console — operating guide</p>
      <h1>
        A plan is a network.<br />
        <span class="quiet">Phases are stations. This is how you run the line.</span>
      </h1>
      <p class="standfirst">
        The console reads a phased plan from <code>docs/plans/</code> and can execute it: one fresh
        Claude session per phase, checked independently, pausing when it needs you. This page
        covers writing a plan, running one, and knowing exactly what the machine will and will not
        do on its own.
      </p>
      <p class="status-strip">
        <span class=${`pip ${state?.autopilot ? 'on' : 'off'}`}></span>
        ${state?.autopilot
          ? state.allowRun
            ? 'Runs are enabled on this console.'
            : 'This console can show runs but not start them — it was started without --allow-run.'
          : 'This console predates the autopilot. Restart it to pick up the run endpoints.'}
      </p>
    </header>`;
}

function Key() {
  return html`
    <aside class="key" aria-label="How to read this page">
      <span class="key-title">Key</span>
      <span class="key-item"><i class="dot who-machine"></i> The machine does this</span>
      <span class="key-item"><i class="dot who-you"></i> You do this</span>
      <span class="key-item"><i class="dot who-gate"></i> Waits for a person</span>
    </aside>`;
}

function Station({ station, index, last }) {
  return html`
    <article class=${`station-block who-${station.who} ${last ? 'is-last' : ''}`} id=${station.id}>
      <div class="track" aria-hidden="true"><i class="dot"></i></div>
      <div class="station-body">
        <h2>
          <span class="stop">Stop ${index + 1}</span>
          ${station.name}
        </h2>
        <p class="lede">${station.lede}</p>
        ${station.body}
      </div>
    </article>`;
}

/* ---- the safety model, stated plainly ---- */

function Safety() {
  return html`
    <section class="notice" id="safety">
      <h2 class="notice-title">Service information</h2>
      <p class="notice-lede">
        Two layers keep an unattended run inside its lane, and they are not equally strong. The
        difference matters most on the night the console falls over.
      </p>

      <div class="layers">
        <div class="layer holds">
          <h3>The deny list holds</h3>
          <p>
            Enforced inside Claude Code itself, with no network involved. Measured still blocking
            with the console unreachable.
          </p>
          <p class="layer-what">
            <code>git push</code>, <code>terraform apply</code>, <code>terraform destroy</code>,
            <code>sudo</code>, publishing a package, <code>kubectl delete</code>.
          </p>
          <p class="layer-note">
            Nothing can approve past these. You run them yourself, deliberately. Add your own in
            <code>~/.config/phase-console/autopilot.json</code> — your rules merge on top of the
            defaults and can only add to them.
          </p>
        </div>

        <div class="layer opens">
          <h3>The approval hook does not</h3>
          <p>
            It is an HTTP call to this console, and Claude Code treats a call it cannot make as a
            non-blocking error. Measured: with nothing listening, the tool ran.
          </p>
          <p class="layer-what">
            So approvals are <strong>workflow</strong>, not safety. They let you decide from a
            phone; they are not what stands between an agent and a deploy.
          </p>
          <p class="layer-note">
            This is why anything genuinely irreversible belongs in the deny list rather than the
            ask list, and why the guide says so here rather than burying it.
          </p>
        </div>
      </div>

      <div class="verified" id="verified">
        <h3>What "verified" means</h3>
        <p>
          Three independent checks have to agree before a phase advances: the plan's verification
          commands ran green, <code>validate.sh</code> still passes, and the board re-read from
          disk says done.
        </p>
        <p>
          <strong>And what it does not mean.</strong> Plans write verification as prose with
          commands embedded — <code>… -m "not slow"</code> is a continuation fragment, and
          "targeted pytest + safe set" names two suites in English and no command at all. The
          runner executes only what is recognisably a command and demonstrably read-only, and
          reports every fragment it left behind. On the default autonomy an incomplete verification
          stops the run instead of calling it green. Those fragments are listed against the phase
          on the Autopilot tab; they are yours to check.
        </p>
      </div>
    </section>`;
}

function Suspended() {
  return html`
    <section class="notice" id="states">
      <h2 class="notice-title">When a run stops</h2>
      <p class="notice-lede">Four ways a run comes to rest. Only one of them is a problem.</p>
      <div class="states">
        ${STATES.map((s) => html`
          <article key=${s.state} class=${`state-card tone-${s.tone}`}>
            <h3>${s.state}</h3>
            <p class="means">${s.means}</p>
            <p class="causes">${s.causes}</p>
            <p class="do"><span>Do</span> ${s.action}</p>
          </article>`)}
      </div>
    </section>`;
}

function Reference() {
  return html`
    <section class="notice" id="reference">
      <h2 class="notice-title">Reference</h2>

      <div class="ref-grid">
        <div>
          <h3>Gate checks</h3>
          <p class="ref-lede">
            Add <code>- **Gate-check:** &lt;type&gt; …</code> to a phase to say what holds it up.
            A gate the machine can read clears itself; one it cannot waits for you.
          </p>
          <table class="ref">
            <tbody>
              ${GATES.map(([syntax, meaning]) => html`
                <tr key=${syntax}><th><code>${syntax}</code></th><td>${meaning}</td></tr>`)}
            </tbody>
          </table>
        </div>

        <div>
          <h3>Console flags</h3>
          <table class="ref">
            <tbody>
              ${FLAGS.map(([flag, meaning]) => html`
                <tr key=${flag}><th><code>${flag}</code></th><td>${meaning}</td></tr>`)}
            </tbody>
          </table>

          <h3>Where things live</h3>
          <table class="ref">
            <tbody>
              <tr><th><code>docs/plans/</code></th><td>The plans. Yours, in git.</td></tr>
              <tr><th><code>docs/handoffs/</code></th><td>Per-phase handoffs and locks. Yours, in git.</td></tr>
              <tr><th><code>~/.local/state/phase-console/</code></th><td>Run checkpoints, journals, the log. Never inside your repository, so <code>git status</code> stays clean.</td></tr>
              <tr><th><code>~/.config/phase-console/</code></th><td>Preferences and your autopilot policy.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="engine">
        <h3>The engine, if you would rather drive it yourself</h3>
        <p class="ref-lede">
          Everything the console shows comes from these. It never recomputes status in the browser,
          so what you see here and what you get in a terminal cannot disagree.
        </p>
        <pre class="cmd">scripts/phase-graph.sh &lt;slug&gt;                  # the board
scripts/phase-graph.sh &lt;slug&gt; --boot-prompt N   # the prompt for one phase
scripts/phase-graph.sh &lt;slug&gt; --session-plan    # which phases to batch
scripts/phase-graph.sh &lt;slug&gt; --gate-status N   # is this phase held up
scripts/validate.sh &lt;slug&gt;                      # lint the plan
scripts/new-handoff.sh &lt;slug&gt; N title complete  # scaffold a handoff
scripts/phase-lock.sh &lt;slug&gt; status N           # who is working this phase</pre>
      </div>
    </section>`;
}
