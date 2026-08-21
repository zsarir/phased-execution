/**
 * What a phase does when one of its MCP servers will not connect.
 *
 * The default used to be "park at boarding, unconditionally", and the reasoning
 * was sound in isolation: an unattended `-p` session cannot sign a server in, so
 * discovering the wall an hour into a phase costs an hour. What that reasoning
 * missed is what happens to the RUN. `parked` is a settled status, so a run
 * whose ready phases all park has no candidates left and halts — and a real
 * eleven-phase plan that named no MCP servers at all was stopped dead, 0 phases
 * done, because three servers an operator had ticked in the launch dialog turned
 * out to be signed out. The park was answering for the phase that genuinely
 * cannot proceed and firing for every phase that merely had one attached.
 *
 * So the shipped default is now `continue`: board without what cannot be
 * reached, tell the session exactly which and what to do about it, tell the
 * operator once. `require` keeps the old behaviour for the phase that means it.
 *
 * Most of what is pinned here is the resolution ORDER, because that is the part
 * with a deliberate reversal in it: the plan outranks the run, which is the
 * opposite of how `model` and `effort` resolve, and a future edit that
 * "consistently" flips it back would silently let an operator's blanket
 * carry-on overrule a phase whose plan says it cannot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-mcppolicy-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
// The config guard too: the registry read at import was reaching the
// operator's REAL ~/.config/phase-console before the belt existed.
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { runDir } = await import('../server/runner/state.ts');
import type { McpPolicy } from '../server/runner/state.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

/** Where this run's checkpoints land — keyed by root, like the real thing. */
const runsDir = (root: string): string => runDir(root, 'demo');

type Repo = { root: string; scripts: string; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A one-phase board with a stub engine, as `default-skills.test.ts` builds it. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-mcppolicy-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"
    echo "ready: \${r%,}"
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');

  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function outcome(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/**
 * A registry where `gh` needs signing in, `fs` will not connect and `ctx7` is
 * fine — the exact shape of the run that motivated this.
 */
function mcpDep(configFiles: string[][] = []) {
  return {
    preflight: async (ids: string[]) => {
      const blocking = [
        ...(ids.includes('gh') ? [{ id: 'gh', status: 'needs-auth' }] : []),
        ...(ids.includes('fs')
          ? [{ id: 'fs', status: 'failed', error: { message: 'MCP_FS_ROOT is not set' } }]
          : []),
      ];
      return {
        ok: blocking.length === 0,
        blocking,
        unknown: ids.filter((id) => !['gh', 'fs', 'ctx7'].includes(id)),
        disabled: [],
      };
    },
    configFor: async (_runId: string, ids: string[]) => {
      configFiles.push([...ids]);
      return ids.length ? '/tmp/mcp-config.json' : null;
    },
  };
}

type DriveOptions = {
  mcpServers?: string[];
  mcpPolicy?: McpPolicy;
  phaseOptions?: Record<string, unknown>;
  planMcpPolicy?: McpPolicy;
  planMcp?: string[];
};

/**
 * Drive one phase and report what the session was told, what it was given, and
 * where the run ended up.
 *
 * The prompt and the argv are the only honest places to assert this: the whole
 * feature exists to decide what a child is handed, and a unit test of the
 * resolver would pass with the call site deleted.
 */
async function drive(r: Repo, options: DriveOptions = {}) {
  const prompts: string[] = [];
  const requests: SpawnRequest[] = [];
  const configFiles: string[][] = [];
  const degraded: { phase: number; ids: string[] }[] = [];
  const done = join(r.root, '.stub', 'done');

  const spawn: SpawnFn = async (request: SpawnRequest) => {
    prompts.push(request.prompt);
    requests.push(request);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) writeFileSync(done, `${phase}\n`, { flag: 'a' });
    return outcome();
  };

  const runner = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    mcp: mcpDep(configFiles),
    planMcp: () => options.planMcp ?? [],
    planMcpPolicy: () => options.planMcpPolicy,
    onMcpDegraded: (_state, phase, rows) => {
      degraded.push({ phase, ids: rows.map((row) => row.id) });
    },
  } as never);

  await runner.start({
    slug: 'demo',
    root: r.root,
    onlyPhases: [1],
    mcpServers: options.mcpServers,
    mcpPolicy: options.mcpPolicy,
    phaseOptions: options.phaseOptions,
  } as Parameters<typeof runner.start>[0]);
  await runner.wait();

  const state = runner.current()!;
  return { prompts, requests, configFiles, degraded, state, ran: prompts.length > 0 };
}

