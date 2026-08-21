/**
 * What a session's stream looks like once it is a console.
 *
 * Three pure functions and two tables, kept apart from the component that
 * renders them for one reason: the client resolves `preact` through an import
 * map, so anything that imports it cannot be loaded outside a browser — and
 * this is the part with the subtle behaviour, so it is the part that has to be
 * testable.
 *
 * `toLine` maps one server event to one line. `fold` decides how that line joins
 * the ones already there, which is where streamed text stops being fifty rows
 * of one token each. `activity` is the other reading of the same events: not a
 * scrolling log but the *state* they describe — what the session's task list
 * says, which tool calls are still outstanding, which subagents are talking.
 *
 * All three are fed from one place, so a replayed run and a watched one cannot
 * disagree: the transcript holds raw events, and every panel is derived here.
 */

/** Beyond this the oldest lines are dropped; the journal has the full record. */
export const MAX_LINES = 600;
/** Tool calls kept for the activity panel. A long phase makes thousands. */
export const MAX_TOOLS = 200;
/** Concurrent subagent lanes worth drawing. Beyond this it is not a lane. */
export const MAX_AGENTS = 12;
/** Rows in the task-list panel. A phase's list is a dozen; this is the guard. */
export const MAX_TODOS = 80;
/** One lane holds a summary of what an agent said, never its whole output. */
const MAX_AGENT_TEXT = 4_000;

export const KIND_LABEL = {
  init: 'session',
  text: 'says',
  partial: 'says',
  thinking: 'thinks',
  subagent: 'agent',
  tool: 'tool',
  'tool-fail': 'failed',
  hook: 'hook',
  limits: 'usage',
  injected: 'btw',
  steer: 'steer',
  answer: 'answers',
  idle: 'idle',
  retry: 'retry',
  result: 'ended',
  stderr: 'stderr',
  verify: 'verify',
  phase: 'phase',
  runner: 'runner',
};

/**
 * Kinds that are noise until you want them. Thinking is the model's working,
 * not its answer, and hook lines are one per tool call — both are worth having
 * and neither should be the default reading experience.
 */
export const QUIET = new Set(['thinking', 'hook']);

/**
 * Fold a server stream event into a console line, or null to ignore it.
 * Kept out of the component so the mapping is one readable table.
 */
