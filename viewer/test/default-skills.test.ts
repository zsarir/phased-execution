/**
 * Skills every run starts with, and the one phase that wants none of them.
 *
 * A machine-level default is a small feature with a sharp edge: the whole point
 * is that nobody has to ask for it, which is exactly what makes "I turned it off
 * and it came back" the failure to guard against. So most of what is pinned here
 * is the OFF paths — an empty list from the browser meaning none rather than
 * "you did not say", an existing run answering for itself rather than being
 * re-seeded, and a phase excluded from the run's list keeping its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-defskills-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { parseFlags } = await import('../server/config.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { seedSkills } = await import('../server/service.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

/* ------------------------------------------------------------------ *
 * The flag and the environment variable
 * ------------------------------------------------------------------ */

test('the environment seeds the default, and the flag adds to it', () => {
  // Additive rather than overriding, like `--remote`: the plist bakes in what
  // this machine always wants, and an operator starting a console by hand to
  // add one skill should not have to restate the rest.
  const before = process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
  process.env.PHASE_CONSOLE_DEFAULT_SKILLS = 'graph-tool, indexer';
  try {
    assert.deepEqual(parseFlags([]).defaultSkills, ['graph-tool', 'indexer']);
    assert.deepEqual(
      parseFlags(['--default-skills', 'investigate']).defaultSkills,
      ['graph-tool', 'indexer', 'investigate'],
    );
  } finally {
    if (before === undefined) delete process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
    else process.env.PHASE_CONSOLE_DEFAULT_SKILLS = before;
  }
});

test('nothing set is an empty list, never undefined', () => {
  // Every consumer spells it `flags.defaultSkills.length`; an undefined here
  // would be a crash on a console nobody configured, which is most of them.
  const before = process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
  delete process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
  try {
    assert.deepEqual(parseFlags([]).defaultSkills, []);
  } finally {
    if (before !== undefined) process.env.PHASE_CONSOLE_DEFAULT_SKILLS = before;
  }
});

test('anything that is not a skill id is dropped before it reaches a prompt', () => {
  // These end up in a child's boot prompt as `/name`. A path traversal or a
  // space is not a skill anywhere, so naming it would only tell a session to
  // invoke something that cannot exist.
  //
  // The environment has to come out first. The flag is deliberately additive
  // (see above), so on a machine whose launch environment already sets
  // PHASE_CONSOLE_DEFAULT_SKILLS this asserts against that operator's list plus
  // the flag's — green on CI, red on the console's own laptop.
  const before = process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
  delete process.env.PHASE_CONSOLE_DEFAULT_SKILLS;
  try {
    const flags = parseFlags([
      '--default-skills', '../../etc/passwd,ok-name,plugin:deploy, ,two words,ok-name',
    ]);
    assert.deepEqual(flags.defaultSkills, ['ok-name', 'plugin:deploy']);
  } finally {
    if (before !== undefined) process.env.PHASE_CONSOLE_DEFAULT_SKILLS = before;
  }
});

/* ------------------------------------------------------------------ *
 * Seeding a new run
 * ------------------------------------------------------------------ */

test('a run that named no skills takes the machine default', () => {
  assert.deepEqual(seedSkills(undefined, ['graph-tool']), ['graph-tool']);
});

test('AN EMPTY LIST IS AN ANSWER — the operator unchecked every box', () => {
  // The single most important line of this feature. With `||` in place of `??`
  // the default would reassert itself here and there would be no way to turn it
  // off for a run at all — the checkbox would silently do nothing.
  assert.deepEqual(seedSkills([], ['graph-tool']), []);
});

test('what was asked for wins outright, defaults are not merged in', () => {
  // Not a union: an operator who chose `investigate` and unchecked the default
  // chose one skill, and quietly adding the other back is the same defect as
  // ignoring the empty list.
  assert.deepEqual(seedSkills(['investigate'], ['graph-tool']), ['investigate']);
});

test('with no default configured a silent request stays silent', () => {
  assert.equal(seedSkills(undefined, []), undefined);
});

