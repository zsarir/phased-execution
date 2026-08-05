/**
 * The wire protocol between the runner and a session.
 *
 * Every other test fakes `spawnClaude` away, which is right for testing the
 * loop and useless for testing the thing the loop stands on. The parts most
 * able to break are exactly the parts a fake hides: whether the boot prompt
 * reaches the child at all, whether a flag we think we pass is in argv,
 * whether an injected message becomes a turn, whether the process ever exits.
 *
 * So this runs the real `spawnClaude` against a stub `claude` on a temporary
 * PATH that speaks the same NDJSON both directions. The stub's behaviour is
 * copied from a real session observed at CLI v2.1.220 — one `result` per turn,
 * a cumulative `total_cost_usd`, `--replay-user-messages` echoing our own
 * messages back, `stream_event` deltas carrying `parent_tool_use_id`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { spawnClaude, markFor } = await import('../server/runner/spawn.ts');
import type { SpawnHandle, StreamEvent } from '../server/runner/spawn.ts';

/* ------------------------------------------------------------------ *
 * A `claude` that is not claude
 * ------------------------------------------------------------------ */

const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (process.env.PC_STUB_ARGV) fs.writeFileSync(process.env.PC_STUB_ARGV, JSON.stringify(argv));

const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';

// Turns whose result is withheld, so the NEXT turn's result covers both — this
// is the CLI folding two injected messages into one turn, which is what the old
// counter could not survive.
const noResult = new Set((process.env.PC_STUB_NO_RESULT || '').split(',').filter(Boolean).map(Number));
// A history replayed on --resume: user echoes for turns that are not ours.
const replayHistory = Number(process.env.PC_STUB_REPLAY_HISTORY || 0);
// A duplicate result for a turn already reported, which the CLI has been seen
// to emit and which used to decrement the counter a second time.
const extraResult = new Set((process.env.PC_STUB_EXTRA_RESULT || '').split(',').filter(Boolean).map(Number));
// Answer an operator message by repeating its tag, as the frame asks.
const answering = process.env.PC_STUB_ANSWER === '1';
// Say nothing at all after the boot turn: never echo, never result.
const goSilent = process.env.PC_STUB_SILENT === '1';
// The tool traffic a real session makes: a call and its result, a task list,
// and a Task whose subagent makes a call of its own and fails it.
const tools = process.env.PC_STUB_TOOLS === '1';
const tag = (text) => (/\\[\\[(ask|steer):[0-9a-z]{4,16}\\]\\]/i.exec(text) || [])[0];

say({ type: 'system', subtype: 'init', session_id: sid, model: process.env.PC_STUB_MODEL || 'stub-1', tools: [] });
for (let i = 0; i < replayHistory; i++) {
  say({ type: 'user', session_id: sid,
        message: { role: 'user', content: [{ type: 'text', text: 'replayed history ' + i }] } });
}