export function toLine(event, data) {
  if (event === 'verify') {
    return { kind: 'verify', text: `[${data.index + 1}/${data.total}] ${data.command}` };
  }
  if (event === 'phase') {
    if (data.status === 'running') {
      return {
        kind: 'phase',
        text: `phase ${data.phase} started on ${data.model}${data.effort ? ` at ${data.effort} effort` : ''}`,
      };
    }
    if (data.status === 'verifying')
      return { kind: 'phase', text: `phase ${data.phase} finished — verifying independently` };
    if (data.status === 'done') return { kind: 'phase', text: `phase ${data.phase} confirmed done` };
    if (data.status === 'awaiting-verification') {
      return {
        kind: 'runner',
        text: `phase ${data.phase} is waiting on you — ${data.notRun ?? 'some'} check(s) the runner cannot make itself`,
      };
    }
    if (data.disposition && data.disposition !== 'ok') {
      return { kind: 'runner', text: `phase ${data.phase}: ${data.disposition} — ${data.reason ?? ''}` };
    }
    return null;
  }
  if (event !== 'stream') return null;

  switch (data.kind) {
    case 'init':
      return {
        kind: 'init',
        text: `${data.model ?? 'session'} started · ${data.tools ?? '?'} tools available`,
      };
    case 'tool': {
      // A `Task` says which agent it is handing to, because "Task" three times
      // in a row is the same line three times to a reader.
      const name = data.agent ? `${data.name} → ${data.agent}` : data.name;
      return {
        kind: 'tool',
        text: data.summary ? `${name}  ${data.summary}` : name,
        tool: data.id,
        parent: data.parent,
      };
    }
    case 'tool-result':
      // The call already printed a line going out, so echoing every success
      // doubles the console and says nothing new — the activity panel is where
      // durations and outcomes belong. A failure is the exception: it is the
      // thing someone reading this at all o'clock is looking for.
      if (data.ok !== false) return null;
      return {
        kind: 'tool-fail',
        text: data.detail || 'the call failed',
        tool: data.id,
        parent: data.parent,
      };
    // The task list is state, not a line. It renders as a panel that always
    // shows the latest one rather than as fifteen rewrites scrolling past.
    // (The tool call that carried it still prints, so nothing is hidden.)
    case 'todos':
    case 'task':
      return null;
    case 'text':
      // The same words already arrived as deltas. Showing them twice turns a
      // streamed answer into a stutter, so the finished block replaces the
      // fragments rather than following them.
      return { kind: 'text', text: data.text, supersedes: 'partial' };
    case 'partial':
      return { kind: 'partial', text: data.text, partial: true };
    case 'thinking':
      return { kind: 'thinking', text: data.text, partial: true };
    case 'subagent':
      // `parent` is the id of the `Task` call that started this agent, and
      // carrying it is what stops two agents talking at once from folding into
      // one line: `fold` will only join fragments that came from the same one.
      return { kind: 'subagent', text: data.text, parent: data.parent, partial: true };
    case 'hook':
      return {
        kind: 'hook',
        text: `${data.name}${data.event ? ` (${data.event})` : ''}${data.outcome ? ` — ${data.outcome}` : ''}`,
      };
    // One operator message, emitted twice on purpose: undelivered by the runner
    // the instant it is written, delivered again when the CLI echoes it back.
    // `fold` joins them on the mark, so the console shows the question once and
    // ticks it rather than printing it a second time.
    case 'injected':
      return {
        kind: data.steer ? 'steer' : 'injected',
        text: data.text,
        mark: data.mark,
        delivered: data.delivered === true,
      };
    case 'answer':
      // Supersedes the fragments for the same reason a finished text block
      // does: the words already streamed as deltas, and showing them again
      // under a different label is the stutter twice over.
      return { kind: 'answer', text: data.text, mark: data.mark, supersedes: 'partial' };
    case 'idle':
      return {
        kind: 'idle',
        text: `stdin closed after ${Math.round((data.afterMs ?? 0) / 1000)}s of silence — ${data.reason ?? 'the session stopped streaming'}`,
      };
    case 'limits': {
      if (data.utilization == null) return null;
      const window = String(data.window ?? 'usage').replace(/_/g, ' ');
      const resets = data.resetsAt ? `, resets ${new Date(data.resetsAt * 1000).toLocaleString()}` : '';
      return {
        kind: 'limits',
        text: `${Math.round(data.utilization * 100)}% of the ${window} window used${resets}`,
      };
    }
    case 'retry':
      return {
        kind: 'retry',
        text: `absorbed by the CLI${data.category ? ` — ${data.category}` : ''}${data.detail ? `: ${data.detail}` : ''}`,
      };
    case 'result':
      return {
        kind: 'result',
        text: `${data.subtype} · ${data.turns ?? 0} turns · $${(data.costUsd ?? 0).toFixed(3)}`,
      };
    case 'stderr':
      return { kind: 'stderr', text: String(data.text ?? '').trimEnd() };
    default:
      return null;
  }
}

/**
 * Add one line to a window, folding streamed fragments into the line they
 * belong to.
 *
 * Without this, `--include-partial-messages` turns a paragraph into fifty rows
 * — one per token — and then repeats the whole paragraph again when the
 * finished block arrives. Both the folding and the replacement live here so a
 * replayed run and a watched one cannot read differently.
 */
