/**
 * QA sessions — the brief, the four guards, and the verdict read back.
 *
 * The console could always *record* a QA result; what it could not do is get
 * one. This is the other half: any phase on the board hands itself to a fresh
 * session that reviews it, and the verdict lands where the engine already reads
 * it. Four properties keep that honest, and they are what this file pins:
 *
 *  1. **The brief is the skill's, not the console's.** The method embedded is
 *     `phase-graph.sh --qa-prompt`, verbatim when it is available and named by
 *     file when it is not — so a console-launched review and a hand-dispatched
 *     one follow one discipline. What the console adds is the facts around it
 *     (the handoff, the commits, the exit criteria) and those are the parts
 *     marked expendable when the 16 KB cap bites.
 *  2. **The review is never the session that built the phase.** A resumed
 *     session carries the author's justifications, so `resume` is refused at
 *     both layers, and a phase with a live session working on it cannot be
 *     reviewed until that session ends.
 *  3. **Turning QA on does not break the board.** Activation goes through the
 *     skill's own `--qa` path because that path backfills the already-complete
 *     phases as waived; skip the backfill and gating turns on plan-wide and
 *     every finished phase's dependents flip ready → waiting.
 *  4. **The console never writes a verdict the session did not record.** A
 *     review that ends without running `qa-record.sh` is reported as exactly
 *     that — including on a phase that already read `pass`, which is the case
 *     where a lazier check would announce a pass nobody earned.
 *
 * The guard tests run against a scratch docs root and the real scripts; the
 * brief tests are pure. Nothing here spawns `claude`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// Redirected before the imports below — every state-dir consumer reads these at
// module load, and an un-redirected run writes into the operator's real state.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-qa-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const {
  MAX_QA_PROMPT_BYTES, QA_RESULTS, isVerdict, parseQaRequest, qaKey, qaLabel, qaPrompt,
} = await import('../server/qa-session.ts');
const { buildAgentLaunch, MAX_AGENT_PROMPT_BYTES } = await import('../server/agent.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { qaKey: clientQaKey, isVerdict: clientIsVerdict, liveQa, canQa } =
  await import('../client/src/lib/qa.ts');

type Facts = Parameters<typeof qaPrompt>[0];

const SCRIPTS = join(SKILL_DIR, 'scripts');

/** A brief with every optional fact present, so any block can be exercised. */
function facts(over: Partial<Facts> = {}): Facts {
  return {
    slug: 'alpha',
    phase: 2,
    scriptsDir: '/opt/phased-execution/scripts',
    skillId: 'phased-execution',
    phaseTitle: 'cart api endpoint',
    reportPath: 'docs/handoffs/alpha/reports/phase-02-qa.md',
    reportArg: 'reports/phase-02-qa.md',
    handoffPath: 'docs/handoffs/alpha/phase-02-cart-api-endpoint.md',
    handoffStatus: 'complete',
    keyFiles: ['src/cart.ts', 'src/cart.test.ts'],
    commits: [
      { sha: 'a1b2c3d', subject: 'feat(cart): the endpoint', date: '2026-08-01' },
      { sha: 'e4f5a6b', subject: 'docs(handoffs): P2', date: '2026-08-01' },
    ],
    goal: 'A cart endpoint that survives a reload.',
    exitCriteria: '1. POST /cart returns 201.\n2. The suite is green.',
    verification: '```bash\nnpm test\n```',
    board: [
      { phase: 1, state: 'done', title: 'schema' },
      { phase: 2, state: 'done', title: 'cart api endpoint' },
      { phase: 3, state: 'ready', title: 'checkout' },
    ],
    qaMode: 'on',
    ...over,
  } as Facts;
}

/* ------------------------------------------------------------------ *
 * The brief
 * ------------------------------------------------------------------ */