let buffer = '';
let turn = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const text = (message.message && message.message.content || []).map((b) => b.text).join('');
    turn += 1;
    if (process.env.PC_STUB_HEARD) fs.appendFileSync(process.env.PC_STUB_HEARD, text + '\\n');
    if (goSilent && turn > 1) continue;

    if (argv.includes('--replay-user-messages')) {
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text }] } });
    }
    if (argv.includes('--include-partial-messages')) {
      for (const piece of ['answer ', 'in ', 'pieces']) {
        say({ type: 'stream_event', session_id: sid, parent_tool_use_id: null,
              event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
      }
      say({ type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_sub',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from a subagent' } } });
    }
    if (tools && turn === 1) {
      say({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test -- --run' } },
        { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [
          { content: 'wire the endpoint', status: 'completed', activeForm: 'Wiring the endpoint' },
          { content: 'add the test', status: 'in_progress', activeForm: 'Adding the test' },
        ] } },
        { type: 'tool_use', id: 'toolu_task', name: 'Task',
          input: { subagent_type: 'Explore', description: 'map the callers' } },
        // The CLI's own name for the same tool, and with no type stated —
        // which is legal, and still a delegation.
        { type: 'tool_use', id: 'toolu_agent', name: 'Agent',
          input: { description: 'count the widgets' } },
        // What the CLI ACTUALLY calls for a task list — one row per call, with
        // the id coming back in the result rather than going out in the input.
        { type: 'tool_use', id: 'toolu_new', name: 'TaskCreate',
          input: { subject: 'wire the endpoint', description: 'the long brief', activeForm: 'Wiring it' } },
        { type: 'tool_use', id: 'toolu_upd', name: 'TaskUpdate',
          input: { taskId: '1', status: 'in_progress' } },
      ] } });
      // Results come back as USER messages, which is why they were being
      // dropped: the old handler joined \`.text\` and a tool_result has none.
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_bash', is_error: false,
          content: [{ type: 'text', text: '40 tests passed' }] },
      ] } });
      // The subagent's own call, parented — and failing.
      say({ type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_task',
            message: { role: 'assistant', content: [
              { type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: { pattern: 'createOrder' } },
            ] } });
      say({ type: 'user', session_id: sid, parent_tool_use_id: 'toolu_task',
            message: { role: 'user', content: [
              { type: 'tool_result', tool_use_id: 'toolu_inner', is_error: true, content: 'no matches' },
            ] } });
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_task', is_error: false, content: 'found 3 callers' },
      ] } });
    }
    const mark = answering ? tag(text) : undefined;
    say({ type: 'assistant', session_id: sid,
          message: { role: 'assistant', stop_reason: 'end_turn',
                     content: [{ type: 'text', text: mark ? mark + ' yes, because the cache was cold' : 'turn ' + turn }] } });
    if (noResult.has(turn)) continue;
    // total_cost_usd is the SESSION total, not this turn's share.
    say({ type: 'result', subtype: 'success', session_id: sid, num_turns: turn,
          total_cost_usd: turn, is_error: false, result: 'done ' + turn });
    if (extraResult.has(turn)) {
      // Same num_turns: a duplicate, not a new turn.
      say({ type: 'result', subtype: 'success', session_id: sid, num_turns: turn,
            total_cost_usd: turn, is_error: false, result: 'done ' + turn + ' (again)' });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

type Bench = {
  dir: string;
  env: NodeJS.ProcessEnv;
  argvFile: string;
  heardFile: string;
  argv: () => string[];
  heard: () => string[];
  cleanup: () => void;
};

function bench(): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'pc-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, STUB, 'utf8');
  chmodSync(bin, 0o755);
  const argvFile = join(dir, 'argv.json');
  const heardFile = join(dir, 'heard.txt');
  return {
    dir,
    argvFile,
    heardFile,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PC_STUB_ARGV: argvFile,
      PC_STUB_HEARD: heardFile,
    },
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[],
    heard: () => (existsSync(heardFile) ? readFileSync(heardFile, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

test('the boot prompt reaches the session on stdin, and never as argv', async () => {
  const b = bench();
  const outcome = await spawnClaude({ prompt: 'BOOT phase 3', cwd: b.dir, env: b.env });

  assert.deepEqual(b.heard(), ['BOOT phase 3'], 'the session was told what to do');
  // In streaming-input mode the CLI ignores a positional prompt entirely, so a
  // prompt passed there would look right on screen and run nothing at all.
  assert.ok(!b.argv().includes('BOOT phase 3'), 'the prompt is not in argv');
  assert.equal(outcome.signal.subtype, 'success');
  assert.equal(outcome.sessionId, '11111111-2222-3333-4444-555555555555');
  b.cleanup();
});

test('the session ends by itself once its turn is answered', async () => {
  const b = bench();
  // Nothing kills this child: stdin closes when the last turn is answered and
  // the process exits on its own. If that logic is wrong the test hangs, which
  // is exactly the failure it needs to catch.
  const outcome = await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env });
  assert.equal(outcome.turns, 1);
  assert.ok(outcome.durationMs >= 0);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * The flags we believe we are passing
 * ------------------------------------------------------------------ */

test('effort, model, fallback chain and name all reach the child', async () => {
  const b = bench();
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: b.env,
    model: 'fable',
    effort: 'max',
    fallbackModels: ['opus', 'sonnet'],
    name: 'demo p1',
  });
  const argv = b.argv();
  assert.equal(argv[argv.indexOf('--model') + 1], 'fable');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'max');
  assert.equal(argv[argv.indexOf('--fallback-model') + 1], 'opus,sonnet');
  assert.equal(argv[argv.indexOf('--name') + 1], 'demo p1');
  b.cleanup();
});

