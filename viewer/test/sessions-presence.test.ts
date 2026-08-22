/**
 * Session presence, end to end through the service.
 *
 * Pinned: the `/hooks/session` route (loopback only, validated, rate-limited,
 * feeding the registry the `GET /api/sessions/registry` reads back with the
 * plan+phase correlated through the lock's `session=`); a person's lock whose
 * session the hook reports ENDED is released by the convergence loop on the
 * change trigger — lease or no lease — while a live one stays; a declared
 * outcome from a session nobody here spawned (`phase-outcome.sh` with no
 * `PE_OUTCOME_FILE`, the real script) is picked up from the inbox and parks
 * the phase `waiting` on a run with the resume armed; and the hook installer
 * routes. Nothing spawns `claude`: the resume window is in the future.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service, HOOK_EVENTS_PER_MINUTE } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { lockPath, readLock } = await import('../server/store.ts');
const { latestRun, journalFile } = await import('../server/runner/state.ts');
const { inboxOutcomeFile } = await import('../server/runner/outcome.ts');
const { instanceId } = await import('../shared/instances.mjs');

const SCRIPTS = join(SKILL_DIR, 'scripts');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-presence-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

function handoff(root: string, phase: number, title: string, status: string): void {
  const pad = String(phase).padStart(2, '0');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-${pad}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase} — ${title}
`, 'utf8');
}

/** A lock exactly as `phase-lock.sh claim --session` writes it. */
function claim(root: string, phase: number, owner: string, leaseFromNowS: number, session?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), 'alpha', phase);
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha', '.locks'), { recursive: true });
  writeFileSync(file, [
    'slug=alpha', `phase=${phase}`, `owner=${owner}`, 'host=test', `claimed_at=${now - 60}`, `lease_until=${now + leaseFromNowS}`,
    'scope=app', ...(session ? [`session=${session}`] : []), '',
  ].join('\n'), 'utf8');
  return file;
}

function service(root: string, flags: Record<string, unknown> = {}, before?: (svc: InstanceType<typeof Service>) => void) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true, remoteHosts: [], remoteUsers: [], ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  before?.(svc);
  assert.equal(svc.open(root).ok, true);
  return svc;
}

async function settle(svc: InstanceType<typeof Service>): Promise<void> {
  await svc.bootSettled;
  await svc.converger.idle();
}

/** A request through the real `handleApi`, from a given socket address. */
async function call(
  svc: InstanceType<typeof Service>, method: string, path: string,
  body?: unknown, opts: { remote?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; payload: unknown }> {
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: { host: '127.0.0.1:4123', 'content-type': 'application/json', ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (raw) yield Buffer.from(raw); },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return { status, payload };
}

/**
 * Write an inbox file the way the only thing that really writes one does.
 *
 * `phase-outcome.sh` is tmp+`mv` (line 220), and that is not decoration: the
 * watcher debounces 250 ms per path and then READS, so a plain `writeFileSync`
 * can be seen at zero length, parsed as junk, and consumed — the declaration
 * gone before the runner is handed it. macOS coalesces the create and the write
 * inside one FSEvents window and hides it; Linux inotify does not, which is why
 * this only ever failed on the ubuntu leg of CI.
 */
const writeInbox = (file: string, body: string): void => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, file);
};

/**
 * Wait for something a FILE WATCHER has to notice — an inbox outcome consumed, a
 * lock released, a run minted from a declaration.
 *
 * The default is generous on purpose. Every one of these waits on the OS to
 * deliver a filesystem event and on a debounce to fire, and under a full
 * parallel suite on a shared CI runner that has been measured well past four
 * seconds — which is how a release-blocking failure appeared here ("handed to
 * the live runner") on a path this change set never touched, in a suite that
 * passes locally every time. Two call sites below had already been bumped to 6s
 * one at a time; this fixes the shape rather than the next symptom.
 *
 * A generous ceiling costs nothing when the condition is met — the loop returns
 * on the first check that passes.
 */
const poll = async (check: () => boolean, ms = 20_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

/* ------------------------------------------------------------------ *
 * The route and the registry
 * ------------------------------------------------------------------ */

test('POST /hooks/session: loopback only, validated, fed to the registry; GET /api/sessions/registry reads it back with the plan+phase the lock names', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      claim(root, 2, 'sam@laptop', 3600, 's-hand');
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);

      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-hand', event: 'SessionStart', cwd: root, user: 'sam', host: 'laptop', source: 'startup', at: new Date().toISOString(),
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));
      assert.deepEqual(started.payload, { ok: true, session: { sessionId: 's-hand', presence: 'live' } });

      const list = await call(svc, 'GET', '/api/sessions/registry');
      assert.equal(list.status, 200);
      const sessions = (list.payload as { sessions: { sessionId: string; presence: string; plan?: { slug: string; phase: number; strong: boolean }; kind: string }[] }).sessions;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].sessionId, 's-hand');
      assert.equal(sessions[0].presence, 'live');
      assert.equal(sessions[0].kind, 'foreign');
      assert.deepEqual(sessions[0].plan, { slug: 'alpha', phase: 2, strong: true });

      // Not a session event → 400; not from this machine → 403; GET → 405.
      assert.equal((await call(svc, 'POST', '/hooks/session', { hello: 'world' })).status, 400);
      assert.equal((await call(svc, 'POST', '/hooks/session', { session_id: 'x', event: 'Stop', cwd: root }, { remote: '100.64.0.7' })).status, 403);
      assert.equal((await call(svc, 'GET', '/hooks/session')).status, 405);
      // The bucket: far more events than a person's sessions produce answer 429.
      let last = 200;
      for (let i = 0; i < HOOK_EVENTS_PER_MINUTE + 5 && last === 200; i++) {
        last = (await call(svc, 'POST', '/hooks/session', { session_id: 'flood', event: 'Stop', cwd: root })).status;
      }
      assert.equal(last, 429);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Presence → the lock
 * ------------------------------------------------------------------ */