export function fold(lines, line, nextId, at = Date.now()) {
  const last = lines.at(-1);

  // One operator message renders once, however many times it is announced.
  //
  // A `/btw` used to appear three times: the client's own optimistic echo, the
  // server's `injected` event, and the CLI's `--replay-user-messages` replay
  // carrying the framed text. The optimistic echo is gone and the other two now
  // share a mark, so the second one updates the first — the delivery tick — and
  // the operator's own words are kept rather than the frame the session saw.
  if (line.mark && (line.kind === 'injected' || line.kind === 'steer')) {
    const index = lines.findIndex(
      (l) => l.mark === line.mark && (l.kind === 'injected' || l.kind === 'steer'),
    );
    if (index >= 0) {
      const merged = { ...lines[index], delivered: lines[index].delivered || line.delivered };
      return [...lines.slice(0, index), merged, ...lines.slice(index + 1)];
    }
  }

  // Fragments of the same kind, from the same speaker, still streaming: one
  // line, growing.
  //
  // "From the same speaker" is the part that was missing. Every subagent
  // fragment shares `kind: 'subagent'` and `partial: true`, so two agents
  // running at once had their sentences interleaved into a single line —
  // legible as neither one. `parent` is the id of the `Task` that started an
  // agent; it is `undefined` on the phase's own text, so ordinary partials
  // still fold exactly as they did.
  if (line.partial && last?.partial && last.kind === line.kind && last.parent === line.parent) {
    return [...lines.slice(0, -1), { ...last, text: last.text + line.text, at }];
  }

  // The finished block supersedes the fragments it was streamed as.
  if (line.supersedes && last?.partial && last.kind === line.supersedes) {
    return [...lines.slice(0, -1), { ...line, id: last.id, at: last.at }];
  }

  const next = [...lines, { ...line, id: nextId, at }];
  return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
}

/* ------------------------------------------------------------------ *
 * The same events, read as state rather than as a log
 * ------------------------------------------------------------------ */

/**
 * Nothing has happened yet. Frozen so a caller cannot mutate the empty case
 * into a shared one — every transition below returns a new object.
 */
export const NO_ACTIVITY = Object.freeze({
  /** The session's own task list, as `TodoWrite` last wrote it. */
  todos: [],
  todosAt: 0,
  /** Every tool call this phase has made, oldest first, capped. */
  tools: [],
  /** One entry per subagent this phase started, keyed by its `Task` call. */
  agents: [],
});

/**
 * Fold one event into what the panels show.
 *
 * The console answers "what has it said"; this answers "what is it doing" —
 * and they are different questions with different right answers. A task list
 * rewritten fifteen times is one panel, not fifteen lines. A tool call is
 * interesting for as long as it is outstanding, which a scrolling log cannot
 * express at all. And a subagent's words belong beside that subagent's name.
 *
 * Pure, and fed from the same events as `toLine`, so a reload replays into the
 * same state a watching tab already had — the panels survive a refresh for the
 * same reason the console does, and by the same mechanism.
 */