test('the seed is a copy, so a run cannot mutate the console flag', () => {
  const defaults = ['graph-tool'];
  const seeded = seedSkills(undefined, defaults)!;
  seeded.push('something-else');
  assert.deepEqual(defaults, ['graph-tool']);
});

/* ------------------------------------------------------------------ *
 * The merge, in the runner
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; cleanup: () => void };

/**
 * The smallest repo the runner will drive: a one-phase linear board and a stub
 * engine that answers the four things `attempt()` asks it.
 */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-defskills-'));
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
    for p in 1 2; do
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

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * A session that succeeded, in the shape the runner reads.
 *
 * Every field matters even here: `resultText` is read unconditionally
 * (`record.said`), so a partial stub crashes the lane AFTER the prompt has been
 * captured — which leaves the assertions passing and the log full of errors.
 */
function outcome(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/**
 * Run one phase and hand back the prompt the session was actually given.
 *
 * The prompt is the only honest place to assert this: the merge exists to decide
 * what a child is told, and a unit test of the expression would pass with the
 * call site deleted.
 */
async function promptFor(
  r: Repo,
  options: { skills?: string[]; phaseOptions?: Record<string, unknown> },
): Promise<string> {
  const prompts: string[] = [];
  const done = join(r.root, '.stub', 'done');
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    prompts.push(request.prompt);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    // Append, never read-modify-write: two lanes finishing in the same
    // millisecond lose one update (see the P4 handoff).
    if (phase) writeFileSync(done, `${phase}\n`, { flag: 'a' });
    return outcome();
  };

  const runner = new Runner({
    scriptsDir: r.scripts,
    spawn,
    // `'`true`'` and not undefined: a harness with no verification text halts
    // EVERY phase on "the plan states no verification", which looks exactly
    // like the bug under test.
    verificationText: () => '`true`',
  });
  await runner.start({
    slug: 'demo',
    root: r.root,
    onlyPhases: [1],
    ...options,
  } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  assert.ok(prompts.length, 'the phase never started, so there is no prompt to read');
  return prompts[0];
}

test("a run's skills reach the boot prompt of its phases", async () => {
  const r = repo();
  try {
    const prompt = await promptFor(r, { skills: ['graph-tool'] });
    assert.match(prompt, /\/graph-tool/);
    // And the directive that rides with any list of skills.
    assert.match(prompt, /knowledge graph/i);
  } finally {
    r.cleanup();
  }
});

test('skillsOff drops the run list for that phase and keeps the phase its own', async () => {
  const r = repo();
  try {
    const prompt = await promptFor(r, {
      skills: ['graph-tool'],
      phaseOptions: { 1: { skillsOff: true, skills: ['investigate'] } },
    });
    assert.doesNotMatch(prompt, /\/graph-tool/, 'the run default was excluded here');
    assert.match(prompt, /\/investigate/, '"not the default" is not "nothing at all"');
  } finally {
    r.cleanup();
  }
});

test('skillsOff with no extras of its own leaves the phase with no skill line', async () => {
  const r = repo();
  try {
    const prompt = await promptFor(r, {
      skills: ['graph-tool'],
      phaseOptions: { 1: { skillsOff: true } },
    });
    assert.doesNotMatch(prompt, /\/graph-tool/);
    // The whole directive hangs off a list of skills, so an empty list means the
    // prompt is the engine's text and nothing else.
    assert.doesNotMatch(prompt, /Also invoke/);
    assert.doesNotMatch(prompt, /knowledge graph/i);
  } finally {
    r.cleanup();
  }
});

test('a phase that says nothing still inherits the run list', async () => {
  const r = repo();
  try {
    const prompt = await promptFor(r, {
      skills: ['graph-tool'],
      phaseOptions: { 2: { skillsOff: true } },     // a DIFFERENT phase
    });
    assert.match(prompt, /\/graph-tool/, 'skillsOff on phase 2 must not reach phase 1');
  } finally {
    r.cleanup();
  }
});