test('the brief names the phase, the report path and the command that records the verdict', () => {
  const text = qaPrompt(facts());

  assert.match(text, /INDEPENDENT QA/);
  assert.match(text, /phase\s+2\s+of\s+"alpha"/);
  assert.ok(text.includes('cart api endpoint'), 'the title the board knows');

  // The recording command, spelled out with the path already filled in — a
  // reviewer that has to guess the path writes the report where nothing reads it.
  assert.match(text, /qa-record\.sh\s+alpha\s+2\s+<pass\|fail\|waived>/);
  assert.ok(text.includes('reports/phase-02-qa.md'));
  assert.ok(text.includes('docs/handoffs/alpha/reports/phase-02-qa.md'));

  // Where the work is, so the review starts at the diff and not at a search.
  assert.ok(text.includes('docs/handoffs/alpha/phase-02-cart-api-endpoint.md'));
  assert.ok(text.includes('a1b2c3d'));
  assert.ok(text.includes('src/cart.ts'));
});

test('the exit criteria and the Verification block are quoted, not summarised', () => {
  const text = qaPrompt(facts());
  assert.ok(text.includes('POST /cart returns 201.'), 'the criteria are the bar, verbatim');
  assert.ok(text.includes('npm test'), 'the Verification block is quoted');
  assert.match(text, /RUN these yourself/);
});

test('the method is the engine’s own brief when there is one', () => {
  const engineBrief = 'You are an INDEPENDENT QA reviewer with a FRESH context. Verify Phase 2 of "alpha"';
  const text = qaPrompt(facts({ engineBrief }));
  assert.ok(text.includes(engineBrief), 'the skill’s own brief is embedded verbatim');

  // …and when the engine could not be reached, the discipline is still named by
  // file rather than paraphrased into a second, competing method.
  const fallback = qaPrompt(facts({ engineBrief: undefined }));
  assert.match(fallback, /references\/qa-method\.md/);
  assert.match(fallback, /report-template\.md/);
});

test('a recorded verdict makes it a re-review, and says not to rubber-stamp it', () => {
  const text = qaPrompt(facts({ previous: { result: 'fail', report: 'reports/phase-02-qa.md' } }));
  assert.match(text, /RE-review/);
  assert.match(text, /FAIL/);
  assert.match(text, /not\s+record\s+a\s+pass\s+merely\s+because/);

  // With nothing on file it is a first review and says nothing about one.
  assert.ok(!qaPrompt(facts()).includes('RE-review'));
});

test('a plan with QA off is told the verdict gates nothing yet', () => {
  assert.match(qaPrompt(facts({ qaMode: 'off' })), /QA is currently OFF/);
  assert.ok(!qaPrompt(facts({ qaMode: 'on' })).includes('QA is currently OFF'));
});

test('the plan’s own skills are named, when it asks for any', () => {
  const text = qaPrompt(facts({ skills: ['design-system', 'test-driven-development'] }));
  assert.ok(text.includes('design-system'));
  assert.ok(text.includes('test-driven-development'));
});

test('the fail branch says what a fail costs, so it is never softened by accident', () => {
  const text = qaPrompt(facts());
  assert.match(text, /holds\s+every\s+dependent/);
  assert.match(text, /Never\s+record\s+a\s+pass\s+you\s+did\s+not\s+verify/);
  // The console is not the writer, and the brief says so in those words.
  assert.match(text, /YOU record the verdict/);
  assert.match(text, /Never hand-edit test-status\.md/);
});