test('a person\'s lock whose session the hook reports ENDED is released by the convergence loop at once; a live one stays', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      // Two hand-driven sessions, each holding its phase with an unexpired lease.
      const gone = claim(root, 2, 'sam@laptop', 3600, 's-gone');
      const live = claim(root, 3, 'kim@desk', 3600, 's-live');
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);
      for (const [id, user] of [['s-gone', 'sam'], ['s-live', 'kim']] as const) {
        svc.ingestSessionEvent({ session_id: id, event: 'SessionStart', cwd: root, user, host: 'laptop', source: 'startup' });
      }
      assert.equal(svc.sessions.presenceOfLock(readLock(join(root, 'docs', 'handoffs'), 'alpha', 2)!), 'live');
      // The converge loop needs a run of the plan to act on; a stopped one will do.
      const { newRun, saveRun, phaseRecord } = await import('../server/runner/state.ts');
      const state = newRun({ slug: 'alpha', root, autoRecover: false });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'x' };
      Object.assign(phaseRecord(state, 2), { status: 'failed', attempts: 1 });
      saveRun(state);

      // SessionEnd for the first: its lock is debris NOW.
      svc.ingestSessionEvent({ session_id: 's-gone', event: 'SessionEnd', cwd: root, reason: 'other' });
      assert.equal(svc.sessions.presence('s-gone'), 'ended');
      assert.ok(await poll(() => !existsSync(gone), 6_000), 'the ended session\'s lock is released by converge on the change trigger');
      await svc.converger.idle();
      assert.ok(existsSync(live), 'the live session\'s lock stays');
      // Journalled on the plan's latest run, naming the session.
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      const released = lines.find((l) => l.event === 'run.lock-debris-released');
      assert.ok(released, 'journalled');
      assert.equal(released!.data.owner, 'sam@laptop');
      assert.equal(released!.data.session, 's-gone');
      assert.equal(released!.data.by, 'converge');
      // The scheduler reads the same verdict through its presence dep: a foreign lock on phase 3 (live) blocks; phase 2's is gone.
      const evidence = await svc.classifyPhase('alpha', 3, null, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.situation.id, 'foreign-live');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Unsupervised outcomes
 * ------------------------------------------------------------------ */

