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
// Both, before anything is imported: the policy defaults resolve from
// XDG_CONFIG_HOME at module load, and a test that writes rules must never be
// able to reach the operator's own `~/.config/phase-console/autopilot.json`.
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
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
 * The rule taxonomy
 *
 * One example of every documented form, because a rule that parses and does
 * not match is indistinguishable from a rule that was never written — and the
 * whole point of the editor is that people can trust what they typed.
 * ------------------------------------------------------------------ */

test('every documented rule form returns the documented verdict', async () => {
  const { ruleMatches: matches } = await import('../server/runner/approvals.ts');
  const home = '/home/tester';
  const hit = (rule: string, tool: string, input: unknown) =>
    assert.equal(matches(rule, tool, input, home), true, `${rule} should match`);
  const miss = (rule: string, tool: string, input: unknown) =>
    assert.equal(matches(rule, tool, input, home), false, `${rule} should NOT match`);

  // Bare tool / Tool(*)
  hit('Bash', 'Bash', { command: 'anything at all' });
  hit('WebFetch(*)', 'WebFetch', { url: 'https://example.com' });
  miss('Bash', 'Write', { file_path: '/tmp/x' });

  // Bash globs. The space is load-bearing: `ls *` is not `ls*`.
  hit('Bash(npm run build)', 'Bash', { command: 'npm run build' });
  hit('Bash(npm run test *)', 'Bash', { command: 'npm run test --watch' });
  hit('Bash(* install)', 'Bash', { command: 'npm install' });
  hit('Bash(git * main)', 'Bash', { command: 'git rebase main' });
  hit('Bash(ls:*)', 'Bash', { command: 'ls -la' });
  hit('Bash(ls *)', 'Bash', { command: 'ls -la' });
  miss('Bash(ls:*)', 'Bash', { command: 'lsof -i' });
  miss('Bash(ls *)', 'Bash', { command: 'lsof -i' });
  hit('Bash(ls*)', 'Bash', { command: 'lsof -i' });

  // Parameter match — one parameter, `*` allowed in the value.
  hit('Agent(model:opus)', 'Agent', { model: 'opus', subagent_type: 'Explore' });
  hit('Agent(isolation:worktree)', 'Agent', { isolation: 'worktree' });
  hit('Bash(run_in_background:true)', 'Bash', { command: 'sleep 1', run_in_background: true });
  miss('Bash(run_in_background:true)', 'Bash', { command: 'sleep 1' });

  // Tool-name globs.
  hit('*', 'Bash', { command: 'anything' });
  hit('mcp__*', 'mcp__github__create_issue', {});

  // Read/Edit paths. A bare name means anywhere, which is what protects .env.
  hit('Read(.env)', 'Read', { file_path: '/srv/app/.env' });
  hit('Read(//etc/passwd)', 'Read', { file_path: '/etc/passwd' });
  hit('Read(~/notes/today.md)', 'Read', { file_path: `${home}/notes/today.md` });
  hit('Edit(./src/index.ts)', 'Edit', { file_path: '/repo/src/index.ts' });
  miss('Read(~/notes/*)', 'Read', { file_path: `${home}/notes/deep/one.md` });
  hit('Read(~/notes/**)', 'Read', { file_path: `${home}/notes/deep/one.md` });

  // WebFetch domains.
  hit('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://example.com/a' });
  hit('WebFetch(domain:*.example.com)', 'WebFetch', { url: 'https://api.example.com/a' });
  hit('WebFetch(domain:*)', 'WebFetch', { url: 'https://anywhere.test/a' });
  miss('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://evil.test/a' });

  // MCP.
  hit('mcp__server', 'mcp__server__tool', {});
  hit('mcp__server__*', 'mcp__server__tool', {});
  hit('mcp__server__tool', 'mcp__server__tool', {});
  miss('mcp__server', 'mcp__other__tool', {});

  // Agent types and Cd.
  hit('Agent(Explore)', 'Agent', { subagent_type: 'Explore' });
  hit('Agent(my-custom-agent)', 'Agent', { subagent_type: 'my-custom-agent' });
  miss('Agent(Explore)', 'Agent', { subagent_type: 'Plan' });
  hit('Cd(~/code/*)', 'Cd', { path: `${home}/code/app` });
  miss('Cd(~/code/*)', 'Cd', { path: `${home}/code/app/src` });
  hit('Cd(~/code/**)', 'Cd', { path: `${home}/code/app/src` });
  hit('Cd(**/node_modules)', 'Cd', { path: '/repo/a/node_modules' });
});

