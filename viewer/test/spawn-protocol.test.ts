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

const { spawnClaude } = await import('../server/runner/spawn.ts');
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
say({ type: 'system', subtype: 'init', session_id: sid, model: process.env.PC_STUB_MODEL || 'stub-1', tools: [] });

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
    say({ type: 'assistant', session_id: sid,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'turn ' + turn }] } });
    // total_cost_usd is the SESSION total, not this turn's share.
    say({ type: 'result', subtype: 'success', session_id: sid, num_turns: turn,
          total_cost_usd: turn, is_error: false, result: 'done ' + turn });
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
        assert.equal(handle!.send('by the way, why?'), true);
      }
    },
  });

  assert.deepEqual(b.heard(), ['BOOT phase 2', 'by the way, why?']);
  assert.equal(outcome.injected, 1);
  assert.equal(outcome.turns, 2, 'the question was a turn of its own');
  // Cumulative, not summed: the stub reports 1 then 2, and the session cost 2.
  assert.equal(outcome.costUsd, 2, 'per-turn totals must not be added together');

  const injected = events.filter((e) => e.kind === 'injected');
  assert.equal(injected.length, 1, 'the echo is the only proof it landed');
  assert.equal((injected[0] as { text: string }).text, 'by the way, why?');
  b.cleanup();
});

test('the boot prompt is not echoed back as if the operator had said it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.kind === 'injected').length, 0);
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
