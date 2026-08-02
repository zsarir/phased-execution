/**
 * What a session's stream looks like once it is a console.
 *
 * Two pure functions and two tables, kept apart from the component that renders
 * them for one reason: the client resolves `preact` through an import map, so
 * anything that imports it cannot be loaded outside a browser — and this is the
 * part with the subtle behaviour, so it is the part that has to be testable.
 *
 * `toLine` maps one server event to one line. `fold` decides how that line joins
 * the ones already there, which is where streamed text stops being fifty rows
 * of one token each.
 */

/** Beyond this the oldest lines are dropped; the journal has the full record. */
export const MAX_LINES = 600;

export const KIND_LABEL = {
  init: 'session',
  text: 'says',
  partial: 'says',
  thinking: 'thinks',
  subagent: 'agent',
  tool: 'tool',
  hook: 'hook',
  limits: 'usage',
  injected: 'btw',
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
    if (data.status === 'verifying') return { kind: 'phase', text: `phase ${data.phase} finished — verifying independently` };
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
      return { kind: 'init', text: `${data.model ?? 'session'} started · ${data.tools ?? '?'} tools available` };
    case 'tool':
      return { kind: 'tool', text: data.summary ? `${data.name}  ${data.summary}` : data.name };
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
      return { kind: 'subagent', text: data.text, partial: true };
    case 'hook':
      return { kind: 'hook', text: `${data.name}${data.event ? ` (${data.event})` : ''}${data.outcome ? ` — ${data.outcome}` : ''}` };
    case 'injected':
      return { kind: 'injected', text: data.text };
    case 'limits': {
      if (data.utilization == null) return null;
      const window = String(data.window ?? 'usage').replace(/_/g, ' ');
      const resets = data.resetsAt ? `, resets ${new Date(data.resetsAt * 1000).toLocaleString()}` : '';
      return { kind: 'limits', text: `${Math.round(data.utilization * 100)}% of the ${window} window used${resets}` };
    }
    case 'retry':
      return { kind: 'retry', text: `absorbed by the CLI${data.category ? ` — ${data.category}` : ''}${data.detail ? `: ${data.detail}` : ''}` };
    case 'result':
      return { kind: 'result', text: `${data.subtype} · ${data.turns ?? 0} turns · $${(data.costUsd ?? 0).toFixed(3)}` };
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

  // Fragments of the same kind, still streaming: one line, growing.
  if (line.partial && last?.partial && last.kind === line.kind) {
    return [...lines.slice(0, -1), { ...last, text: last.text + line.text, at }];
  }

  // The finished block supersedes the fragments it was streamed as.
  if (line.supersedes && last?.partial && last.kind === line.supersedes) {
    return [...lines.slice(0, -1), { ...line, id: last.id, at: last.at }];
  }

  const next = [...lines, { ...line, id: nextId, at }];
  return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
}