test('the rules that parse and do nothing are named, not silently dropped', async () => {
  const { parseRule, inertRules, ruleMatches: matches } = await import('../server/runner/approvals.ts');

  // The documented trap: it reads like a parameter rule and Claude Code drops it.
  assert.equal(parseRule('Bash(command:rm *)')?.support, 'ignored');
  assert.equal(matches('Bash(command:rm *)', 'Bash', { command: 'rm -rf /' }), false);

  // Only Read(…) and Edit(…) path rules are consulted.
  for (const rule of ['Write(/etc/*)', 'NotebookEdit(~/nb.ipynb)', 'Glob(src/**)']) {
    assert.equal(parseRule(rule)?.support, 'ignored', `${rule} is not consulted`);
  }
  assert.equal(parseRule('Edit(src/**)')?.support, 'hook');

  const inert = inertRules({ deny: ['Bash(command:rm *)'], ask: ['Write(/etc/*)'], allow: ['Bash(ok:*)'] });
  assert.deepEqual(inert.map((r) => r.raw), ['Bash(command:rm *)', 'Write(/etc/*)']);
  for (const rule of inert) assert.ok(rule.note, 'each says why it does nothing');
});

test('a rule about a tool the hook never sees is labelled, not pretended about', async () => {
  const { parseRule, HOOK_TOOLS } = await import('../server/runner/approvals.ts');
  // The PreToolUse matcher covers these, so a rule about them is enforced here.
  for (const tool of HOOK_TOOLS) assert.equal(parseRule(tool)?.support, 'hook', tool);
  // These are real rules the CLI enforces — this console just never sees them,
  // and claiming otherwise would be the lie that costs someone an afternoon.
  for (const rule of ['Read', 'Agent(Explore)', 'Cd(~/code/**)', 'mcp__server']) {
    assert.equal(parseRule(rule)?.support, 'cli-only', rule);
  }
});

test('a wrapped command is still the command it wraps', async () => {
  const { commandSegments, stripWrappers } = await import('../server/runner/approvals.ts');
  const policyNow = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
  const bashNow = (command: string) => classifyTool('Bash', { command }, policyNow);

  // `nohup git push` reaches a remote exactly as `git push` does.
  assert.equal(bashNow('nohup git push origin main'), 'deny');
  assert.equal(bashNow('timeout 30s git push origin main'), 'deny');
  assert.equal(bashNow('nice -n 5 npm publish'), 'deny');
  assert.equal(bashNow('xargs rm'), 'allow', 'bare xargs is seen through, and rm is on no list here');
  assert.ok(commandSegments('nohup git push').includes('git push'));
  assert.equal(stripWrappers('git push'), null, 'nothing to peel is not an empty command');

  // And the documented edges, which nothing here can see through: a rule about
  // what these run will not fire, so the console says so rather than implying
  // a protection it does not have.
  assert.equal(stripWrappers('npx some-publisher'), null);
  assert.equal(stripWrappers('docker exec box git push'), null);
});

test('what a wrapper hides never auto-approves', async () => {
  const { neverAutoApproves } = await import('../server/runner/approvals.ts');
  const policyNow = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
  const bashNow = (command: string) => classifyTool('Bash', { command }, policyNow);

  for (const command of [
    'watch -n5 ./collect.sh',
    'setsid ./daemon.sh',
    'flock /tmp/l ./job.sh',
    'find . -name "*.tmp" -exec ./clean.sh {} ;',
  ]) {
    assert.ok(neverAutoApproves(command), command);
    assert.equal(bashNow(command), 'ask', `${command} gets a person, not a default yes`);
  }
  assert.equal(neverAutoApproves('git status'), false);
});

