/**
 * One phase, one `claude -p` process.
 *
 * This is where "clear the session between phases" is implemented, and the
 * implementation is that there is nothing to implement: the process exits, and
 * with it the context. There is no `/clear` to send and no session to reset —
 * each phase starts from a boot prompt and the files on disk, which is exactly
 * the contract `phased-execution` already assumes.
 *
 * ## Why the prompt goes down stdin rather than argv
 *
 * The phase is driven in **streaming-input mode** (`--input-format stream-json`),
 * which keeps stdin open for the life of the session. That is the only way to
 * say anything to a session once it has started — which is what the console's
 * `/btw` box does — and it costs nothing when nobody says anything.
 *
 * Measured, because the behaviour is not obvious: in that mode a positional
 * prompt (`-p "…"`) is **silently ignored** and only stdin is read. So the boot
 * prompt is written as the first NDJSON message, and passing it positionally
 * would look right and run the wrong thing. Each further message becomes a new
 * turn in the *same* session, with the context and the prompt cache intact, and
 * each turn ends with its own `result` message — so a `result` here means "a
 * turn finished", never "the process is finished".
 *
 * Three flags are never passed, whatever the caller asks for, plus one value:
 *
 *   --bare                         skips settings, and with them the repo's
 *                                  PreToolUse hooks — including the destructive
 *                                  -operation guard this monorepo relies on.
 *   --safe-mode                    disables hooks, skills and plugins wholesale.
 *   --setting-sources              can drop the repository's own settings.
 *   --permission-mode bypassPermissions   everything, unreviewed.
 *
 * They are stripped in one place, `sanitize()`, so no future caller can
 * reintroduce them by passing extra arguments.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { log } from '../log.ts';
import { childEnv, type StopSignal } from './errors.ts';

/** Boolean flags that take the guard rails off, regardless of who asked. */
const FORBIDDEN = [
  '--bare',
  '--safe-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-allow-browser-tool-in-non-sandboxed-mode',
];

/**
 * Forbidden flags that consume the next argument. Dropping the flag alone
 * would leave its value loose in argv, where it becomes a positional prompt.
 */
const FORBIDDEN_WITH_VALUE = ['--setting-sources'];

/**
 * Values that must never be given to an otherwise legitimate flag. Rewritten
 * rather than dropped: removing `--permission-mode` entirely would fall back to
 * the interactive default, which in headless mode is a silent refusal of every
 * edit — a fix that quietly breaks every run is not a fix.
 */
const FORBIDDEN_VALUES: Record<string, { values: string[]; safe: string }> = {
  '--permission-mode': { values: ['bypassPermissions'], safe: 'acceptEdits' },
};

/** What the CLI accepts; anything else is only a warning there, so check here. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan', 'manual'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type StreamEvent =
  | { kind: 'init'; sessionId: string; model?: string; tools?: number }
  | { kind: 'text'; text: string }
  /** Coalesced `text_delta`s — the same words, arriving as they are written. */
  | { kind: 'partial'; text: string }
  /** Coalesced `thinking_delta`s. Separate because it is not the answer. */
  | { kind: 'thinking'; text: string }
  /** Text from a subagent, identified by `parent_tool_use_id`. */
  | { kind: 'subagent'; text: string; parent: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'hook'; name: string; event: string; outcome?: string }
  /** A message the operator sent into a running session, echoed back by the CLI. */
  | { kind: 'injected'; text: string }
  /** The account's usage window, as the CLI reports it mid-session. */
  | { kind: 'limits'; status: string; window?: string; utilization?: number; resetsAt?: number }
  | { kind: 'retry'; category?: string; attempt?: number; detail?: string }
  | { kind: 'result'; subtype?: string; costUsd?: number; turns?: number; isError?: boolean }
  | { kind: 'stderr'; text: string };

/**
 * A live session, for as long as it is live.
 *
 * Handed to the caller the moment the child exists so an operator question can
 * reach a phase that is already running.
 */
