/**
 * Approvals.
 *
 * The load-bearing fact here was measured, not read: Claude Code's `http`
 * PreToolUse hook **fails open**. A live session with nothing listening on the
 * hook URL ran its Bash call and created a file; the same session with a
 * `permissions.deny` rule was blocked twice and gave up. So these tests hold
 * the line between the two layers — the deny list is safety, the hook is
 * workflow — and fail loudly if anything dangerous drifts from one to the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-approvals-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const {
  Approvals, buildSettings, writeSettingsFile, loadPolicy, classifyTool, ruleMatches,
  DEFAULT_DENY, DEFAULT_ASK, HOOK_TIMEOUT_SECONDS,
} = await import('../server/runner/approvals.ts');

/* ------------------------------------------------------------------ *
 * The two layers
 * ------------------------------------------------------------------ */

test('everything irreversible sits in deny, where it holds without the console', () => {
  const settings = buildSettings({ runId: 'r1', token: 't', origin: 'http://127.0.0.1:4123' });
  const deny = (settings.permissions as { deny: string[] }).deny;

  // These reach a remote or destroy something. The hook cannot be trusted to
  // stop them, because with the console down the hook does not run at all.
  for (const rule of ['Bash(git push:*)', 'Bash(terraform apply:*)', 'Bash(terraform destroy:*)', 'Bash(sudo:*)']) {
    assert.ok(deny.includes(rule), `${rule} must be denied outright, never merely asked`);
    assert.ok(!DEFAULT_ASK.includes(rule), `${rule} must not be approvable from a phone`);
  }
});

test('the ask list is never handed to the CLI — headless has nobody to ask', () => {
  // An `ask` rule in `-p` mode is a refusal with extra steps: there is no
  // terminal to prompt. A real run wrote its file, had the commit refused, and
  // sat waiting for a prompt that could never appear. Asking is the hook's job.
  const permissions = buildSettings({ runId: 'r1', token: 't', origin: 'http://x' }).permissions as Record<string, unknown>;
  assert.equal(permissions.ask, undefined);
  // allow does go, because it merges with the repository's rules rather than
  // replacing them — and a session that lost them to an untrusted workspace
  // still has to be able to read the files it was sent to work on.
  assert.ok(Array.isArray(permissions.allow) && permissions.allow.includes('Read'));
  assert.ok(Array.isArray(permissions.deny) && permissions.deny.length > 0);
  // The patterns still exist — they decide what becomes a card.
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, loadPolicy('/nonexistent')), 'ask');
});

test('the hook is pointed at this console and given a bearer token', () => {
  const settings = buildSettings({ runId: 'r1', token: 'secret-token', origin: 'http://127.0.0.1:4123' });
  const entry = (settings.hooks as { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] }).PreToolUse[0];
  const hook = entry.hooks[0];
  assert.equal(hook.type, 'http');
  assert.equal(hook.url, 'http://127.0.0.1:4123/hooks/pre-tool-use');
  assert.deepEqual(hook.headers, { Authorization: 'Bearer secret-token' });
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  // Matching every tool would put a network round trip in front of every Read.
  assert.match(entry.matcher, /Bash/);
  assert.ok(!/\bRead\b/.test(entry.matcher));
});

test('an operator policy adds rules but can never remove a default', () => {
  const file = join(STATE_HOME, 'autopilot.json');
  writeFileSync(file, JSON.stringify({ deny: ['Bash(task deploy:*)'], ask: ['Bash(make release:*)'] }));
  const policy = loadPolicy(file);
  assert.ok(policy.deny.includes('Bash(task deploy:*)'), 'a repo can add its own dangerous verbs');
  for (const rule of DEFAULT_DENY) assert.ok(policy.deny.includes(rule), `${rule} survived the merge`);
  for (const rule of DEFAULT_ASK) assert.ok(policy.ask.includes(rule), `${rule} survived the merge`);
});