test('a wrapper asks under guarded and runs under the profiles that said stop asking', async () => {
  // The "The user doesn't want to proceed with this tool use" reports, at their
  // cause. `profilePolicy` empties the ask list for trusted and bypass, and
  // this fallback sat below it answering 'ask' in every profile — so a bypass
  // run, where by definition nobody is watching, raised a card, waited out the
  // hook's full hour, and timed out into a deny. The CLI renders that deny with
  // its own canned human-rejection wording, so standing configuration read as a
  // person refusing the work, and the run parked.
  const { profilePolicy } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');
  const wrapped = 'flock /tmp/l ./job.sh';

  assert.equal(
    classifyTool('Bash', { command: wrapped }, profilePolicy(base, 'guarded'), 'guarded'), 'ask',
    'guarded still gets a person for a command whose real payload is hidden',
  );
  for (const profile of ['trusted', 'bypass'] as const) {
    assert.equal(
      classifyTool('Bash', { command: wrapped }, profilePolicy(base, profile), profile), 'allow',
      `${profile} asked this console to stop asking, and that has to reach here too`,
    );
    // The wall is not a preference, and no profile moves it — a wrapper around
    // something on the deny list is still denied.
    assert.equal(
      classifyTool('Bash', { command: 'flock /tmp/l git push origin main' },
        profilePolicy(base, profile), profile), 'deny',
      `${profile} must not reach a remote by hiding it inside a wrapper`,
    );
  }

  // Unstated means guarded: every caller that predates the profile argument
  // keeps the behaviour it had, which is the conservative one.
  assert.equal(classifyTool('Bash', { command: wrapped }, base), 'ask');
});

test('a denial names the rule that made it, so it can be argued with', async () => {
  const { matchedDenyRule } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');

  const rule = matchedDenyRule('Bash', { command: 'git push origin main' }, base);
  assert.ok(rule, 'a denied command must be able to say which line stopped it');
  assert.match(String(rule), /push/, 'and the rule it names is the one about pushing');
  assert.equal(matchedDenyRule('Bash', { command: 'git status' }, base), null,
    'nothing to name when nothing denied it');
});

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

test('only the bypass profile keeps bypassPermissions in the child argv', async () => {
  const { buildArgv, sanitize } = await import('../server/runner/spawn.ts');
  const mode = (argv: string[]) => argv[argv.indexOf('--permission-mode') + 1];

  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp' })), 'acceptEdits', 'the default is unchanged');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'guarded' })), 'acceptEdits');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'trusted' })), 'acceptEdits',
    'trusted empties the ask list — it does not take the CLI’s own guard off');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'bypass' })), 'bypassPermissions');

  // The rewrite still fires for anyone who simply asks for it. Choosing the
  // profile is the only way through, which is what makes it auditable.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions']),
    ['--permission-mode', 'acceptEdits'],
  );
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions'], { allowBypass: true }),
    ['--permission-mode', 'bypassPermissions'],
  );
  // And the flags that disable the repository's own hooks are not unlockable
  // by any profile — those are not a preference anyone gets.
  assert.deepEqual(sanitize(['--bare', '--safe-mode', '--model', 'x'], { allowBypass: true }), ['--model', 'x']);
});

test('trusted skips the ask list and keeps the wall', async () => {
  const { profilePolicy } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');

  for (const profile of ['trusted', 'bypass'] as const) {
    const policyNow = profilePolicy(base, profile);
    assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, policyNow), 'allow',
      `${profile} commits without a card — the interrogation this phase exists to end`);
    assert.equal(classifyTool('Bash', { command: 'npm install left-pad' }, policyNow), 'allow');
    assert.equal(classifyTool('Bash', { command: 'git push origin main' }, policyNow), 'deny',
      `${profile} must not be able to reach a remote`);
    assert.equal(classifyTool('Bash', { command: 'sudo rm -rf /x' }, policyNow), 'deny');
    assert.deepEqual(policyNow.deny, base.deny, 'the wall is identical in every profile');
  }

  // Guarded is exactly what it always was.
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, profilePolicy(base, 'guarded')), 'ask');
});