test('phase-outcome.sh from a shell with no PE_OUTCOME_FILE lands in the inbox; the console parks the phase waiting on a run with the resume armed', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      assert.equal(latestRun(root, 'alpha'), null, 'no run yet — a person is driving phase 2 by hand');
      // The real script, the real identity rule: no PE_OUTCOME_FILE, DOCS_ROOT = the repo, XDG_STATE_HOME = the sandbox.
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-hand' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      const out = execFileSync('/bin/bash', [join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'waiting-external', '--wait-minutes', '45', '--reason', 'image build', '--watch', 'gh:x#run/1'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(out, /"session_id": "s-hand"/);
      const expected = inboxOutcomeFile(root, 'alpha', 2);
      assert.equal(expected.includes(instanceId(root)), true);
      // Picked up (by the watcher, or the boot scan had it been written before) and consumed.
      assert.ok(await poll(() => !existsSync(expected) && latestRun(root, 'alpha') !== null, 6_000), 'the inbox file is consumed and a run exists');
      const state = latestRun(root, 'alpha')!;
      const rec = state.phases['2'];
      assert.equal(rec.status, 'waiting');
      assert.equal(rec.parkReason, 'image build');
      assert.deepEqual(rec.watch, ['gh:x#run/1']);
      assert.equal(rec.resumeSessionId, 's-hand', 'THAT session is what resumes');
      assert.ok(rec.parkedUntil && Date.parse(rec.parkedUntil) > Date.now() + 30 * 60_000, 'parked on the declared window');
      assert.equal(state.status, 'paused');
      assert.equal(state.stoppedBy, 'system');
      assert.equal(state.waitUntil, rec.parkedUntil);
      assert.deepEqual(state.onlyPhases, [2], 'scoped to the phase the person declared');
      // The resume is armed on the service's own clock (restart-safe: `readoptQueued` re-arms a paused+waitUntil run).
      const timers = (svc as unknown as { limitResumeTimers: Map<string, unknown> }).limitResumeTimers;
      assert.ok(timers.has('alpha'), 'armLimitResume armed for the window');
      // The declaration is the classifier's evidence for the phase.
      const { evidence, situation } = await svc.classifyPhase('alpha', 2, state, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.declared?.status, 'waiting-external');
      assert.equal(situation.id, 'waiting-external');
      // Journalled on the run it created.
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      assert.ok(lines.some((l) => l.event === 'phase.outcome' && l.data.by === 'unsupervised' && l.data.sessionId === 's-hand'));
      assert.ok(lines.some((l) => l.event === 'run.waiting-external'));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a stale or invalid inbox file is consumed and changes nothing; a live runner gets the declaration through its own verb', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      const file = inboxOutcomeFile(root, 'alpha', 2);
      mkdirSync(join(file, '..'), { recursive: true });
      writeInbox(file, JSON.stringify({ version: 1, slug: 'alpha', phase: 2, status: 'waiting-external', watch: [], written_at: '2020-01-01T00:00:00Z' }));
      assert.ok(await poll(() => !existsSync(file)), 'consumed');
      assert.equal(latestRun(root, 'alpha'), null, 'a declaration from 2020 is history');
      writeInbox(file, 'not json');
      assert.ok(await poll(() => !existsSync(file)), 'junk consumed too');
      assert.equal(latestRun(root, 'alpha'), null);
      // A live runner: the declaration goes through `declareOutcome`.
      const declared: unknown[] = [];
      (svc as unknown as { runners: Map<string, unknown> }).runners.set('alpha', {
        busy: () => true,
        current: () => ({ id: 'r1', slug: 'alpha' }),
        declareOutcome: (phase: number, outcome: unknown, by: string) => { declared.push({ phase, outcome, by }); return 'parked'; },
        noteDocsChanged: () => {},
      });
      writeInbox(file, JSON.stringify({ version: 1, slug: 'alpha', phase: 2, status: 'partial', reason: 'budget', watch: [], written_at: new Date().toISOString(), session_id: 's-hand' }));
      assert.ok(await poll(() => declared.length === 1), 'handed to the live runner');
      assert.deepEqual(declared[0], { phase: 2, outcome: { version: 1, slug: 'alpha', phase: 2, status: 'partial', reason: 'budget', watch: [], written_at: (declared[0] as { outcome: { written_at: string } }).outcome.written_at, session_id: 's-hand' }, by: 'unsupervised' });
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The installer routes
 * ------------------------------------------------------------------ */

test('GET/POST /api/hooks-install: status, install, uninstall — behind --allow-writes, against CLAUDE_CONFIG_DIR', async () => {
  const { root, cleanup } = scratch();
  const conf = mkdtempSync(join(tmpdir(), 'pc-conf-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = conf;
  try {
    gitInit(root);
    writeFileSync(join(conf, 'settings.json'), '{\n  "model": "opus"\n}\n', 'utf8');
    const svc = service(root);
    try {
      await settle(svc);
      const before = await call(svc, 'GET', '/api/hooks-install');
      assert.equal(before.status, 200);
      assert.equal((before.payload as { installed: boolean; path: string }).installed, false);
      assert.equal((before.payload as { path: string }).path, join(conf, 'settings.json'));
      // A POST without the console header is refused like every other mutation.
      assert.equal((await call(svc, 'POST', '/api/hooks-install', { action: 'install' })).status, 403);
      const headers = { 'x-phase-console': '1' };
      const installed = await call(svc, 'POST', '/api/hooks-install', { action: 'install' }, { headers });
      assert.equal(installed.status, 200, JSON.stringify(installed.payload));
      assert.equal((installed.payload as { status: { installed: boolean } }).status.installed, true);
      const text = readFileSync(join(conf, 'settings.json'), 'utf8');
      assert.match(text, /^ {2}"model": "opus",\n {2}"hooks": \{/m);
      const written = JSON.parse(text) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      assert.equal(written.hooks.SessionStart.at(-1)!.hooks[0].command, `bash "${SKILL_DIR}/scripts/session-hook.sh"`);
      assert.equal((await call(svc, 'POST', '/api/hooks-install', { action: 'nonsense' }, { headers })).status, 400);
      const removed = await call(svc, 'POST', '/api/hooks-install', { action: 'uninstall' }, { headers });
      assert.equal(removed.status, 200);
      assert.equal(readFileSync(join(conf, 'settings.json'), 'utf8'), '{\n  "model": "opus"\n}\n', 'byte-identical after uninstall');
    } finally { svc.close(); }
    // Without --allow-writes the write is refused and the file untouched.
    const ro = service(root, { allowWrites: false });
    try {
      await settle(ro);
      assert.equal((await call(ro, 'POST', '/api/hooks-install', { action: 'install' }, { headers: { 'x-phase-console': '1' } })).status, 403);
      assert.equal(readFileSync(join(conf, 'settings.json'), 'utf8'), '{\n  "model": "opus"\n}\n');
    } finally { ro.close(); }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(conf, { recursive: true, force: true });
    cleanup();
  }
});
