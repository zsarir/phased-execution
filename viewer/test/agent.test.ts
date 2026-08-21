/**
 * The agent launch composer.
 *
 * Everything here is pure — `buildAgentLaunch` in, a `LaunchSpec` or a named
 * refusal out — so the whole validation table and the composed plan prompt
 * are asserted without a console, a pty, or the `claude` CLI anywhere near
 * the test. The registry-level behavior (gating, spawn, labels, reaping)
 * lives in terminal.test.ts; this file is about what gets composed.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, hostname, userInfo } from 'node:os';

import {
  buildAgentLaunch, phasedExecutionSkillId, planPrompt,
  MAX_AGENT_PROMPT_BYTES, MAX_BRIEF_BYTES,
} from '../server/agent.ts';
import type { SkillInfo } from '../server/skills.ts';

const CTX = {
  skills: (): SkillInfo[] => [],
  scriptsDir: '/opt/phased-execution/scripts',
  rootOpen: true,
};

function skill(id: string): SkillInfo {
  const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return { id, name, description: '', source: 'personal', path: `/skills/${name}/SKILL.md` };
}

test('a full request becomes exactly the argv the CLI needs, prompt last', () => {
  const built = buildAgentLaunch({
    kind: 'claude', model: 'opus', effort: 'max', permissionMode: 'acceptEdits',
    prompt: 'Fix the flaky auth tests and commit.', skills: ['design-review'],
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { launch } = built;
  assert.equal(launch.kind, 'claude');
  assert.equal(launch.file, 'claude');
  const id = launch.meta?.claudeSessionId ?? '';
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const prompt = launch.args[launch.args.length - 1];
  assert.deepEqual(launch.args.slice(0, -1), [
    '--session-id', id,
    '--permission-mode', 'acceptEdits',
    '--model', 'opus',
    '--effort', 'max',
    '--name', 'Claude: Fix the flaky auth tests and commit.',
  ]);
  assert.match(prompt, /^Fix the flaky auth tests and commit\./);
  assert.match(prompt, /\/design-review/);
  assert.equal(launch.args.filter((a) => a.startsWith('Fix the flaky auth')).length, 1,
    'the prompt appears exactly once, as the positional');
  assert.equal(launch.label, 'Claude: Fix the flaky auth tests and commit.');
  assert.deepEqual(launch.meta, {
    model: 'opus', effort: 'max', permissionMode: 'acceptEdits', claudeSessionId: id,
  });
});

test('empty selections mean the CLI default — no flag at all', () => {
  const built = buildAgentLaunch({ kind: 'claude', model: '', effort: '', permissionMode: '' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.args[0], '--session-id');
  assert.equal(built.launch.args.length, 2, 'a bare TUI: a session id and nothing else');
  assert.equal(built.launch.label, undefined);
  assert.deepEqual(Object.keys(built.launch.meta ?? {}), ['claudeSessionId']);
});

test('every off-list value is refused by name, and nothing is guessed', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ model: 'gpt-4' }, /model must name a Claude model/],
    [{ effort: 'ultra' }, /effort must be one of/],
    [{ permissionMode: 'bypassPermissions' }, /permission mode must be one of/],
    // `default` is real at the CLI, but the vocabulary is the runner's — the
    // way to ask for the default is to not choose one.
    [{ permissionMode: 'default' }, /permission mode must be one of/],
    [{ prompt: '-p sneaky' }, /may not begin with '-'/],
    [{ prompt: 'x'.repeat(MAX_AGENT_PROMPT_BYTES + 1) }, /too long/],
    [{ resume: 'not-a-uuid' }, /uuid/],
    [{ resume: '00000000-0000-4000-8000-000000000000', prompt: 'hi' }, /mutually exclusive/],
    [{ intent: 'chaos' }, /must be 'plan'/],
    [{ intent: 'plan' }, /needs a brief/],
    [{ intent: 'plan', brief: 'b'.repeat(MAX_BRIEF_BYTES + 1) }, /too long/],
    [{ intent: 'plan', brief: 'x', prompt: 'y' }, /composes its own prompt/],
    [{ intent: 'plan', brief: 'x', resume: '00000000-0000-4000-8000-000000000000' }, /mutually exclusive/],
  ];
  for (const [body, why] of cases) {
    const built = buildAgentLaunch(body, CTX);
    assert.equal(built.ok, false, JSON.stringify(body));
    if (!built.ok) {
      assert.equal(built.status, 400, JSON.stringify(body));
      assert.match(built.error, why);
    }
  }
});

test('every spelling the CLI takes is accepted, not just the four aliases', () => {
  // The launcher used to validate against MODEL_FALLBACK — the escalation
  // ladder — so `claude-opus-5`, the CLI's own documented example, was a 400,
  // and there was no way at all to ask for the 1M window.
  for (const model of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]', 'opusplan']) {
    const built = buildAgentLaunch({ kind: 'claude', model, prompt: 'go' }, CTX);
    assert.equal(built.ok, true, `${model} must be accepted`);
    if (!built.ok) continue;
    const argv = built.launch.args;
    const at = argv.indexOf('--model');
    assert.ok(at >= 0, `${model} must reach argv`);
    assert.equal(argv[at + 1], model, 'and reach it byte-for-byte — brackets included');
  }
});

test('a plan brief with no source directory open is a 409, not a 400', () => {
  const built = buildAgentLaunch(
    { kind: 'claude', intent: 'plan', brief: 'ship it' },
    { ...CTX, rootOpen: false },
  );
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.equal(built.status, 409);
    assert.match(built.error, /No source directory/);
  }
});

test('a forbidden flag as prompt TEXT survives as prose, never as a flag', () => {
  const built = buildAgentLaunch({
    kind: 'claude',
    prompt: 'explain what --dangerously-skip-permissions does',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const last = built.launch.args[built.launch.args.length - 1];
  assert.equal(last, 'explain what --dangerously-skip-permissions does');
  assert.ok(!built.launch.args.slice(0, -1).includes('--dangerously-skip-permissions'),
    'never a standalone argv slot — only quoted inside the prompt and the label derived from it');
});

test('the plan prompt invokes the id the child can actually resolve', () => {
  assert.equal(phasedExecutionSkillId([]), 'phased-execution');
  assert.equal(phasedExecutionSkillId([skill('phased-execution')]), 'phased-execution');
  assert.equal(phasedExecutionSkillId([skill('tools:phased-execution')]), 'tools:phased-execution');
  assert.equal(
    phasedExecutionSkillId([skill('tools:phased-execution'), skill('phased-execution')]),
    'phased-execution',
    'an exact bare id wins over a plugin’s namespaced one',
  );
});

test('the composed plan prompt walks Mode 1 end to end and carries the brief', () => {
  const built = buildAgentLaunch({
    kind: 'claude', intent: 'plan', brief: 'Add rate limiting to the public API.',
    skills: ['phased-execution', 'design-review'],
  }, { ...CTX, skills: () => [skill('phased-execution')] });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const text = built.launch.args[built.launch.args.length - 1];
  for (const needle of [
    'Invoke the phased-execution skill',
    'new-plan.sh', 'phase-graph.sh', 'validate.sh', 'Commit',
    'STOP and summarise',
    'Add rate limiting to the public API.',
  ]) {
    assert.ok(text.includes(needle), needle);
  }
  // The plan skill is the subject of the prompt, not a second, competing
  // directive; the extra skill still gets its line.
  assert.ok(!text.includes('): /phased-execution'), 'no directive re-names the plan skill');
  assert.match(text, /\/design-review/);
  assert.equal(built.launch.label, 'Plan: Add rate limiting to the public API.');
  assert.equal(built.launch.meta?.intent, 'plan');
  // The prompt matches the mode it is launched in: present first, write after
  // approval. Without both halves the session can scaffold and commit a plan
  // nobody has read, which is the decision the wizard exists to put in front
  // of a person.
  assert.match(text, /starts in PLAN MODE/);
  assert.match(text, /write nothing until the operator approves/);
  assert.ok(
    text.indexOf('After the operator approves') < text.indexOf('new-plan.sh'),
    'the scaffold step is on the far side of the approval',
  );
});

test('a plan session starts in plan mode without anyone asking for it', () => {
  const built = buildAgentLaunch({ kind: 'claude', intent: 'plan', brief: 'ship it' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { args } = built.launch;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(built.launch.meta?.permissionMode, 'plan',
    'meta reports the mode the process actually runs under, so the page can label it');
});

test('an explicit permission mode beats the plan default — the form is a real choice', () => {
  for (const mode of ['acceptEdits', 'manual'] as const) {
    const built = buildAgentLaunch(
      { kind: 'claude', intent: 'plan', brief: 'ship it', permissionMode: mode },
      CTX,
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const { args } = built.launch;
    assert.equal(args[args.indexOf('--permission-mode') + 1], mode);
    assert.equal(built.launch.meta?.permissionMode, mode);
    assert.equal(args.filter((a) => a === '--permission-mode').length, 1,
      'one mode flag, never the default alongside the override');
  }
});

test('the plan default is the plan intent’s alone — a bare session still has none', () => {
  const built = buildAgentLaunch({ kind: 'claude', prompt: 'just talk to me' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(!built.launch.args.includes('--permission-mode'),
    'the CLI’s own default stays an omission for every other session');
  assert.equal(built.launch.meta?.permissionMode, undefined);
});

/**
 * Does `text` name `secret` as a token of its own, rather than by accident?
 *
 * A bare `includes()` reads an identity out of any word that merely contains it,
 * and short hostnames are the trap: this machine answers to `Mac`, which lives
 * inside the ordinary word "machine" — so the neutrality tests failed on the one
 * laptop the console is developed on and passed everywhere else. A real leak
 * names the identity standing alone — a home directory, a `user@host`, a bare
 * hostname — and every delimiter that surrounds one of those is non-alphanumeric.
 */