test('a malformed policy file falls back to the defaults rather than to nothing', () => {
  const file = join(STATE_HOME, 'broken.json');
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadPolicy(file).deny, DEFAULT_DENY);
  // A policy of `{"deny": "everything"}` is a string, not a list — ignoring the
  // whole file here would be safe; silently accepting it would not.
  writeFileSync(file, JSON.stringify({ deny: 'everything' }));
  assert.deepEqual(loadPolicy(file).deny, DEFAULT_DENY);
});

test('the settings file is not world-readable — it holds the run token', () => {
  const path = writeSettingsFile('r2', buildSettings({ runId: 'r2', token: 'shh', origin: 'http://x' }));
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.match(readFileSync(path, 'utf8'), /shh/);
  // Rewriting an existing file must not leave a looser mode behind.
  writeSettingsFile('r2', buildSettings({ runId: 'r2', token: 'shh2', origin: 'http://x' }));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

/* ------------------------------------------------------------------ *
 * Which calls are worth asking about
 * ------------------------------------------------------------------ */

const policy = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
const bash = (command: string) => classifyTool('Bash', { command }, policy);

test('ordinary work is allowed without troubling anyone', () => {
  // The first real run parked on `find docs -type f` and sat there. A queue
  // that fills with read-only listings is a queue nobody reads, and one nobody
  // reads trains the answer "yes".
  for (const command of [
    'find docs -type f',
    'grep -rn TODO src',
    'npm test',
    'pytest tests/unit -q',
    'git status --short',
    'git diff --stat',
    'cat README.md',
  ]) {
    assert.equal(bash(command), 'allow', command);
  }
  assert.equal(classifyTool('Read', { file_path: '/tmp/x' }, policy), 'allow');
});

test('the irreversible is denied outright, with no card offered', () => {
  for (const command of ['git push origin main', 'sudo rm -rf /x', 'terraform apply', 'npm publish']) {
    assert.equal(bash(command), 'deny', command);
  }
});

test('the in-between asks a person', () => {
  for (const command of ['git commit -m "wip"', 'npm install left-pad', 'ssh box uptime']) {
    assert.equal(bash(command), 'ask', command);
  }
  assert.equal(classifyTool('WebFetch', { url: 'https://example.com' }, policy), 'ask',
    'a bare tool name in the rules covers every use of it');
});

test('chaining does not smuggle a command past its rule', () => {
  // The hole a real run walked through: `git add x && git commit -m y` starts
  // with `git add`, so a prefix rule never sees the commit. The same shape
  // applies to the deny list, which is the part that actually matters.
  assert.equal(bash('git add notes/two.md && git commit -m "phase 2"'), 'ask');
  assert.equal(bash('cd /tmp && git push origin main'), 'deny');
  assert.equal(bash('npm test; sudo rm -rf /x'), 'deny');
  assert.equal(bash('echo hi | terraform apply'), 'deny');
  assert.equal(bash('(cd sub && npm publish)'), 'deny');
  // And a chain of harmless things is still harmless.
  assert.equal(bash('npm ci && npm test && npm run lint'), 'allow');
});

test('a rule matches on a prefix, not on the word appearing anywhere', () => {
  assert.equal(ruleMatches('Bash(git push:*)', 'Bash', { command: 'git push origin main' }), true);
  assert.equal(ruleMatches('Bash(git push:*)', 'Bash', { command: 'echo "git push" >> notes.md' }), false,
    'mentioning a command is not running it');
  assert.equal(ruleMatches('Bash(git push:*)', 'Write', { command: 'git push' }), false,
    'a Bash rule must not govern a Write');
});

/* ------------------------------------------------------------------ *
 * The token
 * ------------------------------------------------------------------ */

test('the hook endpoint rejects anything but this run\'s token', () => {
  const approvals = new Approvals();
  assert.equal(approvals.armed(), false);
  assert.equal(approvals.verify('Bearer anything'), false, 'nothing is accepted before a run arms one');

  const token = approvals.arm('run-1');
  assert.equal(approvals.verify(`Bearer ${token}`), true);
  assert.equal(approvals.verify(token), true, 'the scheme prefix is optional');
  assert.equal(approvals.verify('Bearer wrong'), false);
  assert.equal(approvals.verify(`Bearer ${token}x`), false);
  assert.equal(approvals.verify(undefined), false);

  approvals.disarm();
  assert.equal(approvals.verify(`Bearer ${token}`), false, 'the token dies with the run');
});

test('two runs never share a token', () => {
  const approvals = new Approvals();
  const first = approvals.arm('run-1');
  const second = approvals.arm('run-2');
  assert.notEqual(first, second);
  assert.equal(approvals.verify(`Bearer ${first}`), false, 'the previous run cannot drive the current one');
});

/* ------------------------------------------------------------------ *
 * Deciding
 * ------------------------------------------------------------------ */

function ask(approvals: InstanceType<typeof Approvals>, title = 'Bash: git commit -m wip') {
  return approvals.request({
    runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool',
    title, detail: 'phase 2 wants to commit',
    evidence: [{ label: 'Working tree', body: ' M src/app.ts' }],
    tool: { name: 'Bash', input: { command: 'git commit -m wip' } },
  });
}

test('an approval waits for a person and reports who decided', async () => {
  const seen: string[] = [];
  const approvals = new Approvals((a) => seen.push(a.title));
  approvals.arm('run-1');

  const { approval, decided } = ask(approvals);
  assert.deepEqual(seen, ['Bash: git commit -m wip'], 'the notifier fires immediately, not after the decision');
  assert.equal(approvals.pending().length, 1);

  assert.equal(approvals.settle(approval.id, 'allow', 'phone'), true);
  const outcome = await decided;
  assert.equal(outcome.decision, 'allow');
  assert.equal(outcome.by, 'phone');
  assert.equal(approvals.pending().length, 0);
  assert.equal(approvals.recent().at(-1)?.status, 'allow');
});

test('deciding the same approval twice changes nothing', async () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval, decided } = ask(approvals);
  approvals.settle(approval.id, 'deny', 'console');
  assert.equal(approvals.settle(approval.id, 'allow', 'attacker'), false, 'a settled approval cannot be reopened');
  assert.equal((await decided).decision, 'deny');
});