test('an effort the CLI would only warn about never leaves this process', async () => {
  const b = bench();
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, effort: 'ludicrous' });
  assert.ok(!b.argv().includes('--effort'));
  b.cleanup();
});

test('a caller cannot smuggle the guard rails off through the tool list', async () => {
  const b = bench();
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: b.env,
    permissionMode: 'bypassPermissions' as never,
  });
  const argv = b.argv();
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * Talking to a session that is already running
 * ------------------------------------------------------------------ */

/** A tagged operator message, exactly as the runner frames one. */
function tagged(id: string, body: string): string {
  return `${markFor('ask', id)} An out-of-band question from the operator. Question: ${body}`;
}

test('an injected message becomes a second turn in the same session', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    env: b.env,
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      // Ask the moment the phase's own turn lands. The send has to be seen
      // BEFORE stdin is closed, which is why the result event is emitted
      // before the close decision is taken — load-bearing ordering.
      if (event.kind === 'result' && !asked) {
        asked = true;
        assert.equal(handle!.send(tagged('aaaa1111', 'by the way, why?')), true);
      }
    },
  });

  assert.equal(b.heard().length, 2);
  assert.equal(outcome.injected, 1);
  assert.equal(outcome.turns, 2, 'the question was a turn of its own');
  // Cumulative, not summed: the stub reports 1 then 2, and the session cost 2.
  assert.equal(outcome.costUsd, 2, 'per-turn totals must not be added together');

  const injected = events.filter((e) => e.kind === 'injected') as { mark?: string; delivered?: boolean }[];
  assert.equal(injected.length, 1, 'the echo is the only proof it landed');
  assert.equal(injected[0].mark, 'ask:aaaa1111', 'and it is attributable to the message that caused it');
  assert.equal(injected[0].delivered, true);
  b.cleanup();
});

test('the boot prompt is not echoed back as if the operator had said it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.kind === 'injected').length, 0);
  b.cleanup();
});

test('a replayed history is not mistaken for messages the operator just sent', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  // A session started with `--resume` replays its history as `user` messages.
  // The old rule was positional — "the first echo is the boot prompt" — so
  // every replayed turn after it was shown as something the operator had
  // supposedly just typed, and the count was wrong from then on.
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_REPLAY_HISTORY: '3' },
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.kind === 'injected').length, 0);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * When stdin closes — the wedge, and the two ways of causing it
 * ------------------------------------------------------------------ */

test('two messages folded into one turn still let the session end', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  let asked = false;

  // The measured wedge. `outstanding` went up twice and down once — the CLI
  // answered both messages in a single turn — so it never reached zero, stdin
  // never closed, and the child sat blocked on it at 0.1% CPU with the phase
  // still reading `running` 80 minutes later. If this regresses, this test does
  // not fail: it hangs, which is the honest shape of the bug.
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_NO_RESULT: '2' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      if (event.kind !== 'result' || asked) return;
      asked = true;
      assert.equal(handle!.send(tagged('bbbb2222', 'first question')), true);
      assert.equal(handle!.send(tagged('cccc3333', 'second question')), true);
    },
  });

  assert.equal(outcome.injected, 2, 'both were written');
  assert.equal(b.heard().length, 3, 'and both reached the session, after the boot prompt');
  // Two questions, three turns, two results. The session ended anyway.
  assert.equal(outcome.turns, 3);
  b.cleanup();
});

test('an extra result for a turn already counted does not close stdin early', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  let asked = false;
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    // A duplicate result for turn 1, reporting the same `num_turns`. The
    // counter treated it as an answer and decremented to zero, closing stdin
    // with a question still in flight.
    env: { ...b.env, PC_STUB_EXTRA_RESULT: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      if (event.kind !== 'result' || asked) return;
      asked = true;
      assert.equal(handle!.send(tagged('dddd4444', 'still there?')), true);
    },
  });

  assert.equal(b.heard().length, 2, 'the question was written');
  assert.equal(outcome.turns, 2, 'and got a turn of its own rather than a closed pipe');
  b.cleanup();
});