/* ------------------------------------------------------------------ *
 * The default: the plan keeps going
 * ------------------------------------------------------------------ */

test('a phase whose servers are signed out still runs, and is told which are missing', async () => {
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7', 'gh', 'fs'] });
    assert.ok(out.ran, 'the phase boarded — this is the whole point of the release');
    assert.equal(out.state.phases['1'].status, 'done');
    assert.equal(out.state.halt, null, 'and nothing halted the run');

    const prompt = out.prompts[0];
    assert.match(prompt, /UNAVAILABLE/, 'the session is told, in words it cannot miss');
    assert.match(prompt, /`gh`/);
    assert.match(prompt, /MCP_FS_ROOT is not set/, 'with the real reason, not "will not connect"');
    assert.match(prompt, /do NOT improvise a substitute/i);
    assert.match(prompt, /Outstanding/, 'and told where the errand goes');
  } finally {
    r.cleanup();
  }
});

test('only the reachable servers are attached, and the missing ones are not', async () => {
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7', 'gh', 'fs'] });
    assert.deepEqual(out.configFiles.at(-1), ['ctx7'], 'the config holds what actually connects');
    // And the first half of the directive must not claim a dropped server was
    // "verified connected before it started", which is what it says.
    const attachedLine = /attached to this session[\s\S]*?verified connected[^.]*\./.exec(out.prompts[0]);
    assert.ok(attachedLine, 'the attached sentence is still there');
    assert.doesNotMatch(attachedLine[0], /`gh`|`fs`/);
  } finally {
    r.cleanup();
  }
});

test('losing every server still closes the set, rather than inheriting the machine\'s', async () => {
  // `--mcp-config` is what normally carries `--strict-mcp-config`. With no
  // config file there is nothing to carry it, and the CLI would UNION in
  // whatever `~/.claude.json` and the project's `.mcp.json` hold — so a
  // degraded phase would silently gain servers nobody chose. Determinism here
  // is a safety property, not a tidiness one.
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['gh', 'fs'] });
    assert.ok(out.ran);
    assert.equal(out.requests[0].mcpConfig, undefined, 'nothing reachable, so no config file');
    assert.equal(out.requests[0].strictMcp, true, 'but the set is still closed');
  } finally {
    r.cleanup();
  }
});

test('the operator hears about it once, with the servers named', async () => {
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7', 'gh', 'fs'] });
    assert.deepEqual(out.degraded, [{ phase: 1, ids: ['gh', 'fs'] }]);
  } finally {
    r.cleanup();
  }
});