test('an oversized brief sheds evidence and keeps the instructions', () => {
  const huge = 'x'.repeat(40 * 1024);
  const text = qaPrompt(facts({
    verification: huge,
    exitCriteria: huge,
    keyFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`),
  }));

  assert.ok(Buffer.byteLength(text) <= MAX_QA_PROMPT_BYTES, 'over the cap the mint would refuse it');
  // What survives is what a reviewer cannot re-derive by running a command.
  assert.match(text, /qa-record\.sh/);
  assert.match(text, /INDEPENDENT QA/);
});

test('the brief survives the agent path’s own rules', () => {
  const text = qaPrompt(facts());
  assert.ok(Buffer.byteLength(text) <= MAX_AGENT_PROMPT_BYTES);
  // A prompt that begins with `-` is parsed as a flag by the CLI and refused by
  // `buildAgentLaunch`; a prompt that never starts with one cannot be.
  assert.ok(!text.startsWith('-'));
  for (const forbidden of ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--setting-sources']) {
    assert.ok(!text.includes(forbidden), `the brief contains ${forbidden}`);
  }
});

test('the committed template is neutral — nothing of this machine reaches it', () => {
  // Derived at runtime and never written down. Listing the operator's real
  // strings here to grep for them WOULD BE the leak: this repository is public,
  // and a committed file that spells them out has already published them.
  const mine = [homedir(), hostname().split('.')[0], userInfo().username]
    .filter((value) => typeof value === 'string' && value.length > 2);

  const scriptsDir = '/opt/phased-execution/scripts';
  const skillRoot = '/opt/phased-execution';

  // Only the required fields. Everything else on `QaFacts` is the CALLER's own
  // prose — an exit criterion reading "POST /cart returns 201" is not a path
  // this template invented, and asserting over it would test the fixture rather
  // than the template.
  const neutral = {
    slug: 'cart-api',
    phase: 2,
    scriptsDir,
    skillId: 'phased-execution',
    reportPath: 'docs/handoffs/cart-api/reports/phase-02-qa.md',
    reportArg: 'reports/phase-02-qa.md',
  } as Facts;

  for (const previous of [undefined, { result: 'fail' }]) {
    const text = qaPrompt({ ...neutral, ...(previous ? { previous } : {}) } as Facts);
    for (const secret of mine) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), 'the brief names this machine');
    }
    // Stronger than a blocklist, and it needs no private strings: the ONLY
    // absolute paths a brief may contain are ones derived from the scripts
    // directory the caller passed in.
    for (const [, path] of text.matchAll(/(?:^|\s)(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g)) {
      const found = path.trim();
      assert.ok(found.startsWith(scriptsDir) || found.startsWith(skillRoot),
        `the brief leaked a path: ${found}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Identity and parsing
 * ------------------------------------------------------------------ */

test('a session is named for the row it reviews', () => {
  assert.equal(qaLabel({ slug: 'alpha', phase: 2 }), 'QA alpha P2');
  assert.ok(qaLabel({ slug: 'x'.repeat(80), phase: 9 }).length <= 60);
});

test('the duplicate key is (slug, phase), and the client agrees with the server', () => {
  assert.equal(qaKey({ slug: 'alpha', phase: 2 }), clientQaKey({ slug: 'alpha', phase: 2 }));
  assert.notEqual(qaKey({ slug: 'alpha', phase: 2 }), qaKey({ slug: 'alpha', phase: 3 }));
  assert.equal(qaKey({}), clientQaKey({}));

  // The two `isVerdict`s must agree too — the client decides whether to render a
  // verdict chip, the server decides whether a session recorded one.
  for (const value of [...QA_RESULTS, 'unknown', undefined]) {
    assert.equal(isVerdict(value), clientIsVerdict(value), String(value));
  }
});

test('liveQa finds only a running session for that exact phase', () => {
  const sessions = [
    { id: 'a', meta: { qa: { slug: 'alpha', phase: 2 } } },
    { id: 'b', exited: { code: 0 }, meta: { qa: { slug: 'alpha', phase: 3 } } },
    { id: 'c', meta: { recovery: { kind: 'x', slug: 'alpha', phase: 4 } } },
  ];
  assert.equal(liveQa(sessions, { slug: 'alpha', phase: 2 })?.id, 'a');
  // Ended is not live — the chip has to turn back into a button.
  assert.equal(liveQa(sessions, { slug: 'alpha', phase: 3 }), undefined);
  // A recovery session is not a review, however much it looks like one.
  assert.equal(liveQa(sessions, { slug: 'alpha', phase: 4 }), undefined);
  assert.equal(liveQa(undefined, { slug: 'alpha', phase: 2 }), undefined);
});

test('a phase nobody has started yet has no diff to review', () => {
  assert.equal(canQa('done'), true);
  assert.equal(canQa('ready'), true);
  assert.equal(canQa('in-progress'), true);
  assert.equal(canQa('waiting'), false);
});

test('the request is validated field by field, and nothing invalid mints', () => {
  const bad = (body: Record<string, unknown>, pattern: RegExp) => {
    const parsed = parseQaRequest(body);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.status, 400);
      assert.match(parsed.error, pattern);
    }
  };

  bad({ phase: 2 }, /needs the slug/);
  bad({ slug: '../etc', phase: 2 }, /not a plan slug/);
  bad({ slug: 'alpha' }, /needs the phase/);
  bad({ slug: 'alpha', phase: 'two' }, /whole number/);
  bad({ slug: 'alpha', phase: 0 }, /whole number/);

  const ok = parseQaRequest({ slug: 'alpha', phase: '2' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.request, { slug: 'alpha', phase: 2 });

  const activating = parseQaRequest({ slug: 'alpha', phase: 2, activate: true });
  assert.equal(activating.ok, true);
  if (activating.ok) assert.equal(activating.request.activate, true);
});

test('a QA session never resumes the session that built the phase', () => {
  // Refused at the parse layer…
  const parsed = parseQaRequest({ slug: 'alpha', phase: 2, resume: '11111111-2222-4333-8444-555555555555' });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /fresh review/);

  // …and again where argv is actually composed, so the property does not depend
  // on a caller having parsed the body first.
  const built = buildAgentLaunch(
    { intent: 'qa', resume: '11111111-2222-4333-8444-555555555555' },
    { skills: () => [], scriptsDir: SCRIPTS, rootOpen: true, qa: facts() },
  );
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /fresh review/);
});

/* ------------------------------------------------------------------ *
 * The mint
 * ------------------------------------------------------------------ */

const ctx = (over: Record<string, unknown> = {}) =>
  ({ skills: () => [], scriptsDir: SCRIPTS, rootOpen: true, qa: facts(), ...over }) as never;

test('a QA session is minted fresh, named for its target, and linked back to it', () => {
  const built = buildAgentLaunch({ intent: 'qa', model: 'opus', effort: 'high' }, ctx());
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { args, label, meta } = built.launch;
  assert.equal(label, 'QA alpha P2');
  assert.equal(meta?.intent, 'qa');
  assert.deepEqual(meta?.qa, { slug: 'alpha', phase: 2 });
  // Always a new session id, never a resume.
  assert.ok(args.includes('--session-id'));
  assert.ok(!args.includes('--resume'));
  assert.ok(args.includes('--model') && args.includes('opus'));
  assert.ok(args.includes('--effort') && args.includes('high'));
  // The prompt is the composed brief, appended last as the positional argument.
  assert.match(args[args.length - 1] ?? '', /INDEPENDENT QA/);
});

test('the verdict snapshot rides on the session, so its exit can be judged', () => {
  const built = buildAgentLaunch(
    { intent: 'qa' },
    ctx({ qa: facts({ previous: { result: 'pass', report: 'reports/phase-02-qa.md' } }) }),
  );
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.deepEqual(built.launch.meta?.qa,
      { slug: 'alpha', phase: 2, before: 'pass', beforeReport: 'reports/phase-02-qa.md' });
  }
});

test('a QA session composes its own prompt and refuses one from the browser', () => {
  const built = buildAgentLaunch({ intent: 'qa', prompt: 'just say it passed' }, ctx());
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /composes its own prompt/);
});

