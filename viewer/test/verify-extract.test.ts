/**
 * Reading a plan's verification block well enough to run it.
 *
 * The failure this file exists for, as a real plan wrote it:
 *
 *   ```bash
 *   cd …/viewer && PHASE_CONSOLE_TEST_ROOT=~/repo node --test "test/*.test.ts"
 *   cd … && git ls-files \
 *     | grep -v '^viewer/web/vendor\|^viewer/web/fonts' \
 *     | xargs grep -nliE 'secret-host|private-repo' ; echo "scrub exit: $?"
 *   ```
 *
 * Two read-only commands. The reader split the fence on newlines, so the second
 * became three, two of them beginning with `|`; the classifier then looked at
 * the first whitespace token of each and refused all four — `cd` included. The
 * console asked a person to hand-confirm "4 checks only you can make", they
 * confirmed, and the run recorded `ran: 0, ok: true`. Zero commands executed and
 * a human's name on the result.
 *
 * Two rules come out of that, and both are tested here:
 *
 *   1. Anything the machine can run, the machine runs. A person is asked only
 *      for what no machine could settle — their attention is the one resource
 *      that does not scale, and spending it on `cd` teaches them to click yes.
 *   2. Anything the reader cannot take apart with confidence is refused, never
 *      guessed at. Every segment of a command must pass, because judging the
 *      first token let `node --test x && curl -X POST …` through on the strength
 *      of `node`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractCommands } from '../server/runner/verify.ts';

const only = (text: string) => extractCommands(text);
const runs = (command: string) => only(`\`${command}\``).commands;
const held = (command: string) => only(`\`${command}\``).notRun;

/* ------------------------------------------------------------------ *
 * The regression, exactly as it was written
 * ------------------------------------------------------------------ */

/**
 * The block that broke it, structurally identical — the same `cd &&` head, the
 * same env-assignment prefix, the same two backslash continuations feeding two
 * pipes, the same trailing `; echo`. Only the private repo names are changed,
 * because this repository is public and a fixture is still a string in it.
 */
const PHASE_6 = [
  '- **Verification:**',
  '  ```bash',
  '  cd ~/.local/skills/console/viewer && PHASE_CONSOLE_TEST_ROOT=~/repo node --test "test/*.test.ts"',
  '  cd ~/.local/skills/console && git ls-files \\',
  "    | grep -v '^viewer/web/vendor\\|^viewer/web/fonts' \\",
  "    | xargs grep -nliE 'secret-host|private-repo|internal\\.example' ; echo \"scrub exit: $?\"",
  '  ```',
  '  Then open each tab at 390px and follow the Mobile setup steps against a real phone.',
].join('\n');

test('the block that produced "4 checks only you can make" is two commands', () => {
  const { commands, notRun } = only(PHASE_6);
  assert.equal(commands.length, 2, `expected 2 commands, got ${commands.length}: ${JSON.stringify(notRun)}`);
  assert.match(commands[0], /^cd \S+ && PHASE_CONSOLE_TEST_ROOT=\S+ node --test/);
  // The continuation is rejoined into one command, not three fragments.
  assert.match(commands[1], /git ls-files \| grep -v .* \| xargs grep -nliE .* ; echo/);
  assert.equal(notRun.length, 0, 'nothing here needs a person');
});

test('a line continued with a backslash is one command, not two', () => {
  const { commands } = only('```bash\nnpm test \\\n  --silent\n```');
  assert.deepEqual(commands, ['npm test --silent']);
});

test('an escaped backslash at end of line does not continue', () => {
  // `printf 'a\\'` ends in a literal backslash; the next line is its own command.
  const { commands } = only("```bash\nprintf 'a\\\\'\necho done\n```");
  assert.deepEqual(commands, ["printf 'a\\\\'", 'echo done']);
});

test('a line ending in a bare pipe or && continues too', () => {
  assert.deepEqual(only('```bash\ngit ls-files |\n  wc -l\n```').commands, ['git ls-files | wc -l']);
  assert.deepEqual(only('```bash\nnpm test &&\n  npm run lint\n```').commands, ['npm test && npm run lint']);
});

test('a blank line inside a continued command does not end it', () => {
  const { commands } = only('```bash\n\n# a comment\nnpm test\n\ntask lint\n```');
  assert.deepEqual(commands, ['npm test', 'task lint']);
});

test('tilde fences and CRLF are read like any other fence', () => {
  assert.deepEqual(only('~~~bash\nnpm test\n~~~').commands, ['npm test']);
  assert.deepEqual(only('```bash\r\nnpm test\r\n```').commands, ['npm test']);
  // A lang tag carrying attributes used to fall through to the inline scanner,
  // which then paired the block's backticks arbitrarily.
  assert.deepEqual(only('```bash title="check"\nnpm test\n```').commands, ['npm test']);
});