test('ending a run denies whatever was still waiting, rather than hanging it', async () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { decided } = ask(approvals);
  approvals.disarm();
  const outcome = await decided;
  assert.equal(outcome.decision, 'deny');
  assert.match(outcome.reason!, /run ended/);
});

test('the card carries evidence, not just a yes/no', () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  assert.ok(approval.evidence.length, 'a bare "allow this?" deletes the substance of approving');
  assert.equal(approval.tool!.name, 'Bash');
  assert.equal(approval.phase, 2);
  assert.ok(Date.parse(approval.expiresAt) > Date.parse(approval.createdAt));
});

test('the answer deadline lands before the hook gives up, not after', () => {
  // Our timeout must fire first. If the hook's own timeout wins, the call is
  // not denied — it falls through, because this hook fails open.
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  const ourDeadlineMs = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt);
  assert.ok(
    ourDeadlineMs < HOOK_TIMEOUT_SECONDS * 1000,
    'answering after the hook has already given up is the same as not answering',
  );
});

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

test('a question nobody answered survives the console that was asking it', () => {
  const file = join(STATE_HOME, 'pending-a.json');

  const first = new Approvals(() => {}, file);
  first.arm('run-1');
  ask(first);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, 'written while it is outstanding');

  // The console dies here. A new one starts and reads what was left.
  const second = new Approvals(() => {}, file);
  const recovered = second.all();
  assert.equal(recovered.length, 1, 'the question and its evidence are still here');
  assert.ok(recovered[0].evidence.length, 'including what a person would have needed to answer it');

  // Recovered as a record, NOT as something answerable. The promise a decision
  // would have resolved died with the process, and so did the hook socket on
  // the far end — an Allow button here would be answering into a void.
  assert.equal(recovered[0].status, 'expired');
  assert.match(recovered[0].reason, /console restarted/);
  assert.equal(second.pending().length, 0);
  assert.equal(second.settle(recovered[0].id, 'allow', 'me'), false);

  // And it is not recovered a second time, forever.
  assert.equal(new Approvals(() => {}, file).all().length, 0);
});