function namesLocalIdentity(text: string, secret: string): boolean {
  const literal = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`, 'i').test(text);
}

test('the committed template is neutral — the scrub patterns find nothing', () => {
  // Derived, never spelled out. This file ships in a public repository, and a
  // test that lists the operator's real name and employer in order to forbid
  // them publishes exactly what it is defending.
  const scriptsDir = '/opt/phased-execution/scripts';
  const text = planPrompt('a neutral brief about a cart api', 'phased-execution', scriptsDir);

  for (const secret of [userInfo().username, hostname(), homedir()]) {
    // A single-character username would match everything; nothing real is that short.
    if (secret.length < 3) continue;
    assert.ok(!namesLocalIdentity(text, secret), `template names ${secret.length} chars of local identity`);
  }
  assert.ok(!/\.ts\.net\/[a-z]/i.test(text), 'template names a tailnet');
  // The structural rule the literals were a proxy for: the only absolute path a
  // committed template may carry is the one its caller passed in.
  for (const found of text.match(/(?:\/Users\/|\/home\/|\/opt\/)[\w.\-/]+/g) ?? []) {
    assert.ok(found.startsWith(scriptsDir), `template names ${found}`);
  }
});

test('labels are the operator’s words, shortened honestly', () => {
  const long = 'Rebuild the entire notification pipeline with queues and retries and dashboards';
  const built = buildAgentLaunch({ kind: 'claude', prompt: long }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const label = built.launch.label ?? '';
  assert.ok(label.startsWith('Claude: Rebuild the entire notification'), label);
  assert.ok(label.endsWith('…'), label);
  assert.ok(label.length <= 'Claude: '.length + 48, label);
});

test('extra skills are shaped, deduped and capped — bad ids dropped, not fatal', () => {
  const built = buildAgentLaunch({
    kind: 'claude', prompt: 'hi',
    skills: ['design-review', 'design-review', 'bad id!!', 'plug:tool.x', 123],
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const text = built.launch.args[built.launch.args.length - 1];
  assert.match(text, /\/design-review, \/plug:tool\.x/);
  assert.ok(!text.includes('bad id'));
});

test('resume swaps the session id for --resume and carries no prompt', () => {
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555', model: 'opus',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.launch.args, [
    '--resume', '11111111-2222-4333-8444-555555555555',
    '--model', 'opus',
  ]);
  assert.equal(built.launch.meta?.claudeSessionId, '11111111-2222-4333-8444-555555555555',
    'the meta still names the claude session a future resume would target');
});

test('a recovery ticket honors model, effort and skills — the dialog depends on it', () => {
  // Pinned because the launch dialog now offers all three on every recovery
  // click: these are generic body fields, and a refactor that special-cased
  // the recovery intent out of them would break the dialog silently.
  const built = buildAgentLaunch({
    kind: 'claude', intent: 'recovery', model: 'sonnet', effort: 'high',
    skills: ['design-review'],
  }, {
    ...CTX,
    recovery: {
      class: 'plan-repair', slug: 'alpha',
      scriptsDir: '/opt/phased-execution/scripts', skillId: 'phased-execution',
      issues: [{ kind: 'index-drift', message: 'INDEX says done, handoff says blocked' }],
    } as never,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(built.launch.args.includes('--model'), 'the model flag rides');
  assert.equal(built.launch.args[built.launch.args.indexOf('--model') + 1], 'sonnet');
  assert.equal(built.launch.args[built.launch.args.indexOf('--effort') + 1], 'high');
  const prompt = built.launch.args[built.launch.args.length - 1];
  assert.match(prompt, /\/design-review/, 'picked skills reach the recovery prompt');
  assert.match(prompt, /plan-repair|Repair/i, 'and it is still the recovery briefing');
});