test('a session that goes silent with stdin open is closed by the watchdog', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    // Never echoes and never results after the boot turn, so nothing the close
    // rule waits for will ever arrive. Without the watchdog this hangs.
    env: { ...b.env, PC_STUB_SILENT: '1' },
    idleCloseMs: 250,
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      if (event.kind !== 'result' || asked) return;
      asked = true;
      handle!.send(tagged('eeee5555', 'anyone home?'));
    },
  });

  const idle = events.filter((e) => e.kind === 'idle') as { reason: string; afterMs: number }[];
  assert.equal(idle.length, 1, 'the close is announced, not silent');
  assert.match(idle[0].reason, /never echoed back/, 'and says which evidence never came');
  assert.ok(idle[0].afterMs >= 200);
  assert.ok(outcome.durationMs >= 200);
  b.cleanup();
});

test('the session answers a tagged question, and the answer is attributed', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_ANSWER: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      if (event.kind !== 'result' || asked) return;
      asked = true;
      handle!.send(tagged('ffff6666', 'why was it cold?'));
    },
  });

  const answers = events.filter((e) => e.kind === 'answer') as { text: string; mark: string }[];
  assert.equal(answers.length, 1, 'the reply is not lost in the phase\'s own output');
  assert.equal(answers[0].mark, 'ask:ffff6666');
  // The tag is plumbing. It belongs in the correlation, not on the screen.
  assert.equal(answers[0].text, 'yes, because the cache was cold');
  b.cleanup();
});

test('a message sent after the session has finished is refused, not lost', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onHandle: (h) => { handle = h; } });

  assert.equal(handle!.open(), false, 'the session is gone and says so');
  assert.equal(handle!.send('too late'), false, 'refusing beats accepting into a void');
  assert.deepEqual(b.heard(), ['BOOT phase 1']);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * What the console gets to show
 * ------------------------------------------------------------------ */

test('streamed deltas are coalesced, and a subagent keeps its own voice', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: b.env,
    partialMessages: true,
    onEvent: (event) => events.push(event),
  });

  const partial = events.filter((e) => e.kind === 'partial') as { text: string }[];
  assert.ok(partial.length >= 1, 'the words arrived as they were written');
  assert.equal(partial.map((p) => p.text).join(''), 'answer in pieces');
  assert.ok(partial.length < 3, 'and were gathered rather than sent one frame per token');

  const sub = events.filter((e) => e.kind === 'subagent') as { text: string; parent: string }[];
  assert.equal(sub.length, 1, 'a subagent is not interleaved into the phase text');
  assert.equal(sub[0].parent, 'toolu_sub');
  b.cleanup();
});

test('a tool call and its result are joined by id, and timed', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const call = events.find((e) => e.kind === 'tool' && e.id === 'toolu_bash') as
    { name: string; summary: string; id: string } | undefined;
  assert.ok(call, 'the tool_use id is captured — without it nothing can be correlated');
  assert.equal(call.name, 'Bash');
  assert.equal(call.summary, 'npm test -- --run');

  const result = events.find((e) => e.kind === 'tool-result' && e.id === 'toolu_bash') as
    { ok: boolean; ms?: number; detail?: string } | undefined;
  assert.ok(result, 'the result was dropped entirely before this');
  assert.equal(result.ok, true);
  assert.equal(typeof result.ms, 'number', 'a call with no duration is a name and nothing else');
  assert.ok(result.ms! >= 0);
  assert.match(result.detail ?? '', /40 tests passed/);
  b.cleanup();
});