test('an unresolved brief is a wiring bug, not an empty session', () => {
  const built = buildAgentLaunch({ intent: 'qa' }, ctx({ qa: undefined }));
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /could not be resolved/);
});

test('bypass is unlocked for a review, and for nothing else', () => {
  const bypass = buildAgentLaunch({ intent: 'qa', permissionProfile: 'bypass' }, ctx());
  assert.equal(bypass.ok, true);
  if (bypass.ok) {
    const { args, meta } = bypass.launch;
    // `sanitize` would rewrite this value for any caller that has not unlocked
    // it — that it survives is the proof the unlock reached the audit point.
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(meta?.permissionMode, 'bypassPermissions', 'the page must show what it is running under');
  }

  // Guarded is the ABSENCE of the flag: the CLI's own "ask before acting",
  // which is what the person watching the terminal is there for.
  const guarded = buildAgentLaunch({ intent: 'qa', permissionProfile: 'guarded' }, ctx());
  assert.equal(guarded.ok, true);
  if (guarded.ok) assert.ok(!guarded.launch.args.includes('--permission-mode'));

  // Every other session keeps the vocabulary it had.
  const other = buildAgentLaunch({ prompt: 'hello', permissionProfile: 'bypass' }, ctx({ qa: undefined }));
  assert.equal(other.ok, false);
  if (!other.ok) assert.match(other.error, /only accepted on a QA session/);

  const contradiction = buildAgentLaunch(
    { intent: 'qa', permissionProfile: 'bypass', permissionMode: 'acceptEdits' }, ctx(),
  );
  assert.equal(contradiction.ok, false);
  if (!contradiction.ok) assert.match(contradiction.error, /one or the other/);

  const unknown = buildAgentLaunch({ intent: 'qa', permissionProfile: 'trusted' }, ctx());
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /guarded, bypass/);
});