test('a phase whose servers all connect is told nothing about degradation', async () => {
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7'] });
    assert.doesNotMatch(out.prompts[0], /UNAVAILABLE/);
    assert.deepEqual(out.degraded, []);
    assert.equal(out.state.phases['1'].mcpDegraded, undefined);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * `require`: the old behaviour, for the phase that means it
 * ------------------------------------------------------------------ */

test('require still parks before the spawn, and the halt now names a door', async () => {
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7', 'gh'], mcpPolicy: 'require' });
    assert.equal(out.ran, false, 'nothing was spent');
    assert.equal(out.state.phases['1'].status, 'parked');
    assert.match(out.state.phases['1'].note ?? '', /cannot start: MCP server/);
    // The park used to produce a halt with an empty remedy tail — it named the
    // problem and then stopped talking, which is how a run stayed down.
    assert.equal(out.state.halt?.kind, 'mcp-preflight');
    assert.equal(out.state.halt?.phase, 1);
    assert.match(out.state.halt?.reason ?? '', /Settings ▸ MCP/);
    assert.match(out.state.halt?.reason ?? '', /Continue without these servers/);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Resolution order — the part with a deliberate reversal in it
 * ------------------------------------------------------------------ */

test('the plan outranks the run, unlike model and effort', async () => {
  // A run-wide "carry on regardless" is an operator's convenience, usually
  // clicked for an unrelated reason. A phase whose plan says it requires a
  // server is a versioned statement about the work, and must survive it.
  const r = repo();
  try {
    const out = await drive(r, {
      mcpServers: ['gh'], mcpPolicy: 'continue', planMcpPolicy: 'require',
    });
    assert.equal(out.ran, false, 'the plan won');
    assert.equal(out.state.phases['1'].status, 'parked');
  } finally {
    r.cleanup();
  }
});

test('the phase option outranks the plan — the operator can still say so, once', async () => {
  // The escape hatch that makes plan-beats-run safe to ship: an operator
  // looking at a parked phase knows something the versioned document cannot,
  // which is whether THIS attempt can proceed without the server. They say it
  // at the level where they mean it, not in bulk.
  const r = repo();
  try {
    const out = await drive(r, {
      mcpServers: ['gh'],
      planMcpPolicy: 'require',
      phaseOptions: { 1: { mcpPolicy: 'continue' } },
    });
    assert.ok(out.ran, 'the most specific answer wins');
    assert.match(out.prompts[0], /UNAVAILABLE/);
  } finally {
    r.cleanup();
  }
});

test('a plan that says nothing lets the run answer', async () => {
  const r = repo();
  try {
    const parked = await drive(r, { mcpServers: ['gh'], mcpPolicy: 'require' });
    assert.equal(parked.ran, false);
  } finally {
    r.cleanup();
  }
  const second = repo();
  try {
    const ran = await drive(second, { mcpServers: ['gh'] });
    assert.ok(ran.ran, 'and with the run silent too, the shipped default is continue');
  } finally {
    second.cleanup();
  }
});

test('a plan-declared server is degraded like any other — mcpOff does not reach it', async () => {
  // `mcpOff` drops the RUN's servers and deliberately leaves the plan's, so a
  // plan naming an unreachable server must still resolve to a degradation
  // rather than to nothing at all.
  const r = repo();
  try {
    const out = await drive(r, {
      planMcp: ['gh'],
      mcpServers: ['ctx7'],
      phaseOptions: { 1: { mcpOff: true } },
    });
    assert.ok(out.ran);
    assert.deepEqual(out.degraded, [{ phase: 1, ids: ['gh'] }]);
    assert.match(out.prompts[0], /`gh`/);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

test('the degradation is written to the phase record, not only the journal', async () => {
  // A phase that quietly did without half its tools and a phase that had all of
  // them look identical afterwards. The run page reads this.
  const r = repo();
  try {
    const out = await drive(r, { mcpServers: ['ctx7', 'gh', 'fs'] });
    const rows = out.state.phases['1'].mcpDegraded ?? [];
    assert.deepEqual(rows.map((row) => [row.id, row.reason]), [['gh', 'needs-auth'], ['fs', 'failed']]);
    // And it survives the checkpoint, which is what the browser actually reads
    // after a restart — the run page's degraded chip comes off disk, not off
    // the live loop.
    const file = JSON.parse(readFileSync(
      join(runsDir(r.root), `run-${out.state.id}.json`), 'utf8',
    )) as { phases: Record<string, { mcpDegraded?: unknown[] }> };
    assert.equal(file.phases['1'].mcpDegraded?.length, 2);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The require park's clock — continue without the servers, errand recorded
 * ------------------------------------------------------------------ */

test('a require park has a clock: past it the phase continues without its servers — errand recorded, operator told once — and boards with the session told', async () => {
  const r = repo();
  try {
    const prompts: string[] = [];
    const configFiles: string[][] = [];
    const told: { phase: number; servers: string[] }[] = [];
    const done = join(r.root, '.stub', 'done');
    const spawn: SpawnFn = async (request: SpawnRequest) => {
      prompts.push(request.prompt);
      const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
      if (phase) writeFileSync(done, `${phase}\n`, { flag: 'a' });
      return outcome();
    };
    const runner = new Runner({
      scriptsDir: r.scripts,
      spawn,
      verificationText: () => '`true`',
      mcp: mcpDep(configFiles),
      planMcp: () => [],
      planMcpPolicy: () => undefined,
      mcpRequireTimeoutMs: () => 60_000,
      onMcpRequireTimeout: (_state, phase, result) => { told.push({ phase, servers: result.servers }); },
    } as never);
    await runner.start({
      slug: 'demo', root: r.root, onlyPhases: [1], mcpServers: ['ctx7', 'gh'], mcpPolicy: 'require',
    } as Parameters<typeof runner.start>[0]);
    await runner.wait();

    const parked = runner.current()!;
    assert.equal(parked.phases['1'].status, 'parked');
    assert.deepEqual(parked.phases['1'].mcpPark?.degraded.map((row) => row.id), ['gh'], 'the park carries what it parked on');
    assert.ok(parked.phases['1'].mcpPark?.at);
    assert.equal(parked.halt?.kind, 'mcp-preflight');
    assert.equal(prompts.length, 0);

    // The clock fires (the service's timer calls this verb).
    const result = runner.continueMcpPark(1, 'timeout');
    assert.ok(result);
    assert.deepEqual(result.servers, ['gh']);
    const flipped = runner.current()!;
    assert.equal(flipped.phases['1'].status, 'pending');
    assert.equal(flipped.phases['1'].boardingHint?.rung, 'mcp-continue');
    assert.equal(flipped.phases['1'].mcpPark, undefined);
    assert.equal(flipped.phaseOptions?.['1']?.mcpPolicy, 'continue', 'the phase\'s OWN policy — the level that outranks a plan\'s require');
    assert.equal(flipped.recoveries?.['1']?.errand?.situation, 'mcp-unavailable');
    assert.match(flipped.recoveries?.['1']?.errand?.need ?? '', /gh \(needs authentication\).*went ahead without it/);
    assert.deepEqual(flipped.recoveries?.['1']?.rungs?.map((rung) => `${rung.rung}:${rung.outcome}`), ['wait-heal:failed', 'mcp-continue:running']);
    assert.deepEqual(told, [{ phase: 1, servers: ['gh'] }], 'the service hears once');
    assert.equal(runner.continueMcpPark(1, 'timeout'), null, 'a second fire finds nothing to do');

    // The loop had parked; a resume boards the hinted phase without gh, the
    // run-level `require` notwithstanding, and the session is told which
    // server is missing.
    await runner.start({
      slug: 'demo', root: r.root, resumeRunId: flipped.id, onlyPhases: [1], mcpServers: ['ctx7', 'gh'], mcpPolicy: 'require',
    } as Parameters<typeof runner.start>[0]);
    await runner.wait();
    const after = runner.current()!;
    assert.equal(after.status, 'finished');
    assert.equal(after.phases['1'].status, 'done');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /gh/);
    assert.deepEqual(after.phases['1'].mcpDegraded?.map((row) => row.id), ['gh']);
    assert.deepEqual(configFiles.at(-1), ['ctx7'], 'only the reachable server is attached');
    assert.equal(told.length, 1, 'still once');
  } finally {
    r.cleanup();
  }
});