test('a Task names the agent it hands to, and its subagent\'s failures stay its own', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const task = events.find((e) => e.kind === 'tool' && e.id === 'toolu_task') as
    { agent?: string; delegates?: boolean; summary: string } | undefined;
  assert.equal(task?.agent, 'Explore', '"agent" as a label says nothing when three are running');
  assert.equal(task?.delegates, true);
  assert.equal(task?.summary, 'map the callers');

  // Measured, not assumed: the current CLI calls this `Agent`, and matching
  // only `Task` is silent — the subagent's words still arrive carrying a
  // parent, so the lane simply never opens and nothing says why.
  const agentCall = events.find((e) => e.kind === 'tool' && e.id === 'toolu_agent') as
    { agent?: string; delegates?: boolean } | undefined;
  assert.equal(agentCall?.delegates, true, 'a delegation under the CLI\'s own name for it');
  assert.equal(agentCall?.agent, undefined, 'and `subagent_type` is optional, so it may be unnamed');

  // A subagent's own calls used to be invisible: the whole `user` branch was
  // skipped whenever `parent_tool_use_id` was set.
  const inner = events.find((e) => e.kind === 'tool-result' && e.id === 'toolu_inner') as
    { ok: boolean; parent?: string; detail?: string } | undefined;
  assert.ok(inner, 'the subagent\'s result reached the console');
  assert.equal(inner.ok, false);
  assert.equal(inner.parent, 'toolu_task', 'attributed to the agent, not to the phase');
  assert.match(inner.detail ?? '', /no matches/);
  b.cleanup();
});

test('a TodoWrite surfaces the whole list, not a sentence about it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const todos = events.find((e) => e.kind === 'todos') as
    { items: { content: string; status: string; activeForm?: string }[] } | undefined;
  assert.ok(todos, 'the array was being discarded one function call before it was kept');
  assert.equal(todos.items.length, 2);
  assert.deepEqual(todos.items.map((t) => t.status), ['completed', 'in_progress']);
  assert.equal(todos.items[1].activeForm, 'Adding the test');

  // And the console line for the same call says something rather than nothing.
  const line = events.find((e) => e.kind === 'tool' && e.id === 'toolu_todo') as { summary: string };
  assert.match(line.summary, /1\/2 done · Adding the test/);
  b.cleanup();
});

test('the task list the CLI really keeps — one row per call — reaches the client', async () => {
  // The plan for this phase said the list arrives as `TodoWrite`'s array. It
  // does not: a real run emits `TaskCreate` and `TaskUpdate`, one task at a
  // time. Both spellings are carried, because only one of them ever fires.
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const created = events.find((e) => e.kind === 'task' && e.op === 'create') as
    { call?: string; content?: string; activeForm?: string } | undefined;
  assert.equal(created?.content, 'wire the endpoint', 'the title, not the brief');
  assert.equal(created?.activeForm, 'Wiring it');
  assert.equal(created?.call, 'toolu_new', 'carries its own call id, so its result can name it');

  const updated = events.find((e) => e.kind === 'task' && e.op === 'update') as
    { taskId?: string; status?: string } | undefined;
  assert.deepEqual([updated?.taskId, updated?.status], ['1', 'in_progress']);

  // A TaskUpdate's input has no summarisable key at all, so its console line
  // used to be the bare word "TaskUpdate".
  const line = events.find((e) => e.kind === 'tool' && e.id === 'toolu_upd') as { summary: string };
  assert.equal(line.summary, '#1 → in_progress');
  b.cleanup();
});

test('tool results do not disturb the close rule or the operator echo', async () => {
  // Both live in the same `user` branch now. If a result were mistaken for an
  // echo the phase would wedge, which is the bug this whole protocol exists to
  // have stopped — so it is worth asserting rather than assuming.
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let sent = false;
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      // Send amid turn 1's tool traffic — after a tool event, before the
      // turn's result — which is the situation under test. This was a 60ms
      // wall-clock delay once, and a fast machine finished the whole stub
      // session inside it: a send after exit is a send to nobody.
      if (event.kind === 'tool' && !sent) {
        sent = true;
        handle!.send(tagged('bbbb2222', 'and this?'));
      }
    },
  });

  const injected = events.filter((e) => e.kind === 'injected') as { mark?: string; delivered?: boolean }[];
  assert.equal(injected.length, 1, 'the operator message was still recognised');
  assert.equal(injected[0].delivered, true);
  assert.equal(outcome.turns, 2, 'and the session ended by itself, both turns answered');
  b.cleanup();
});

test('a missing claude is reported as a missing claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-nostub-'));
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1', cwd: dir,
    env: { ...process.env, PATH: dir },
  });
  assert.match(outcome.resultText, /not on PATH/);
  assert.equal(outcome.costUsd, 0, 'a session that never started spent nothing');
  rmSync(dir, { recursive: true, force: true });
});