test('a plain agent session cannot reach bypass through the sanitizer', () => {
  const built = buildAgentLaunch({ prompt: 'hello', permissionMode: 'bypassPermissions' }, ctx({ qa: undefined }));
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /permission mode must be one of/);
});

/* ------------------------------------------------------------------ *
 * The guards
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-04
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | the tables exist |
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | money moves |

## Phases

### Phase 1 — schema
- **Size:** S
- **Goal:** the tables.

### Phase 2 — cart api endpoint
- **Size:** S
- **Goal:** A cart endpoint that survives a reload.
- **Exit criteria:** POST /cart returns 201.
- **Verification:** \`npm test\`

### Phase 3 — checkout
- **Size:** S
`;

const handoff = (phase: number, title: string) => `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: complete
completed: 2026-08-01
depends_on: [${phase === 1 ? '' : phase - 1}]
blocks: [${phase + 1}]
key_files:
  - src/cart.ts
memory: project_alpha
---

# Phase ${phase}

## What this phase did
It did the thing.

## State now (verified)
Green.

## Files changed
src/cart.ts

## Key decisions / gotchas
None.

## Outstanding / blockers
None.
`;

/**
 * Services opened against a scratch root, so `cleanup()` can close them.
 *
 * An open Service holds a docs watcher whose re-arm timer keeps the event loop
 * alive, so a test that only deletes the directory leaves `node --test` hanging
 * after the last assertion — and the watcher then re-arms forever against a
 * path that no longer exists. Close first, delete second.
 */
