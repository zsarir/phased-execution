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
 *
 * `bypassPermissions` is the one entry that a caller may now unlock, and only
 * by choosing the `bypass` profile for the run — see `SanitizeOptions`. It is
 * still listed here rather than special-cased at the call site, so `sanitize()`
 * remains the one place to audit.
 */
const FORBIDDEN_VALUES: Record<string, { values: string[]; safe: string; unlockedBy?: keyof SanitizeOptions }> = {
  '--permission-mode': { values: ['bypassPermissions'], safe: 'acceptEdits', unlockedBy: 'allowBypass' },
};

/**
 * The CLI's own words when it refuses the bypass mode it was handed.
 *
 * Measured, and it matters more than it looks: `bypassPermissions` requires a
 * disclaimer that can only be accepted **interactively**, once, on this
 * machine. Without it the CLI does not error and does not fall back to what we
 * asked for — it silently downgrades to `default`, and `default` in `-p` mode
 * means prompting a terminal that is not there, which is a refusal of every
 * edit. So the Bypass profile, on a machine where nobody ever accepted the
 * disclaimer, produces a run that can do **less** than Guarded and gives no
 * obvious reason why. Detecting the CLI's own line is the only honest signal
 * available: the flag is accepted, the argv looks right, and the run just
 * quietly cannot work.
 */
const BYPASS_DOWNGRADED = /Permission mode downgraded to default/i;

/** Did the CLI just tell us it refused the bypass mode we asked for? */
export function isBypassDowngrade(text: string): boolean {
  return BYPASS_DOWNGRADED.test(text);
}

function noteBypassDowngrade(emit: (event: StreamEvent) => void): void {
  log.warn('spawn.bypass-downgraded', {
    note: 'the CLI refused bypassPermissions and fell back to `default`, which in -p mode refuses '
      + 'every edit. The bypass disclaimer has to be accepted once, interactively, in a normal '
      + '`claude` session on this machine. Until then, use the Trusted profile.',
  });
  emit({
    kind: 'idle',
    afterMs: 0,
    reason: 'the CLI refused bypassPermissions (its disclaimer has never been accepted on this '
      + 'machine) and downgraded to `default`, which refuses every edit in headless mode — '
      + 'switch this run to Trusted',
  });
}

/**
 * The deliberate exceptions, named rather than implied.
 *
 * This reverses a safety choice — the whole reason the rewrite existed was that
 * nothing should be able to ask for `bypassPermissions`. It is unlocked only by
 * an operator picking the `bypass` profile, it is journaled where it happens,
 * and the run's own header says so for as long as it is in force. Everything
 * else in `FORBIDDEN` and `FORBIDDEN_WITH_VALUE` stays unconditional: those
 * flags disable the repository's hooks, which is not a preference anyone gets.
 */
export type SanitizeOptions = {
  /** Let `--permission-mode bypassPermissions` through. `bypass` profile only. */
  allowBypass?: boolean;
};

/** What the CLI accepts; anything else is only a warning there, so check here. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan', 'manual'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The tag every operator message carries into the session, and carries back out.
 *
 * Two problems it solves at once. Going in, the CLI's `--replay-user-messages`
 * echo is the only proof a message landed — but the echo used to be recognised
 * by *position* ("the first one is the boot prompt"), which is wrong the moment
 * a session is resumed or restarted on another model and the CLI replays a
 * history rather than one message. A tag is positional-independent: an echo is
 * ours if and only if it carries a tag we are still waiting on.
 *
 * Coming back, the session is asked to repeat the tag at the head of its reply,
 * which is what turns "some text somewhere in the phase's output" into an
 * answer the console can attribute to the question that caused it.
 */
export const OPERATOR_MARK = /\[\[(ask|steer):([0-9a-z]{4,16})\]\]/i;

/** The tag in a piece of text, normalised, or null. */
export function operatorMark(text: string): string | null {
  const found = OPERATOR_MARK.exec(text);
  return found ? `${found[1].toLowerCase()}:${found[2].toLowerCase()}` : null;
}