test('the settings a trusted run is given still carry the whole deny list', async () => {
  const settings = buildSettings({
    runId: 'r', token: 't', origin: 'http://127.0.0.1:4123', profile: 'trusted',
  });
  const permissions = settings.permissions as { deny: string[]; ask?: string[] };
  assert.equal(permissions.ask, undefined);
  for (const rule of DEFAULT_DENY) assert.ok(permissions.deny.includes(rule), rule);
});

/* ------------------------------------------------------------------ *
 * Scopes: one plan, or everywhere
 * ------------------------------------------------------------------ */

test('a plan-scoped rule applies to that plan and to nothing else', async () => {
  const { editPolicy, loadPolicyFor, planPolicyPath } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-scope-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({ add: { allow: ['Bash(task deploy:*)'] }, by: 'tester' }, planPolicyPath('alpha', dir));

  const alpha = loadPolicyFor('alpha', globalFile, dir);
  const beta = loadPolicyFor('beta', globalFile, dir);
  assert.ok(alpha.allow.includes('Bash(task deploy:*)'));
  assert.ok(!beta.allow.includes('Bash(task deploy:*)'), 'another plan is untouched');
  assert.ok(!loadPolicyFor(null, globalFile, dir).allow.includes('Bash(task deploy:*)'));

  // And it survives a reload, because it is a file and not a session's memory.
  assert.ok(loadPolicyFor('alpha', globalFile, dir).allow.includes('Bash(task deploy:*)'));

  // A slug decides a filename and nothing else.
  assert.ok(!planPolicyPath('../../etc/passwd', dir).includes('..'));
  rmSync(dir, { recursive: true, force: true });
});

test('a rule you wrote outranks the ask list; a shipped allow does not', async () => {
  const { editPolicy, loadPolicyFor } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-always-'));
  const globalFile = join(dir, 'autopilot.json');

  // Before: `git commit` is on the ask list and stops the run.
  assert.equal(
    classifyTool('Bash', { command: 'git commit -m x' }, loadPolicyFor(null, globalFile, dir)),
    'ask',
  );

  // "Always allow this" writes the rule the card derived from the ask rule that
  // stopped it. Evaluation is deny → ask → allow with first match winning, so
  // an ordinary allow rule could never cancel it — which would make the button
  // write a rule and change nothing.
  editPolicy({ add: { allow: ['Bash(git commit:*)'] }, by: 'tester' }, globalFile);
  const after = loadPolicyFor(null, globalFile, dir);
  assert.deepEqual(after.always, ['Bash(git commit:*)']);
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, after), 'allow');

  // The wall is still the wall.
  editPolicy({ add: { allow: ['Bash(git push:*)'] }, by: 'tester' }, globalFile);
  assert.equal(
    classifyTool('Bash', { command: 'git push origin main' }, loadPolicyFor(null, globalFile, dir)),
    'deny',
    'no rule anyone can write from a browser gets past deny',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a rule can be removed again, and only the ones you added', async () => {
  const { editPolicy, policyExtras, loadPolicy: load } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot-remove.json');

  editPolicy({ add: { ask: ['Bash(make release:*)', 'Bash(task ship:*)'] }, by: 'tester' }, file);
  assert.deepEqual(policyExtras(file).ask, ['Bash(make release:*)', 'Bash(task ship:*)']);

  editPolicy({ remove: { ask: ['Bash(make release:*)'] }, by: 'tester' }, file);
  assert.deepEqual(policyExtras(file).ask, ['Bash(task ship:*)'], 'and it survives the reload');

  // A shipped default has no line to delete, so removing it is a no-op rather
  // than a hole in the wall.
  editPolicy({ remove: { deny: ['Bash(git push:*)'] }, by: 'tester' }, file);
  assert.ok(load(file).deny.includes('Bash(git push:*)'));
});