const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(opts: { handoffs?: number[] } = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-qa-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  for (const phase of opts.handoffs ?? []) {
    const title = phase === 2 ? 'cart-api-endpoint' : `phase-${phase}`;
    writeFileSync(
      join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-${title}.md`),
      handoff(phase, title), 'utf8',
    );
  }
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string, over: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true,
    scriptsDir: SCRIPTS, logFile: null, ...over,
  } as never);
  // The push register is the OPERATOR's — an un-stubbed announce in a test
  // sends real notifications to real phones.
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

test('a review is refused while the autopilot is driving', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    // A driving run in the pool, holding a scope the phase under review is
    // inside. Since the runner pool landed, "busy" alone is not the refusal —
    // an overlapping SCOPE is, because a review runs the phase's tests in the
    // tree the run is editing.
    (svc as never as { runners: Map<string, unknown> }).runners.set('alpha', {
      busy: () => true,
      current: () => ({ slug: 'alpha', status: 'running', id: 'run-1' }),
      note: () => {},
      park: () => {},
    });
    // Awaited: `admit` resolves on a microtask even when the scope is free, so
    // firing and forgetting asks about a grant that does not exist yet.
    await (svc as never as {
      scheduler: { admit: (r: unknown) => Promise<unknown> };
    }).scheduler.admit({ slug: 'alpha', phase: 1, runId: 'run-1', scope: ['all'] });

    const refused = await svc.resolveQa({ slug: 'alpha', phase: 2 });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 409);
      assert.match(refused.error, /mid-run/);
      assert.match(refused.error, /pause or stop it/i);
    }
  } finally { cleanup(); }
});

test('a phase still being built cannot be reviewed — that is what independent means', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    (svc as never as { terminals: Record<string, unknown> }).terminals.state = () => ({
      sessions: [{
        id: 'sess-building', label: 'Recover alpha P2', kind: 'claude',
        meta: { intent: 'recovery', recovery: { kind: 'halted-verification', slug: 'alpha', phase: 2 } },
      }],
    });

    const refused = await svc.resolveQa({ slug: 'alpha', phase: 2 });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 409);
      assert.match(refused.error, /being worked on by a live session/);
      assert.equal(refused.sessionId, 'sess-building');
    }

    // A different phase is not being built, and is reviewable.
    const other = await svc.resolveQa({ slug: 'alpha', phase: 1 });
    assert.equal(other.ok, true);
  } finally { cleanup(); }
});

test('a second review of the same phase is refused, and names the first', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    (svc as never as { terminals: Record<string, unknown> }).terminals.state = () => ({
      sessions: [{
        id: 'sess-live', label: 'QA alpha P2', kind: 'claude',
        meta: { intent: 'qa', qa: { slug: 'alpha', phase: 2 } },
      }],
    });

    const refused = await svc.resolveQa({ slug: 'alpha', phase: 2 });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 409);
      assert.match(refused.error, /already running/);
      // The id is what lets the client open it instead of only saying no.
      assert.equal(refused.sessionId, 'sess-live');
    }

    const other = await svc.resolveQa({ slug: 'alpha', phase: 1 });
    assert.equal(other.ok, true);
  } finally { cleanup(); }
});

test('an unknown plan or phase is a 404, not an empty brief', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const svc = service(root);
    const noPlan = await svc.resolveQa({ slug: 'nope', phase: 1 });
    assert.equal(noPlan.ok, false);
    if (!noPlan.ok) assert.equal(noPlan.status, 404);

    const noPhase = await svc.resolveQa({ slug: 'alpha', phase: 9 });
    assert.equal(noPhase.ok, false);
    if (!noPhase.ok) {
      assert.equal(noPhase.status, 404);
      assert.match(noPhase.error, /no phase 9/);
    }
  } finally { cleanup(); }
});

test('the resolved brief is read from the plan and the repository, not from the request', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    const resolved = await svc.resolveQa({ slug: 'alpha', phase: 2 });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    const { facts: f } = resolved;
    assert.equal(f.phaseTitle, 'cart api endpoint');
    assert.equal(f.scriptsDir, SCRIPTS);
    assert.equal(f.reportPath, 'docs/handoffs/alpha/reports/phase-02-qa.md');
    assert.equal(f.reportArg, 'reports/phase-02-qa.md');
    assert.equal(f.handoffPath, 'docs/handoffs/alpha/phase-02-cart-api-endpoint.md');
    assert.equal(f.handoffStatus, 'complete');
    assert.deepEqual(f.keyFiles, ['src/cart.ts']);
    assert.deepEqual(f.board?.map((row) => row.phase), [1, 2, 3]);
    assert.ok(f.exitCriteria?.includes('201'), 'the criteria came from the plan');
    assert.ok(f.verification?.includes('npm test'), 'the Verification block came from the plan');
    assert.equal(f.qaMode, 'off', 'this plan has no test-status.md yet');

    const text = qaPrompt(f);
    assert.ok(text.includes('cart api endpoint'));
    assert.ok(text.includes('reports/phase-02-qa.md'));
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Turning QA on
 * ------------------------------------------------------------------ */

test('activation turns QA on AND waives the phases that finished before it', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    assert.equal((await svc.qaMode('alpha')).mode, 'off');

    const turned = await svc.activateQa('alpha', 2);
    assert.equal(turned.ok, true, turned.detail);
    assert.notEqual(turned.mode, 'off');

    const table = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    // P1 finished before QA existed. Without the backfill, gating turns on
    // plan-wide and P2 — which depends on it — flips ready → waiting: the board
    // would break as a side effect of asking for one review.
    assert.match(table, /\|\s*1\s*\|\s*waived\s*\|/);
    assert.match(table, /\|\s*2\s*\|\s*pending\s*\|/);

    // …and the board still agrees: P3 is the ready one, not held by P1.
    const board = await svc.board('alpha');
    assert.ok(board.done.includes(1), 'P1 is still done');

    // The phase's own handoff was NOT rewritten — the script's refusal to
    // overwrite is what protects it, which is why the exit code is not the
    // verdict here.
    const kept = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-02-cart-api-endpoint.md'), 'utf8');
    assert.match(kept, /It did the thing\./);
  } finally { cleanup(); }
});

test('activation is idempotent and says so rather than writing again', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    const first = await svc.activateQa('alpha', 2);
    assert.equal(first.ok, true, first.detail);

    const again = await svc.activateQa('alpha', 2);
    assert.equal(again.ok, true);
    assert.match(again.detail, /already/);
  } finally { cleanup(); }
});

test('activation is a write, and a read-only console refuses it by name', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root, { allowWrites: false });
    const refused = await svc.activateQa('alpha', 2);
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /--allow-writes/);
  } finally { cleanup(); }
});

test('resolving with activate:true turns QA on before the brief is composed', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    const resolved = await svc.resolveQa({ slug: 'alpha', phase: 2, activate: true });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    // The brief reports the mode the session will actually be gated by.
    assert.notEqual(resolved.facts.qaMode, 'off');
    assert.ok(!qaPrompt(resolved.facts).includes('QA is currently OFF'));
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The verdict, read back
 * ------------------------------------------------------------------ */

function recordQa(root: string, phase: number, result: string, report = '-') {
  const file = join(root, 'docs', 'handoffs', 'alpha', 'test-status.md');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* first row */ }
  if (!text) {
    text = '# QA / test status — alpha\n\n## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n';
  }
  const row = `| ${phase} | ${result} | ${report} |`;
  const pattern = new RegExp(`^\\|\\s*${phase}\\s*\\|.*$`, 'm');
  text = pattern.test(text) ? text.replace(pattern, row) : `${text}${row}\n`;
  writeFileSync(file, text, 'utf8');
}

test('a session that recorded nothing is reported as exactly that', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    const outcome = await svc.qaOutcome({ slug: 'alpha', phase: 2 });
    assert.equal(outcome.recorded, false);
    assert.match(outcome.headline, /no verdict recorded/);
    assert.match(outcome.detail, /without running qa-record\.sh/);
    assert.equal(outcome.result, undefined);
  } finally { cleanup(); }
});

test('a phase that already read pass is never re-announced as a pass', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    recordQa(root, 2, 'pass', 'reports/phase-02-qa.md');

    // The session was minted when the row already said pass, and recorded
    // nothing. The lazier check — "is there a verdict?" — would announce a pass
    // this session did not earn.
    const outcome = await svc.qaOutcome({
      slug: 'alpha', phase: 2, before: 'pass', beforeReport: 'reports/phase-02-qa.md',
    });
    assert.equal(outcome.recorded, false);
    assert.match(outcome.headline, /no verdict recorded/);
    assert.match(outcome.detail, /exactly as it did before/);
  } finally { cleanup(); }
});

test('a recorded fail is reported as the gate it is', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    recordQa(root, 2, 'fail', 'reports/phase-02-qa.md');

    const outcome = await svc.qaOutcome({ slug: 'alpha', phase: 2 });
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.result, 'fail');
    assert.equal(outcome.report, 'reports/phase-02-qa.md');
    assert.match(outcome.detail, /stays gated/);
  } finally { cleanup(); }
});

test('a re-review that lands the same verdict on a new report still counts', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    recordQa(root, 2, 'fail', 'reports/phase-02-qa-2.md');

    const outcome = await svc.qaOutcome({
      slug: 'alpha', phase: 2, before: 'fail', beforeReport: 'reports/phase-02-qa.md',
    });
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.result, 'fail');
  } finally { cleanup(); }
});

test('a pending row is not a verdict', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    recordQa(root, 2, 'pending');
    const outcome = await svc.qaOutcome({ slug: 'alpha', phase: 2 });
    assert.equal(outcome.recorded, false);
    assert.match(outcome.headline, /no verdict recorded/);
  } finally { cleanup(); }
});

test('the outcome is read fresh, past the debounced watcher', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const svc = service(root);
    // Warm every cache the way a page load would.
    await svc.detail('alpha');
    assert.equal((await svc.qaOutcome({ slug: 'alpha', phase: 2 })).recorded, false);

    // The session's last write lands milliseconds before its process exits —
    // the watcher has not fired, and every engine answer is cached by revision.
    recordQa(root, 2, 'pass', 'reports/phase-02-qa.md');

    const outcome = await svc.qaOutcome({ slug: 'alpha', phase: 2 });
    assert.equal(outcome.recorded, true, 'the exit check judged a stale table');
    assert.equal(outcome.result, 'pass');
  } finally { cleanup(); }
});