/** Build the tag for one operator message. */
export function markFor(kind: 'ask' | 'steer', id: string): string {
  return `[[${kind}:${id}]]`;
}

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
  /**
   * A message the operator sent into a running session. Emitted twice for one
   * message and rendered once: the runner emits it undelivered the instant it
   * is written, and this emits it again — same `mark` — when the CLI echoes it
   * back, which is the only evidence it arrived.
   */
  | { kind: 'injected'; text: string; mark?: string; delivered?: boolean }
  /** The session's reply to one of those, recognised by the tag it repeats. */
  | { kind: 'answer'; text: string; mark: string }
  /** stdin was closed by the watchdog rather than by the conversation ending. */
  | { kind: 'idle'; afterMs: number; reason: string }
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
  /**
   * How much this run may do unasked. Only `bypass` changes argv — the other
   * two differ in the ask list inside `--settings`, not out here.
   */
  permissionProfile?: 'guarded' | 'trusted' | 'bypass';
  /** Stream assistant text as it is written rather than per finished block. */
  partialMessages?: boolean;
  /** Forward subagent text, so a phase that delegates is not a silent gap. */
  subagentText?: boolean;
  /** Put hook lifecycle in the stream, so approvals are visible as they fire. */
  hookEvents?: boolean;
  /** Silence after the phase's turn that means wedged rather than working. */
  idleCloseMs?: number;
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
/**
 * How long a session may say nothing at all, after its phase turn has produced
 * a result and with stdin still open, before stdin is closed for it.
 *
 * This is the backstop under the close rule below, and it exists because the
 * close rule depends on evidence the CLI provides — an echo, a result — and a
 * rule that waits for evidence waits forever when the evidence never comes. The
 * failure it catches was real: a phase that had emitted its result and printed
 * its completion report sat blocked on stdin for eighty minutes at 0.1% CPU,
 * with the run showing `running` the whole time.
 *
 * Generous on purpose. After the phase's own turn the only legitimate reason
 * for silence is a long tool call inside a turn the operator started, so this
 * has to outlast a test suite; ten minutes of *total* stream silence is not a
 * session that is working.
 */
const IDLE_CLOSE_MS = 10 * 60 * 1_000;

export function buildArgv(request: SpawnRequest): string[] {
  // Only the `bypass` profile reaches for it, and `sanitize()` is still what
  // decides — passing the string alone gets it rewritten, as it always has.
  const bypass = request.permissionProfile === 'bypass';
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
    '--permission-mode', bypass ? 'bypassPermissions' : (request.permissionMode ?? 'acceptEdits'),
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
  return sanitize(argv, { allowBypass: bypass });
}