export type SpawnHandle = {
  pid?: number;
  /** True when the message was written. False when the session will not take it. */
  send(text: string): boolean;
  /** Are we still able to send? */
  open(): boolean;
};

export type SpawnRequest = {
  prompt: string;
  cwd: string;
  model?: string;
  /** Effort level for this session (`--effort`). */
  effort?: string;
  /** Fixed id so a deferred approval or a cap raise can resume this exact session. */
  sessionId?: string;
  /** Continue an existing session instead of starting one. */
  resume?: string;
  budgetUsd?: number | null;
  maxTurns?: number | null;
  /** Models to fail over to in-place, in order, without losing the session. */
  fallbackModels?: string[];
  /** Shown in `/resume` and `claude agents` — worth having on an unattended run. */
  name?: string;
  /** Restrict the built-in tool set for this phase (`--tools`). */
  tools?: string[];
  /** Ignore every MCP server not passed explicitly. */
  strictMcp?: boolean;
  /** JSON passed to `--settings`: the per-run hook and its ask-rules (W3). */
  settings?: string;
  permissionMode?: PermissionMode;
  /** Stream assistant text as it is written rather than per finished block. */
  partialMessages?: boolean;
  /** Forward subagent text, so a phase that delegates is not a silent gap. */
  subagentText?: boolean;
  /** Put hook lifecycle in the stream, so approvals are visible as they fire. */
  hookEvents?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Told the pid as soon as there is one, so a checkpoint can record it. */
  onPid?: (pid: number) => void;
  /** Handed the live session, so something can talk to it while it runs. */
  onHandle?: (handle: SpawnHandle) => void;
};

export type SpawnOutcome = {
  signal: StopSignal;
  sessionId?: string;
  costUsd: number;
  turns: number;
  resultText: string;
  durationMs: number;
  /** Exactly what ran, for the journal. The prompt is not repeated here. */
  argv: string[];
  /** Messages the operator injected mid-session, for the record. */
  injected: number;
};

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;

/** argv is bounded by the OS; a boot prompt is kilobytes, so this is a sanity bound. */
const MAX_PROMPT_BYTES = 512 * 1024;
/** Keep the last of stderr for classification — not a whole build log. */
const KEEP_STDERR = 16_000;
/** A single NDJSON line past this is a runaway, not a message. */
const MAX_LINE = 8 * 1024 * 1024;
/**
 * Deltas arrive per token. Forwarding each one puts thousands of SSE frames in
 * front of a browser that can only paint sixty times a second, so they are
 * gathered and released on a fixed beat instead.
 */
const PARTIAL_FLUSH_MS = 120;

export function buildArgv(request: SpawnRequest): string[] {
  const argv = [
    // No positional prompt: in streaming-input mode it is ignored, and a prompt
    // that looks passed but is not is the worst of both.
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    // Echoes each message we send back on stdout, which is how the console
    // knows an operator's question actually reached the session.
    '--replay-user-messages',
    // stream-json in print mode requires it; it is also what makes tool calls
    // visible to the console instead of only the final answer.
    '--verbose',
    '--permission-mode', request.permissionMode ?? 'acceptEdits',
  ];
  if (request.resume) argv.push('--resume', request.resume);
  else argv.push('--session-id', request.sessionId ?? randomUUID());
  if (request.model) argv.push('--model', request.model);
  if (request.effort) {
    // The CLI only warns on an unknown value and carries on at its default, so
    // a typo would silently run the whole plan at the wrong effort.
    if (isEffort(request.effort)) argv.push('--effort', request.effort);
    else log.warn('spawn.bad-effort', { effort: request.effort, allowed: EFFORTS });
  }
  const fallbacks = (request.fallbackModels ?? []).filter(Boolean);
  if (fallbacks.length) argv.push('--fallback-model', fallbacks.join(','));
  if (request.name) argv.push('--name', request.name.slice(0, 80));
  if (request.budgetUsd && request.budgetUsd > 0) argv.push('--max-budget-usd', String(request.budgetUsd));
  if (request.maxTurns && request.maxTurns > 0) argv.push('--max-turns', String(request.maxTurns));
  if (request.tools?.length) argv.push('--tools', request.tools.join(','));
  if (request.strictMcp) argv.push('--strict-mcp-config');
  if (request.partialMessages) argv.push('--include-partial-messages');
  if (request.subagentText) argv.push('--forward-subagent-text');
  if (request.hookEvents) argv.push('--include-hook-events');
  if (request.settings) argv.push('--settings', request.settings);
  return sanitize(argv);
}