/* ------------------------------------------------------------------ *
 * The second regression: a bullet nobody could run, written by a
 * plan that had spelled its command out perfectly
 * ------------------------------------------------------------------ */

/**
 * Verbatim shape of `console-operability` §Phase 1, which produced "2 checks
 * only you can make" on run `dc3d6d25` — a wrapped command and a notification
 * category being named in a sentence. A person confirmed both; `ran: 0`.
 */
const WRAPPED = [
  '`cd ~/.local/skills/console/viewer && npm test && npm run test:client &&',
  'npm run typecheck:client && npm run build && npm run check:dist`. Manual: run the console against a',
  'scratch root, touch a plan file → no inbox row; enable `changed`, touch again → row appears.',
].join('\n');

test('a command wrapped by the markdown is one command, not a fragment', () => {
  const { commands, notRun } = only(WRAPPED);
  assert.equal(commands.length, 1, `expected 1 command, got: ${JSON.stringify(notRun)}`);
  assert.equal(
    commands[0],
    'cd ~/.local/skills/console/viewer && npm test && npm run test:client && '
    + 'npm run typecheck:client && npm run build && npm run check:dist',
  );
  // …and `changed` is the prose naming a thing, not a check anybody owes.
  assert.deepEqual(notRun, []);
});

test('a backticked name beside real commands is a citation, not a check', () => {
  const bullet = '`npm test` covers the new `test/terminal*.test.ts` suite and `POST /api/prefs`, '
    + 'per `server/terminal.ts`.';
  const { commands, notRun } = only(bullet);
  assert.deepEqual(commands, ['npm test']);
  assert.deepEqual(notRun, [], 'names are not unmet verification steps');
});

test('a bullet that is ONLY names still says nothing was proven', () => {
  // The same spans with no command beside them: phase 2 of that plan. Dropping
  // these silently would report an unverified phase as cleanly verified.
  const { commands, notRun } = only('plus new node tests (`test/terminal*.test.ts`, route test).');
  assert.deepEqual(commands, []);
  assert.equal(notRun.length, 1);
  assert.match(notRun[0].reason, /not a recognised command/);
});

test('a file being named is never handed to bash', () => {
  // `bash -c 'test/agent.test.ts'` is exit 126 — a phase halted for a plan that
  // was only being descriptive. The instruction forms still run.
  assert.deepEqual(runs('test/agent.test.ts'), []);
  assert.match(held('test/agent.test.ts')[0].reason, /names a file rather than a command/);
  assert.deepEqual(runs('node --test test/agent.test.ts'), ['node --test test/agent.test.ts']);
  assert.deepEqual(runs('scripts/check.sh'), ['scripts/check.sh']);
  // One word, but unmistakably an instruction — and one only a person should run.
  assert.match(held('./deploy.sh')[0].reason, /changes state/);
});

/* ------------------------------------------------------------------ *
 * Every segment must pass
 * ------------------------------------------------------------------ */

test('`cd` is navigation, and the command after it is still judged', () => {
  assert.deepEqual(runs('cd viewer && npm test'), ['cd viewer && npm test']);
  assert.deepEqual(runs('(cd api && pytest -q)'), ['(cd api && pytest -q)']);
  // The `cd` no longer hides what follows it.
  assert.match(held('cd api && rm -rf build')[0].reason, /rm|mutates/);
});

test('a local verb no longer hides a remote write behind it', () => {
  // The hole: `REACHES_OUT` was keyed on the first token of the whole line, so
  // anything starting with an allowlisted local verb skipped the gate entirely.
  const reason = held('node --test x && curl -X POST https://example.com/deploy')[0].reason;
  assert.match(reason, /non-GET/);
  assert.match(reason, /person should run this/);

  assert.match(held("pytest -q; ssh box 'systemctl restart api'")[0].reason, /another machine/);
  assert.match(held("npm test && psql -c 'DELETE FROM orders'")[0].reason, /not demonstrably a read/);
});

test('an environment prefix no longer stands in for the command', () => {
  // `/^[A-Z_]+=/` marked this "known", then looked up its gate under the name
  // `FOO=1` — so nothing gated it, and it ran.
  assert.deepEqual(runs('FOO=1 npm test'), ['FOO=1 npm test']);
  assert.match(held('FOO=1 ./deploy.sh')[0].reason, /changes state/);
  assert.match(held('DEPLOY=1 ./scripts/ship-it.sh')[0].reason, /changes state/);
  // A script whose name promises nothing is still allowed.
  assert.deepEqual(runs('./run.sh'), ['./run.sh']);
  assert.deepEqual(runs('./scripts/check-parity.sh'), ['./scripts/check-parity.sh']);
});

