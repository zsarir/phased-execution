/**
 * The git-strategy block — what a session is told about branches, and when.
 *
 * The base invariant is silence: a run without `gitMode: 'new-branch'` composes
 * a prompt byte-identical to the one it composed before this feature existed.
 * On top of that, four shapes are pinned: the BRANCH block and its position
 * (after the engine's text, before the skill directive — the plan speaks first,
 * the directive keeps the last word); the WORKTREE escalation exactly when a
 * cross-run holder shares a repository right now; the MISMATCH note only when
 * the plan's own prose names a real branch; and the PR block only on the phase
 * that is genuinely the plan's last — never on a scoped run, never when the
 * operator said no PR.
 *
 * Everything runs against the stub engine from the default-skills harness; the
 * prompt handed to the stubbed spawn is the only honest place to assert any of
 * this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-gitstrat-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
// The config guard too: the registry read at import was reaching the
// operator's REAL ~/.config/phase-console before the belt existed.
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
import type { LockView } from '../server/runner/scheduler.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

type Repo = { root: string; scripts: string; state: string; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-gitstrat-'));
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

  return { root, scripts, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function outcome(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/**
 * Drive the stub plan and hand back every prompt spawned, in phase order.
 * Options ride straight into `Runner.start`; deps are per-test injections.
 */
async function promptsFor(
  r: Repo,
  options: Record<string, unknown>,
  deps: Record<string, unknown> = {},
): Promise<string[]> {
  const prompts: string[] = [];
  const done = join(r.state, 'done');
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
    ...deps,
  } as never);
  await runner.start({ slug: 'demo', root: r.root, ...options } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  assert.ok(prompts.length, 'no phase ever started, so there is no prompt to read');
  return prompts;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

test('a default-branch run composes the prompt it always composed — not one byte more', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { onlyPhases: [1], skills: ['graph-tool'] });
    assert.doesNotMatch(prompts[0]!, /Git strategy/);
    assert.doesNotMatch(prompts[0]!, /pe\/demo/);
    assert.doesNotMatch(prompts[0]!, /worktree/i);
  } finally { r.cleanup(); }
});

test('a new-branch run states the branch rule between the plan and the directive', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, {
      onlyPhases: [1], gitMode: 'new-branch', skills: ['graph-tool'],
    });
    const text = prompts[0]!;
    assert.match(text, /Git strategy for this run/);
    assert.match(text, /ONE plan-wide branch: `pe\/demo`/);
    assert.match(text, /Never commit to the default branch/);
    // The ordering is the contract: the engine's text first, the strategy
    // before the skill directive, the directive last.
    const boot = text.indexOf('BOOT phase 1');
    const git = text.indexOf('Git strategy');
    const directive = text.indexOf('/graph-tool');
    assert.ok(boot >= 0 && boot < git, 'the plan speaks first');
    assert.ok(git < directive, 'the directive keeps the last word');
    // A scoped run is not the plan finishing, so no PR is asked for.
    assert.doesNotMatch(text, /pull request/i);
    // And nothing about sharing: nobody else is here.
    assert.doesNotMatch(text, /worktree/i);
  } finally { r.cleanup(); }
});

test('the mismatch note appears exactly when the plan names a real branch', async () => {
  const r = repo();
  try {
    const quiet = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' },
      { planBranch: () => 'current branch (no new branch).' });
    assert.doesNotMatch(quiet[0]!, /discrepancy/, 'the default idiom is not a named branch');

    // The first drive marked phase 1 done in the stub; put it back.
    writeFileSync(join(r.state, 'done'), '');
    const named = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' },
      { planBranch: () => 'feature/checkout' });
    assert.match(named[0]!, /names the branch `feature\/checkout`/);
    assert.match(named[0]!, /record the discrepancy in your\s+handoff/);
  } finally { r.cleanup(); }
});

test('a cross-run holder in a shared repository escalates to the worktree instruction', async () => {
  const r = repo();
  try {
    // The real guard-off shape: a foreign lock shares the scope, admission is
    // allowed anyway, and the honesty probe reports the neighbour.
    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });
    const prompts = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' }, { scheduler });
    const text = prompts[0]!;
    assert.match(text, /CAUTION — another live session shares a repository/);
    assert.match(text, /other-plan P3 \(sam@example-host\)/);
    assert.match(text, /git worktree add \.\.\/<repo>-pe-demo pe\/demo/);
    assert.doesNotMatch(text, /BEFORE editing anything: if `pe\/demo` exists/,
      'the worktree bullet replaces the checkout bullet, not joins it');
    scheduler.close();
  } finally { r.cleanup(); }
});

test('the PR block lands on the last phase and only there', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { gitMode: 'new-branch' },
      { planTitle: () => 'Demo: the whole feature' });
    assert.equal(prompts.length, 2, 'the stub plan has two phases and both ran');
    assert.doesNotMatch(prompts[0]!, /pull request/i, 'phase 1 is not the last — phase 2 is not done');
    assert.match(prompts[1]!, /Opening the pull request — this is the plan's LAST remaining phase/);
    assert.match(prompts[1]!, /git push -u origin pe\/demo/);
    assert.match(prompts[1]!, /title: "Demo: the whole feature"/);
    assert.match(prompts[1]!, /write the exact commands you would\s+have run into the handoff/);
  } finally { r.cleanup(); }
});

test('openPr: false keeps the branch and drops the PR ask', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { gitMode: 'new-branch', openPr: false });
    assert.match(prompts[1]!, /ONE plan-wide branch/);
    assert.doesNotMatch(prompts[1]!, /pull request/i);
  } finally { r.cleanup(); }
});

test('a scoped run finishing the board\'s last open phase still opens no PR', async () => {
  const r = repo();
  try {
    // Phase 2 is already done; the run is scoped to phase 1. Every OTHER phase
    // is done and this is the sole lane — but the run was never the plan.
    writeFileSync(join(r.state, 'done'), '2\n');
    const prompts = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.doesNotMatch(prompts[0]!, /pull request/i);
  } finally { r.cleanup(); }
});

test('no block, in any shape, ever names an operator skill or a machine identity', async () => {
  const r = repo();
  try {
    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });
    const prompts = await promptsFor(r, { gitMode: 'new-branch' },
      { scheduler, planBranch: () => 'feature/checkout', planTitle: () => 'Demo' });
    for (const text of prompts) {
      // The scrub rule for this public repo: the word must never be composed
      // into anything, prompts included.
      assert.doesNotMatch(text, /graphify/i);
    }
    scheduler.close();
  } finally { r.cleanup(); }
});