test('the rule a card offers is the one that stopped the call', async () => {
  const { suggestedRule } = await import('../server/runner/approvals.ts');
  const policyNow = loadPolicy('/nowhere');

  // Derived from the matched ask rule, so accepting it cancels exactly the
  // thing that interrupted — not a guess that happens to look similar.
  assert.equal(suggestedRule('Bash', { command: 'git commit -m "wip"' }, policyNow), 'Bash(git commit:*)');
  assert.equal(suggestedRule('Bash', { command: 'git add x && git commit -m y' }, policyNow), 'Bash(git commit:*)');
  assert.equal(suggestedRule('WebFetch', { url: 'https://example.com' }, policyNow), 'WebFetch');
  // Nothing matched: the narrowest honest guess, never a bare `Bash`.
  assert.equal(suggestedRule('Bash', { command: 'task deploy --now' }, { deny: [], ask: [], allow: [] }),
    'Bash(task deploy:*)');
});

/* ------------------------------------------------------------------ *
 * Answering a card, and remembering the answer
 * ------------------------------------------------------------------ */

/** A Service with nowhere to write but the redirected config home. */
async function service() {
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  return new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
}

function card(svc: Awaited<ReturnType<typeof service>>, slug: string) {
  const { approval } = svc.approvals.request({
    runId: 'r1', slug, phase: 2, kind: 'tool',
    title: 'Bash: git commit -m x', detail: 'wants to commit', evidence: [],
    tool: { name: 'Bash', input: { command: 'git commit -m x' } },
    suggestedRule: 'Bash(git commit:*)',
  });
  return approval;
}

test('"Always for this plan" writes a rule that plan only, and answers the card', async () => {
  const { loadPolicyFor, policyExtras, planPolicyPath } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const approval = card(svc, 'alpha');

  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'plan', rule: 'Bash(git commit:*)',
  });

  assert.equal(result.ok, true);
  assert.equal(result.wrote, 'Bash(git commit:*)', 'the exact rule is reported back, not assumed');
  assert.equal(result.scope, 'plan');
  assert.equal(approval.status, 'allow', 'the card is answered, not merely remembered');
  assert.equal(approval.decidedBy, 'someone@desk');

  assert.deepEqual(policyExtras(planPolicyPath('alpha')).allow, ['Bash(git commit:*)']);
  assert.equal(classifyTool('Bash', { command: 'git commit -m y' }, loadPolicyFor('alpha')), 'allow');
  assert.equal(classifyTool('Bash', { command: 'git commit -m y' }, loadPolicyFor('beta')), 'ask',
    'another plan still asks — that is what "for this plan" has to mean');
});

test('"Always everywhere" writes to the global policy', async () => {
  const { loadPolicyFor, policyExtras, POLICY_PATH } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const approval = card(svc, 'gamma');

  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'global', rule: 'Bash(npm install:*)',
  });

  assert.equal(result.scope, 'global');
  assert.ok(policyExtras(POLICY_PATH).allow.includes('Bash(npm install:*)'));
  // Every plan, including ones that have no file of their own.
  for (const slug of ['gamma', 'delta', null]) {
    assert.equal(classifyTool('Bash', { command: 'npm install left-pad' }, loadPolicyFor(slug)), 'allow', String(slug));
  }
});

test('a rule that will not parse is refused, and the card is still answered', async () => {
  const svc = await service();
  const approval = card(svc, 'alpha');

  // The decision about *this* call stands on its own. Swallowing it because
  // the remembering failed would lose the half that unblocks the session.
  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'global', rule: 'not a rule at all',
  });

  assert.equal(result.ok, true);
  assert.equal(approval.status, 'allow');
  assert.equal(result.wrote, undefined, 'nothing was written');
  assert.match(result.error!, /not a rule/);
});

test('a card decided without remembering writes no rule at all', async () => {
  const { policyExtras, POLICY_PATH } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const before = policyExtras(POLICY_PATH).allow.length;
  const approval = card(svc, 'alpha');

  const result = svc.decideApproval(approval.id, 'deny', 'someone@desk', 'not now');
  assert.equal(result.ok, true);
  assert.equal(result.wrote, undefined);
  assert.equal(approval.status, 'deny');
  assert.equal(policyExtras(POLICY_PATH).allow.length, before);
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