export function activity(state, event, data, at = Date.now()) {
  // A new phase is a new session with a new task list. Carrying the last one
  // over would show the previous phase's work as this one's.
  if (event === 'phase' && data?.status === 'running') return { ...NO_ACTIVITY };
  if (event !== 'stream' || !data) return state;

  switch (data.kind) {
    // Two spellings of one thing, because two CLIs spell it differently.
    // `TodoWrite` rewrites the whole list every time; `TaskCreate`/`TaskUpdate`
    // — which is what the current CLI actually calls — build it one row at a
    // time. Supporting only the first left this panel permanently empty against
    // a real session, which is worse than not having it.
    case 'todos': {
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) return state;
      return { ...state, todos: items, todosAt: at };
    }

    case 'task': {
      if (data.op === 'create') {
        if (!data.content) return state;
        // `id` stays null until the create's own result hands one back — see
        // `tool-result` below. Until then the row exists and simply cannot be
        // addressed, which is exactly true of the task.
        const todos = [
          ...state.todos,
          {
            key: data.call,
            id: null,
            content: data.content,
            activeForm: data.activeForm,
            status: 'pending',
          },
        ].slice(-MAX_TODOS);
        return { ...state, todos, todosAt: at };
      }
      if (!data.taskId) return state;
      const index = state.todos.findIndex((t) => t.id === data.taskId);
      if (index < 0) return state;
      if (data.status === 'deleted') {
        return { ...state, todos: state.todos.filter((_, i) => i !== index), todosAt: at };
      }
      const todos = state.todos.map((t, i) =>
        i === index
          ? {
              ...t,
              ...(data.status ? { status: data.status } : {}),
              ...(data.content ? { content: data.content } : {}),
              ...(data.activeForm ? { activeForm: data.activeForm } : {}),
            }
          : t,
      );
      return { ...state, todos, todosAt: at };
    }

    case 'tool': {
      const tools = [
        ...state.tools,
        {
          id: data.id,
          name: data.name,
          summary: data.summary || '',
          agent: data.agent,
          parent: data.parent,
          at,
          // `null` rather than absent: "still running" is a state the panel
          // renders, not a field it happens to be missing.
          ms: null,
          ok: null,
          detail: '',
        },
      ].slice(-MAX_TOOLS);
      // A delegation opens a lane. Everything that agent then says arrives
      // tagged with this call's id and nothing else, so this is the only moment
      // its name can be learned — and the name is optional on the tool, so the
      // lane opens on the delegation rather than on the name being there.
      const agents =
        data.delegates && data.id
          ? [
              ...state.agents,
              {
                id: data.id,
                agent: data.agent || '',
                title: data.summary || '',
                text: '',
                at,
                done: false,
              },
            ].slice(-MAX_AGENTS)
          : state.agents;
      return { ...state, tools, agents };
    }

    case 'tool-result': {
      if (!data.id) return state;

      // A `TaskCreate`'s id is in its RESULT, not its input ("Task #4 created
      // successfully: …"), so this is the only moment a created row can learn
      // the id that every later update will name it by. Without it an update
      // matches nothing and the list never changes after it is written.
      const created = /(?:^|\s)#(\d+)\b/.exec(data.detail || '');
      const pending = created ? state.todos.findIndex((t) => t.key === data.id && t.id == null) : -1;
      const todos =
        pending < 0 ? state.todos : state.todos.map((t, i) => (i === pending ? { ...t, id: created[1] } : t));

      const index = lastIndex(state.tools, (t) => t.id === data.id);
      const closes = state.agents.some((a) => a.id === data.id && !a.done);
      // No matching call and nothing else to bind — the transcript was
      // truncated above it, or the cap dropped it. A result with nothing to
      // attach to is not worth inventing a row for.
      if (index < 0 && !closes && pending < 0) return state;

      const tools =
        index < 0
          ? state.tools
          : state.tools.map((tool, i) =>
              i === index
                ? {
                    ...tool,
                    ms: typeof data.ms === 'number' ? data.ms : null,
                    ok: data.ok !== false,
                    detail: data.detail || '',
                  }
                : tool,
            );
      const agents = closes
        ? state.agents.map((a) => (a.id === data.id ? { ...a, done: true } : a))
        : state.agents;
      return { ...state, tools, agents, todos };
    }

    case 'subagent': {
      if (!data.parent || !data.text) return state;
      const known = state.agents.some((a) => a.id === data.parent);
      // An agent can be heard before its `Task` call is: a replay that starts
      // mid-phase has the words and not the call. Better an unnamed lane than
      // a silent one.
      const agents = known
        ? state.agents.map((a) =>
            a.id === data.parent ? { ...a, text: (a.text + data.text).slice(-MAX_AGENT_TEXT) } : a,
          )
        : [
            ...state.agents,
            {
              id: data.parent,
              agent: '',
              title: '',
              text: data.text.slice(-MAX_AGENT_TEXT),
              at,
              done: false,
            },
          ].slice(-MAX_AGENTS);
      return { ...state, agents };
    }

    default:
      return state;
  }
}

/** The newest match — a tool id repeats across a `--resume`d session. */
function lastIndex(list, match) {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) return i;
  return -1;
}