test('an answered question leaves nothing outstanding on disk', () => {
  const file = join(STATE_HOME, 'pending-b.json');
  const approvals = new Approvals(() => {}, file);
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  approvals.settle(approval.id, 'allow', 'me');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  assert.equal(new Approvals(() => {}, file).all().length, 0);
});

/* ------------------------------------------------------------------ *
 * The operator's own rules
 * ------------------------------------------------------------------ */

test('the policy file adds to the defaults and can never subtract from them', async () => {
  const { policyExtras, addPolicyRules } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot.json');

  // A policy file that forgot `git push` must not quietly become one that
  // permits it, so the merge is one-way by construction.
  writeFileSync(file, JSON.stringify({ deny: [], ask: [], allow: [] }));
  assert.ok(loadPolicy(file).deny.includes('Bash(git push:*)'));

  addPolicyRules({ deny: ['Bash(task deploy:*)'], ask: ['Bash(make release:*)'] }, file);
  const merged = loadPolicy(file);
  assert.ok(merged.deny.includes('Bash(task deploy:*)'), 'the operator rule is in force');
  assert.ok(merged.deny.includes('Bash(git push:*)'), 'and every default still is');
  assert.ok(merged.ask.includes('Bash(make release:*)'));

  // Added to, never replaced — a second call keeps the first.
  addPolicyRules({ deny: ['Bash(kubectl drain:*)'] }, file);
  const extras = policyExtras(file);
  assert.deepEqual(extras.deny, ['Bash(task deploy:*)', 'Bash(kubectl drain:*)']);
  assert.deepEqual(extras.ask, ['Bash(make release:*)']);
  assert.deepEqual(extras.allow, [], 'nothing widened what a session may do');
});

test('a malformed rule is dropped rather than written into the policy', async () => {
  const { addPolicyRules } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot-junk.json');
  const written = addPolicyRules({
    deny: ['Bash(ok:*)', '', '   ', 'not a rule at all', '../../etc/passwd', 'x'.repeat(300)],
  }, file);
  assert.deepEqual(written.deny, ['Bash(ok:*)']);
});

test('WebSearch is asked about, like the sibling it was always shown beside', () => {
  // The PreToolUse matcher has always covered WebSearch. The ask list did not,
  // so it was silently auto-allowed while WebFetch raised a card.
  const settings = buildSettings({ runId: 'r', token: 't', origin: 'http://127.0.0.1:4123' });
  const matcher = ((settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse)[0].matcher;
  assert.match(matcher, /WebSearch/);
  assert.ok(DEFAULT_ASK.includes('WebSearch'));
  assert.equal(classifyTool('WebSearch', { query: 'anything' }, loadPolicy('/nowhere')), 'ask');
});

/* ------------------------------------------------------------------ *
 * Reaching someone who is not looking at a tab
 * ------------------------------------------------------------------ */

test('the out-of-band notifier is environment-only, and never breaks a run', async () => {
  const { notifyOutOfBand } = await import('../server/runner/approvals.ts');
  // No command configured is the normal case and must be silent.
  assert.doesNotThrow(() => notifyOutOfBand('t', 'b', {} as NodeJS.ProcessEnv));
  // A command that does not exist must not propagate — a broken notifier
  // stopping a run would be worse than no notifier at all.
  assert.doesNotThrow(() =>
    notifyOutOfBand('t', 'b', { PHASE_CONSOLE_NOTIFY: '/nonexistent/notifier' } as NodeJS.ProcessEnv));
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));
