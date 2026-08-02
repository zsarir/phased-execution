/**
 * One phase, one `claude -p` process.
 *
 * This is where "clear the session between phases" is implemented, and the
 * implementation is that there is nothing to implement: the process exits, and
 * with it the context. There is no `/clear` to send and no session to reset —
 * each phase starts from a boot prompt and the files on disk, which is exactly
 * the contract `phased-execution` already assumes.
 *
 * Two flags are never passed, whatever the caller asks for:
 *
 *   --bare                         skips settings, and with them the repo's
 *                                  PreToolUse hooks — including the destructive
 *                                  -operation guard this monorepo relies on.
 *   --dangerously-skip-permissions everything, unreviewed.
 *
 * They are stripped in one place, `sanitize()`, so no future caller can
 * reintroduce them by passing extra arguments.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { log } from '../log.ts';
import { childEnv, type StopSignal } from './errors.ts';

/** Anything that would take the guard rails off, regardless of who asked. */
const FORBIDDEN = [
  '--bare',
  '--dangerously-skip-permissions',
  '--dangerously-allow-browser-tool-in-non-sandboxed-mode',
];

export type StreamEvent =
  | { kind: 'init'; sessionId: string; model?: string; tools?: number }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'retry'; category?: string; attempt?: number; detail?: string }
  | { kind: 'result'; subtype?: string; costUsd?: number; turns?: number; isError?: boolean }
  | { kind: 'stderr'; text: string };

export type SpawnRequest = {
  prompt: string;
  cwd: string;
  model?: string;
  /** Fixed id so a deferred approval or a cap raise can resume this exact session. */
  sessionId?: string;
  /** Continue an existing session instead of starting one. */
  resume?: string;
  budgetUsd?: number | null;
  maxTurns?: number | null;
  fallbackModel?: string;
  /** JSON passed to `--settings`: the per-run hook and its ask-rules (W3). */
  settings?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Told the pid as soon as there is one, so a checkpoint can record it. */
  onPid?: (pid: number) => void;
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
};

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;

/** argv is bounded by the OS; a boot prompt is kilobytes, so this is a sanity bound. */
const MAX_PROMPT_BYTES = 512 * 1024;
/** Keep the last of stderr for classification — not a whole build log. */
const KEEP_STDERR = 16_000;
/** A single NDJSON line past this is a runaway, not a message. */
const MAX_LINE = 8 * 1024 * 1024;

export function buildArgv(request: SpawnRequest): string[] {
  const argv = [
    '-p', request.prompt,
    '--output-format', 'stream-json',
    // stream-json in print mode requires it; it is also what makes tool calls
    // visible to the console instead of only the final answer.
    '--verbose',
    '--permission-mode', request.permissionMode ?? 'acceptEdits',
  ];
  if (request.resume) argv.push('--resume', request.resume);
  else argv.push('--session-id', request.sessionId ?? randomUUID());
  if (request.model) argv.push('--model', request.model);
  if (request.fallbackModel) argv.push('--fallback-model', request.fallbackModel);
  if (request.budgetUsd && request.budgetUsd > 0) argv.push('--max-budget-usd', String(request.budgetUsd));
  if (request.maxTurns && request.maxTurns > 0) argv.push('--max-turns', String(request.maxTurns));
  if (request.settings) argv.push('--settings', request.settings);
  return sanitize(argv);
}

/** The one place a forbidden flag can be removed, so it is the only place to audit. */
export function sanitize(argv: string[]): string[] {
  return argv.filter((arg) => {
    if (!FORBIDDEN.includes(arg)) return true;
    log.warn('spawn.refused-flag', { flag: arg });
    return false;
  });
}

export const spawnClaude: SpawnFn = (request) => new Promise<SpawnOutcome>((resolve) => {
  const started = Date.now();
  if (Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES) {
    resolve(fail(`the boot prompt is over ${MAX_PROMPT_BYTES / 1024}KB — the plan is malformed`, started, []));
    return;
  }

  const argv = buildArgv(request);
  // The prompt is argv[1] and can be thousands of lines; the journal wants the
  // shape of the invocation, not a second copy of the prompt.
  const shown = argv.map((a, i) => (i === 1 ? `<prompt ${Buffer.byteLength(a)}B>` : a));

  const child = spawn('claude', argv, {
    cwd: request.cwd,
    env: childEnv(request.env),
    stdio: ['ignore', 'pipe', 'pipe'],
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

  const finish = (outcome: SpawnOutcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };

  if (child.pid) request.onPid?.(child.pid);

  const onAbort = () => {
    // SIGTERM so the session's own SessionEnd hooks still run; the runner
    // escalates to SIGKILL if it has to.
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  const emit = (event: StreamEvent) => {
    try { request.onEvent?.(event); } catch { /* a listener must not kill the run */ }
  };

  const handleLine = (line: string) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    const id = message.session_id;
    if (typeof id === 'string' && id) sessionId = id;

    const type = message.type;
    const sub = typeof message.subtype === 'string' ? message.subtype : undefined;

    if (type === 'system' && sub === 'init') {
      emit({
        kind: 'init',
        sessionId: sessionId ?? '',
        model: typeof message.model === 'string' ? message.model : undefined,
        tools: Array.isArray(message.tools) ? message.tools.length : undefined,
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

    if (type === 'assistant') {
      const content = (message.message as { content?: unknown[]; stop_reason?: string } | undefined);
      if (content?.stop_reason) stopReason = content.stop_reason;
      for (const block of content?.content ?? []) {
        const item = block as { type?: string; text?: string; name?: string; input?: unknown };
        if (item.type === 'text' && item.text) emit({ kind: 'text', text: item.text });
        if (item.type === 'tool_use' && item.name) {
          emit({ kind: 'tool', name: item.name, summary: summarise(item.input) });
        }
      }
      return;
    }

    if (type === 'result') {
      subtype = sub;
      if (typeof message.total_cost_usd === 'number') costUsd = message.total_cost_usd;
      if (typeof message.num_turns === 'number') turns = message.num_turns;
      const text = message.result ?? message.error;
      if (typeof text === 'string') resultText = text;
      emit({
        kind: 'result',
        subtype,
        costUsd,
        turns,
        isError: message.is_error === true,
      });
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
    const reason = error.code === 'ENOENT'
      ? 'the `claude` CLI is not on PATH for this process'
      : `could not start claude: ${error.message}`;
    finish(fail(reason, started, shown));
  });

  child.on('close', (code, sig) => {
    request.signal?.removeEventListener('abort', onAbort);
    stdoutLines.flush();

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
