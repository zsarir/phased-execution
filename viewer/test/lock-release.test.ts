/**
 * The stale claim, and the owner nobody could see.
 *
 * Three phases on this operator's board had been reading "taken" for between
 * twenty and thirty-one days — `alpha` P1, `beta`
 * P2, `gamma` P8 — and every one of them was releasable the
 * whole time. `writes.ts` has had a `lock-release` verb since the write layer
 * existed. What it could not do was *name the owner*: `phase-lock.sh release`
 * refuses unless `--owner` matches, and the owner lives in the lock file, which
 * no page showed. So the console asked a person to retype
 * `sam.doe@example.com/opus-p2` from memory, and offered "Claim phase"
 * instead — which takes the phase rather than freeing it.
 *
 * The fix is one line of insight: the file already knows. These tests pin the
 * consequences of that — including the two that keep it safe. A lease that has
 * not run out is someone working and is refused; and the owner still has to
 * match at release time, so this reads the lock rather than bypassing it.
 *
 * Everything here runs against a scratch docs root and the **real**
 * `phase-lock.sh`. A test that mocked the script would prove the console can
 * compose an argv, which was never in doubt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every state-dir consumer this pulls in reads these at module load, so they
// have to be redirected before the imports below.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-locks-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { lockPath, readLock } = await import('../server/store.ts');
const { planWrite, WriteError } = await import('../server/writes.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: true,
  scriptsDir: SCRIPTS, logFile: null,
};

const PLAN = `---
slug: SLUG
created: 2026-08-04
status: active
phases: 2
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | it works |
| 2 | second | 1 | — | app | it still works |

## Phases

### Phase 1 — first
- **Size:** S

### Phase 2 — second
- **Size:** S
`;

/** A docs root with plans, handoff folders and hand-written lock files. */
function scratchDocs(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-locks-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addPlan(root: string, slug: string): void {
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug), 'utf8');
}

/** An INDEX with no plan file — the shape both orphan folders on the real board have. */
function addOrphanHandoffs(root: string, slug: string): void {
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'INDEX.md'), `# Handoffs — ${slug}\n`, 'utf8');
}

/** Write a lock exactly as `phase-lock.sh claim` does: `key=value`, epoch seconds. */
function claim(root: string, slug: string, phase: number, owner: string, leaseFromNowS: number): string {
  const dir = join(root, 'docs', 'handoffs', slug, '.locks');
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), slug, phase);
  writeFileSync(file, [
    `slug=${slug}`,
    `phase=${phase}`,
    `owner=${owner}`,
    'host=test',
    `claimed_at=${now - 60}`,
    `lease_until=${now + leaseFromNowS}`,
    '',
  ].join('\n'), 'utf8');
  return file;
}

function service(root: string) {
  const svc = new Service(flags as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, 'the scratch docs root should open');
  return svc;
}

/* ------------------------------------------------------------------ *
 * Reading the owner off the disk
 * ------------------------------------------------------------------ */

test('a lock is read from the file, not from the scan', () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    claim(root, 'demo', 2, 'sam.doe@example.com/opus-p2', -3600);
    const handoffs = join(root, 'docs', 'handoffs');

    const lock = readLock(handoffs, 'demo', 2)!;
    assert.equal(lock.owner, 'sam.doe@example.com/opus-p2');
    assert.equal(lock.expired, true);
    // Two-padded, exactly as the script writes it.
    assert.ok(lockPath(handoffs, 'demo', 2).endsWith(join('.locks', 'phase-02.lock')));
    assert.ok(lockPath(handoffs, 'demo', 100).endsWith(join('.locks', 'phase-100.lock')));

    // An unclaimed phase is null, not a throw — "no lock" is the ordinary case.
    assert.equal(readLock(handoffs, 'demo', 1), null);
  } finally { cleanup(); }
});

test('the owners on the real board pass the write layer without being retyped', () => {
  // Both of these were on the operator's dashboard, and both contain characters
  // a stricter owner pattern would have rejected — which would have made the
  // whole feature useless for the exact locks it was built for.
  for (const owner of ['sam.doe@example.com/opus-p2', 'ops@example.org/opus-p8-session']) {
    const plan = planWrite({ action: 'lock-release', slug: 'demo', phase: 2, owner }, { root: '/x' });
    assert.deepEqual(plan.args, ['demo', 'release', '2', '--owner', owner]);
  }
  assert.throws(
    () => planWrite({ action: 'lock-release', slug: 'demo', phase: 2, owner: 'nobody' }, { root: '/x' }),
    WriteError,
  );
});