/** The one place a forbidden flag can be removed, so it is the only place to audit. */
export function sanitize(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (FORBIDDEN.includes(arg)) {
      log.warn('spawn.refused-flag', { flag: arg });
      continue;
    }

    if (FORBIDDEN_WITH_VALUE.includes(arg)) {
      // Drop the value with it. Left behind, it becomes a loose positional.
      log.warn('spawn.refused-flag', { flag: arg, droppedValue: argv[i + 1] });
      i++;
      continue;
    }

    const rule = FORBIDDEN_VALUES[arg];
    if (rule && rule.values.includes(argv[i + 1])) {
      log.warn('spawn.refused-value', { flag: arg, value: argv[i + 1], replacedWith: rule.safe });
      out.push(arg, rule.safe);
      i++;
      continue;
    }

    out.push(arg);
  }
  return out;
}

/** One NDJSON user message, the shape the CLI reads in streaming-input mode. */
export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

export const spawnClaude: SpawnFn = (request) => new Promise<SpawnOutcome>((resolve) => {
  const started = Date.now();
  if (Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES) {
    resolve(fail(`the boot prompt is over ${MAX_PROMPT_BYTES / 1024}KB — the plan is malformed`, started, []));
    return;
  }

  const argv = buildArgv(request);
  const shown = [...argv];

  const child = spawn('claude', argv, {
    cwd: request.cwd,
    env: childEnv(request.env),
    // stdin is a pipe now: it carries the boot prompt, and it stays open so an
    // operator can put a question to a phase that is already running.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sessionId = request.resume ?? undefined;
  let costUsd = 0;
  let turns = 0;
  let resultText = '';
  let subtype: string | undefined;
  let stopReason: string | null | undefined;
  let stderr = '';
  const retryCategories: string[] = [];
  let settled = false;

  /* ---- the conversation's own state ---- */
  /** The boot-prompt turn has produced its result: the phase's work is done. */
  let phaseTurnDone = false;
  /** Operator messages written but not yet answered. */
  let outstanding = 0;
  let injected = 0;
  let stdinOpen = true;
  /** How many of our own messages the CLI has echoed back at us. */
  let echoes = 0;

  const finish = (outcome: SpawnOutcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };

  if (child.pid) request.onPid?.(child.pid);

  const emit = (event: StreamEvent) => {
    try { request.onEvent?.(event); } catch { /* a listener must not kill the run */ }
  };

  /* ---- writing to the child ---- */

  // EPIPE on a child that has already gone is normal, not a fault: it means the
  // session ended between our deciding to write and the write landing.
  child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
    stdinOpen = false;
    if (error.code !== 'EPIPE') log.warn('spawn.stdin', { error });
  });

  const write = (text: string): boolean => {
    if (!stdinOpen || !child.stdin?.writable) return false;
    try {
      child.stdin.write(userMessage(text));
      return true;
    } catch (error) {
      log.warn('spawn.stdin-write', { error });
      return false;
    }
  };

  const closeStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    try { child.stdin?.end(); } catch { /* already gone */ }
  };

  // The boot prompt, as the session's first turn.
  write(request.prompt);

  request.onHandle?.({
    pid: child.pid ?? undefined,
    open: () => stdinOpen && !settled,
    send: (text: string) => {
      if (!text.trim()) return false;
      if (!write(text)) return false;
      outstanding++;
      injected++;
      return true;
    },
  });

  /* ---- coalescing the delta firehose ---- */

  let pendingText = '';
  let pendingThinking = '';
  let flushTimer: NodeJS.Timeout | null = null;

  const flushPartials = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingText) { const text = pendingText; pendingText = ''; emit({ kind: 'partial', text }); }
    if (pendingThinking) { const text = pendingThinking; pendingThinking = ''; emit({ kind: 'thinking', text }); }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(flushPartials, PARTIAL_FLUSH_MS);
    flushTimer.unref?.();
  };

  const onAbort = () => {
    // SIGTERM so the session's own SessionEnd hooks still run; the runner
    // escalates to SIGKILL if it has to.
    closeStdin();
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  const handleLine = (line: string) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    const id = message.session_id;
    if (typeof id === 'string' && id) sessionId = id;

    const type = message.type;
    const sub = typeof message.subtype === 'string' ? message.subtype : undefined;
    const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;

    if (type === 'system' && sub === 'init') {
      emit({
        kind: 'init',
        sessionId: sessionId ?? '',
        model: typeof message.model === 'string' ? message.model : undefined,
        tools: Array.isArray(message.tools) ? message.tools.length : undefined,
      });
      return;
    }

    // Hook lifecycle, when asked for. Only the settled ones are worth a line:
    // started/progress would treble the volume and say nothing new.
    if (type === 'system' && sub === 'hook_response') {
      emit({
        kind: 'hook',
        name: String(message.hook_name ?? 'hook'),
        event: String(message.hook_event ?? ''),
        outcome: typeof message.outcome === 'string' ? message.outcome : undefined,
      });
      return;
    }

    // How much of the account's window is left, straight from the CLI. An
    // unattended run that is about to walk into a wall should say so first.
    if (type === 'rate_limit_event') {
      const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
      emit({
        kind: 'limits',
        status: String(info.status ?? 'unknown'),
        window: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
        utilization: typeof info.utilization === 'number' ? info.utilization : undefined,
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
      });
      return;
    }

    // The retry stream is how the CLI reports what it is absorbing on our
    // behalf. The field has been spelled several ways; take whichever is there
    // rather than silently recording no category at all.
    if (type === 'system' && sub === 'api_retry') {
      const category = firstString(message, ['error_category', 'category', 'error_type', 'reason']);
      if (category) retryCategories.push(category);
      emit({
        kind: 'retry',
        category,
        attempt: typeof message.attempt === 'number' ? message.attempt : undefined,
        detail: firstString(message, ['error', 'message', 'detail']),
      });
      return;
    }

    if (type === 'stream_event') {
      const event = (message.event ?? {}) as { type?: string; delta?: Record<string, unknown> };
      if (event.type !== 'content_block_delta') return;
      const delta = event.delta ?? {};
      if (typeof delta.text === 'string' && delta.text) {
        // A subagent's words are not the phase's words; do not interleave them
        // into the same buffer, or a delegated stretch reads as one voice.
        if (parent) emit({ kind: 'subagent', text: delta.text, parent });
        else { pendingText += delta.text; scheduleFlush(); }
      } else if (typeof delta.thinking === 'string' && delta.thinking) {
        pendingThinking += delta.thinking;
        scheduleFlush();
      }
      return;
    }

    if (type === 'assistant') {
      // Whatever streamed as deltas is about to arrive again, whole.
      flushPartials();
      const content = (message.message as { content?: unknown[]; stop_reason?: string } | undefined);
      if (content?.stop_reason) stopReason = content.stop_reason;
      for (const block of content?.content ?? []) {
        const item = block as { type?: string; text?: string; name?: string; input?: unknown };
        if (item.type === 'text' && item.text) {
          if (parent) emit({ kind: 'subagent', text: item.text, parent });
          else emit({ kind: 'text', text: item.text });
        }
        if (item.type === 'tool_use' && item.name) {
          emit({ kind: 'tool', name: item.name, summary: summarise(item.input) });
        }
      }
      return;
    }

    // `--replay-user-messages` sends our own messages back. That is the only
    // confirmation that an operator's question reached the session at all.
    if (type === 'user' && !parent) {
      const content = (message.message as { content?: unknown[] } | undefined)?.content;
      const text = Array.isArray(content)
        ? content.map((b) => (b as { text?: string }).text).filter(Boolean).join(' ')
        : undefined;
      // The first echo is always the boot prompt: not news, and thousands of
      // lines long. Counted rather than compared by text, because an echo the
      // CLI normalised even slightly would otherwise be shown in full as
      // something the operator had supposedly just typed.
      echoes++;
      if (text && echoes > 1) emit({ kind: 'injected', text });
      return;
    }

    if (type === 'result') {
      flushPartials();
      subtype = sub;
      // `total_cost_usd` is the running total for the whole session, not this
      // turn's share — so the last one wins and they are never summed.
      if (typeof message.total_cost_usd === 'number') costUsd = message.total_cost_usd;
      if (typeof message.num_turns === 'number') turns = Math.max(turns, message.num_turns);
      const text = message.result ?? message.error;
      if (typeof text === 'string') resultText = text;
      emit({
        kind: 'result',
        subtype,
        costUsd,
        turns,
        isError: message.is_error === true,
      });

      // One result per TURN. The first belongs to the boot prompt, so the phase
      // has done its work; any after that answer an operator's question. When
      // nothing is left to answer, stdin closes and the process exits.
      if (!phaseTurnDone) phaseTurnDone = true;
      else outstanding = Math.max(0, outstanding - 1);
      if (phaseTurnDone && outstanding === 0) closeStdin();
    }
  };

  const stdoutLines = lineReader(handleLine);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdoutLines.push(chunk));
  child.stdout?.on('error', (error) => log.warn('spawn.stdout', { error }));

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-KEEP_STDERR);
    emit({ kind: 'stderr', text: chunk });
  });
  child.stderr?.on('error', (error) => log.warn('spawn.stderr', { error }));

  child.on('error', (error: NodeJS.ErrnoException) => {
    request.signal?.removeEventListener('abort', onAbort);
    flushPartials();
    const reason = error.code === 'ENOENT'
      ? 'the `claude` CLI is not on PATH for this process'
      : `could not start claude: ${error.message}`;
    finish(fail(reason, started, shown));
  });

  child.on('close', (code, sig) => {
    request.signal?.removeEventListener('abort', onAbort);
    stdinOpen = false;
    stdoutLines.flush();
    flushPartials();

    // Result text first: it is the CLI's own account of why it stopped. stderr
    // follows because some failures never reach a result message at all.
    const text = [resultText, stderr].filter(Boolean).join('\n');
    finish({
      signal: {
        subtype,
        code: code ?? (sig === 'SIGTERM' ? 143 : sig === 'SIGKILL' ? 137 : null),
        stopReason,
        text,
        retryCategories,
        model: request.model,
      },
      sessionId,
      costUsd,
      turns,
      resultText,
      durationMs: Date.now() - started,
      argv: shown,
      injected,
    });
  });
});

function fail(reason: string, started: number, argv: string[]): SpawnOutcome {
  return {
    signal: { subtype: 'error_during_execution', code: null, text: reason },
    costUsd: 0,
    turns: 0,
    resultText: reason,
    durationMs: Date.now() - started,
    argv,
    injected: 0,
  };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

/**
 * NDJSON over a pipe arrives in chunks that split lines anywhere, including
 * mid-escape. Buffer until a newline; drop the buffer if it ever grows past
 * anything a real message could be, so a stuck stream cannot eat memory.
 */
export function lineReader(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE) {
        log.warn('spawn.line-overflow', { bytes: buffer.length });
        buffer = '';
      }
    },
    flush(): void {
      const line = buffer.trim();
      buffer = '';
      if (line) onLine(line);
    },
  };
}