/** The one place a forbidden flag can be removed, so it is the only place to audit. */
export function sanitize(argv: string[], opts: SanitizeOptions = {}): string[] {
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
      if (rule.unlockedBy && opts[rule.unlockedBy]) {
        // Loud on purpose: this is the line that hands a session the keys.
        log.warn('spawn.bypass-permitted', {
          flag: arg, value: argv[i + 1], note: 'the operator chose the bypass profile for this run',
        });
        out.push(arg, argv[i + 1]);
        i++;
        continue;
      }
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

  /* ---- the conversation's own state ---- *
   *
   * ## Why none of this is a counter any more
   *
   * It used to be: `outstanding` went up on every operator message and down on
   * every `result`, and stdin closed at zero. That is a subtraction across two
   * streams nobody correlates — the CLI is free to fold two injected messages
   * into one turn, and a client is free to POST the same question twice — so
   * the counter drifts above zero, `closeStdin()` never fires, the child never
   * exits, and the phase reads `running` forever. Measured: a session that had
   * emitted its result and printed a completion report, still alive 80 minutes
   * later blocked on stdin.
   *
   * What replaces it is two things that cannot drift:
   *
   *   `unecho`               the tags of messages written and not yet echoed
   *                          back, keyed by tag rather than counted. A repeat
   *                          of the same message is one entry, and two messages
   *                          folded into one turn both drain, so folding is no
   *                          longer a leak.
   *   `sentSinceLastResult`  a flag, not a tally, and only for an *untagged*
   *                          caller — one whose messages `unecho` cannot track.
   *                          Setting it twice is the same as setting it once.
   *   `turnsSeen`            the CLI's own `num_turns`, which is what tells an
   *                          extra `result` for a turn already counted from a
   *                          genuine new turn. Only a new turn may close stdin,
   *                          so a duplicate cannot close the door on a question
   *                          that has not been answered yet.
   */
  /** The boot-prompt turn has produced its result: the phase's work is done. */
  let phaseTurnDone = false;
  /** An UNTAGGED message written since the previous result. See above. */
  let sentSinceLastResult = false;
  /** Tags of operator messages written but not yet echoed back by the CLI. */
  const unecho = new Set<string>();
  /** The highest turn number any result has reported. */
  let turnsSeen = 0;
  let injected = 0;
  let stdinOpen = true;

  const finish = (outcome: SpawnOutcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };

  if (child.pid) request.onPid?.(child.pid);

  const emit = (event: StreamEvent) => {
    lastEventAt = Date.now();
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
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    try { child.stdin?.end(); } catch { /* already gone */ }
  };

  /* ---- the idle watchdog ---- */

  const idleAfter = request.idleCloseMs ?? IDLE_CLOSE_MS;
  let idleTimer: NodeJS.Timeout | null = null;
  let lastEventAt = Date.now();

  /**
   * Armed only once the phase's own turn has produced a result: before that,
   * silence is a session thinking, and cutting it off would be the bug rather
   * than the fix.
   *
   * It measures *silence*, not elapsed time, but it is not re-armed per event —
   * a streaming session emits thousands of deltas and rescheduling a timer on
   * each is real work for nothing. Instead every event stamps `lastEventAt` and
   * the timer, on waking, either fires or sleeps out the remainder.
   */
  const armIdle = (delay = idleAfter): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!phaseTurnDone || !stdinOpen || settled || idleAfter <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!stdinOpen || settled) return;
      const quiet = Date.now() - lastEventAt;
      if (quiet < idleAfter) { armIdle(idleAfter - quiet); return; }
      const reason = unecho.size
        ? `${unecho.size} operator message(s) were never echoed back`
        : 'the session stopped streaming with stdin still open';
      log.warn('spawn.idle-close', { afterMs: quiet, reason, pid: child.pid });
      emit({ kind: 'idle', afterMs: quiet, reason });
      closeStdin();
    }, Math.max(1, delay));
    idleTimer.unref?.();
  };

  // The boot prompt, as the session's first turn. Deliberately not marked as
  // "sent": it IS the phase turn, and `phaseTurnDone` is what tracks that.
  write(request.prompt);

  request.onHandle?.({
    pid: child.pid ?? undefined,
    open: () => stdinOpen && !settled,
    send: (text: string) => {
      if (!text.trim()) return false;
      if (!write(text)) return false;
      // Untagged callers still work — they simply get no delivery confirmation
      // and no attributed answer, which is the old behaviour rather than a new
      // failure. Everything the console sends is tagged.
      const mark = operatorMark(text);
      if (mark) unecho.add(mark);
      else sentSinceLastResult = true;
      injected++;
      armIdle();
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
          // The reply to an operator's question repeats the question's tag, and
          // that is the only thing separating it from the phase's own words.
          // Without it the answer lands in the middle of a wall of build output
          // and the operator never sees that anything replied at all.
          const answering = !parent ? operatorMark(item.text.slice(0, 400)) : null;
          if (answering) emit({ kind: 'answer', text: stripMark(item.text), mark: answering });
          else if (parent) emit({ kind: 'subagent', text: item.text, parent });
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
      // An echo is ours if and only if it carries a tag we are still waiting
      // on. This used to be positional — "the first echo is the boot prompt" —
      // which is right exactly once: a session started with `--resume`, or
      // restarted on another model, replays a history and every count is off by
      // however long that history was. The boot prompt and any replayed turn
      // carry no pending tag, so both are correctly ignored here.
      const mark = text ? operatorMark(text) : null;
      if (!mark || !unecho.delete(mark)) return;
      emit({ kind: 'injected', text: stripMark(text!), mark, delivered: true });
      return;
    }

    if (type === 'result') {
      flushPartials();
      subtype = sub;
      // `total_cost_usd` is the running total for the whole session, not this
      // turn's share — so the last one wins and they are never summed.
      if (typeof message.total_cost_usd === 'number') costUsd = message.total_cost_usd;
      // A result that reports a turn number already seen is a duplicate, not a
      // turn boundary — and telling those apart is the CLI's job, not ours.
      const reported = typeof message.num_turns === 'number' ? message.num_turns : null;
      const newTurn = reported === null || reported > turnsSeen;
      if (reported !== null) turnsSeen = Math.max(turnsSeen, reported);
      if (reported !== null) turns = Math.max(turns, reported);
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
      // has done its work; any after that answer an operator's message.
      //
      // The close rule, stated once: stdin closes on a result that ends a NEW
      // turn, when every message written has been echoed back. Reading it as
      // two questions rather than one subtraction makes both failure modes fall
      // out —
      //
      //   two messages folded into ONE turn: both drain from `unecho` as they
      //   are echoed, so the single result that follows closes (the counter
      //   needed a result each, and waited forever for the second — this is the
      //   wedge that left a finished phase reading `running` for 80 minutes);
      //
      //   an EXTRA result beyond the session's own turns: it is not a new turn,
      //   so it is not a close decision at all (the counter would have
      //   decremented to zero and closed the door on an unanswered question).
      if (!newTurn) { armIdle(); return; }
      phaseTurnDone = true;
      const wroteUntagged = sentSinceLastResult;
      sentSinceLastResult = false;
      if (!wroteUntagged && !unecho.size) closeStdin();
      else armIdle();
    }
  };

  const stdoutLines = lineReader(handleLine);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdoutLines.push(chunk));
  child.stdout?.on('error', (error) => log.warn('spawn.stdout', { error }));

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-KEEP_STDERR);
    if (BYPASS_DOWNGRADED.test(chunk)) noteBypassDowngrade(emit);
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
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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

/** The tag is plumbing; it belongs in the correlation, not on the screen. */
export function stripMark(text: string): string {
  return text.replace(OPERATOR_MARK, '').replace(/^\s+/, '');
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