/* ------------------------------------------------------------------ *
 * Releasing, for real
 * ------------------------------------------------------------------ */

test('an expired claim is released without anyone typing an owner', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    const file = claim(root, 'demo', 2, 'sam.doe@example.com/opus-p2', -86_400);
    const svc = service(root);
    try {
      const result = await svc.releaseLock('demo', 2);
      assert.equal(result.ok, true);
      assert.equal(result.owner, 'sam.doe@example.com/opus-p2');
      assert.equal(existsSync(file), false, 'the lock file should be gone');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a live lease is refused, and the phase stays claimed', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    const file = claim(root, 'demo', 1, 'someone/working', 1800);
    const svc = service(root);
    try {
      const result = await svc.releaseLock('demo', 1);
      assert.equal(result.ok, false);
      assert.equal(result.owner, 'someone/working');
      assert.match(result.detail!, /still working/);
      assert.equal(existsSync(file), true, 'a live claim must survive a refusal');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a phase nobody claimed reports free rather than failing', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    const svc = service(root);
    try {
      const result = await svc.releaseLock('demo', 1);
      // A bulk release can race with a script releasing the same lock; "it is
      // already gone" is the outcome that was wanted, not an error.
      assert.equal(result.ok, true);
      assert.equal(result.owner, null);
      assert.equal(result.detail, 'already free');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('an orphan handoff folder with no plan file releases cleanly', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    // `gamma` and `beta` are both this
    // shape on the real board: a handoff folder, a stale lock, and no plan.
    addOrphanHandoffs(root, 'gamma');
    const file = claim(root, 'gamma', 8, 'ops@example.org/opus-p8-session', -86_400);
    const svc = service(root);
    try {
      const result = await svc.releaseLock('gamma', 8);
      assert.equal(result.ok, true, result.detail);
      assert.equal(existsSync(file), false);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('writes off means no release at all', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    const file = claim(root, 'demo', 2, 'someone/stale', -86_400);
    const svc = new Service({ ...flags, allowWrites: false } as never);
    svc.open(root);
    try {
      await assert.rejects(() => svc.releaseLock('demo', 2), /--allow-writes/);
      assert.equal(existsSync(file), true);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * All of them at once
 * ------------------------------------------------------------------ */

test('bulk release clears every stale claim and reports each one', async () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'alpha');
    addPlan(root, 'beta');
    addOrphanHandoffs(root, 'gamma');

    const stale = [
      claim(root, 'alpha', 1, 'a/one', -86_400),
      claim(root, 'beta', 2, 'b/two', -3600),
      claim(root, 'gamma', 8, 'c/three', -2_600_000),
    ];
    const live = claim(root, 'alpha', 2, 'someone/working', 1800);

    const svc = service(root);
    try {
      const results = await svc.releaseExpiredLocks();
      assert.equal(results.length, 3, 'one result per expired lock, and only expired ones');
      assert.ok(results.every((r) => r.ok), JSON.stringify(results));
      // Each result names its own lock — a single "3 released" would hide a
      // refusal in the middle of a batch.
      assert.deepEqual(
        results.map((r) => `${r.slug}/${r.phase}/${r.owner}`).sort(),
        ['alpha/1/a/one', 'beta/2/b/two', 'gamma/8/c/three'].sort(),
      );
      for (const file of stale) assert.equal(existsSync(file), false, `${file} should be released`);
      assert.equal(existsSync(live), true, 'the live claim is not stale and must survive');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('the release goes through the script, so a re-claim in between is refused', () => {
  const { root, cleanup } = scratchDocs();
  try {
    addPlan(root, 'demo');
    const file = claim(root, 'demo', 1, 'first/owner', -86_400);
    // What a release with a *stale reading* of the owner does: the console read
    // `first/owner`, someone re-claimed as `second/owner`, and the script — not
    // the console — is what refuses. This is why the owner is passed rather
    // than the release being forced.
    claim(root, 'demo', 1, 'second/owner', 1800);
    assert.throws(() => execFileSync('bash', [
      join(SCRIPTS, 'phase-lock.sh'), 'demo', 'release', '1', '--owner', 'first/owner',
    ], { cwd: root, env: { ...process.env, DOCS_ROOT: root }, stdio: 'pipe' }));
    assert.match(readFileSync(file, 'utf8'), /owner=second\/owner/);
  } finally { cleanup(); }
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));