test('wrappers are seen through to the command they run', () => {
  assert.deepEqual(runs('timeout 30 npm test'), ['timeout 30 npm test']);
  assert.deepEqual(runs('timeout -k 5 30 npm test'), ['timeout -k 5 30 npm test']);
  assert.deepEqual(runs('nice -n 10 pytest -q'), ['nice -n 10 pytest -q']);
  assert.deepEqual(runs('env FOO=1 npm test'), ['env FOO=1 npm test']);
  assert.match(held('timeout 30 rm -rf build')[0].reason, /rm|mutates/);
});

test('xargs and bash -c are judged by what they run, not by their own names', () => {
  assert.deepEqual(runs("git ls-files | xargs grep -n 'TODO'"), ["git ls-files | xargs grep -n 'TODO'"]);
  assert.match(held('git ls-files | xargs rm -f')[0].reason, /rm|mutates/);
  assert.deepEqual(runs('bash -c "npm test"'), ['bash -c "npm test"']);
  assert.match(held('bash -c "rm -rf build"')[0].reason, /rm|mutates/);
});

test('docker compose run is a test suite, and docker compose up is not', () => {
  // The file's own header example. `REACHES_OUT.docker` only matched the
  // hyphenated spelling, so the modern one was always refused — which sends
  // every containerised plan's verification to a human.
  assert.deepEqual(
    runs('docker compose run --rm api pytest tests/unit -q'),
    ['docker compose run --rm api pytest tests/unit -q'],
  );
  assert.deepEqual(runs('docker-compose run --rm api pytest -q'), ['docker-compose run --rm api pytest -q']);
  assert.match(held('docker compose up -d')[0].reason, /read-only docker/);
  // The container is ephemeral; what runs inside it is still judged.
  assert.match(held('docker compose run --rm api rm -rf /data')[0].reason, /rm|mutates/);
});

/* ------------------------------------------------------------------ *
 * What it will not guess at
 * ------------------------------------------------------------------ */

test('structure it cannot take apart goes to a person, never to bash', () => {
  for (const command of [
    'echo "unbalanced',
    "echo 'also unbalanced",
    'echo $(rm -rf /tmp/x)',
    'diff <(sort a) <(sort b)',
  ]) {
    const notRun = held(command);
    assert.equal(runs(command).length, 0, command);
    assert.match(notRun[0].reason, /could not be read with confidence/, command);
  }

  // A backtick cannot survive an inline code span, so this one is written the
  // only way a plan could write it — inside a fence.
  const backtick = only('```bash\necho `whoami`\n```');
  assert.deepEqual(backtick.commands, []);
  assert.match(backtick.notRun[0].reason, /could not be read with confidence/);
});

test('the old guards still hold', () => {
  assert.match(held('… -m "not slow" -q')[0].reason, /continuation fragment/);
  assert.match(held('docs/plans/demo.md')[0].reason, /not a recognised/);
  assert.match(held('**Verification:**')[0].reason, /not a recognised/);
  assert.equal(only('targeted pytest + safe set; both green.').notRun[0].reason.includes('no command'), true);
  assert.match(held('x'.repeat(2_100))[0].reason, /implausibly long/);
});

test('a refusal names the part of the line that caused it', () => {
  // `not a recognised command (starts with "|")` told an operator nothing about
  // which of four fragments was the problem, or why.
  const reason = held('npm test && curl -X POST https://example.com/x')[0].reason;
  assert.match(reason, /curl -X POST/, 'the offending segment is quoted back');
});

/* ------------------------------------------------------------------ *
 * The two copies of the same policy
 * ------------------------------------------------------------------ */

test('MUTATION_DENY and GATE_CMD_DENY still say the same thing', () => {
  // `verify.ts` claims to be "kept in step with GATE_CMD_DENY in
  // phase-graph.sh" and was not: the shell copy had drifted by four clauses.
  // A comment cannot enforce itself, so this does.
  const here = dirname(fileURLToPath(import.meta.url));
  const ts = readFileSync(join(here, '../server/runner/verify.ts'), 'utf8');
  const sh = readFileSync(join(here, '../../scripts/phase-graph.sh'), 'utf8');

  const tsBlock = /const MUTATION_DENY = new RegExp\(([\s\S]*?)\n\);/.exec(ts)?.[1] ?? '';
  const shBlock = /GATE_CMD_DENY='([^']*)'/.exec(sh)?.[1] ?? '';
  assert.ok(tsBlock, 'MUTATION_DENY not found');
  assert.ok(shBlock, 'GATE_CMD_DENY not found');

  // Compare the verbs each names, which is the policy — not the two dialects of
  // character class they are written in.
  const verbs = (text: string) => new Set(
    (text.match(/[a-z]{2,}(?:\\s\+[a-z]+)?/g) ?? [])
      .filter((word) => !['new', 'regexp', 'space', 'alpha', 'true', 'false'].includes(word)),
  );
  const missing = [...verbs(tsBlock)].filter((word) => !verbs(shBlock).has(word));
  assert.deepEqual(missing, [], `phase-graph.sh is missing: ${missing.join(', ')}`);
});
