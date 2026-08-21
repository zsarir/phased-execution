/**
 * The automation preferences — the opening values for every launch surface.
 *
 * Two properties carry the feature. A config written before these keys existed
 * must read as the documented defaults (skills off, QA off, default branch, PR
 * on, guard on) — silence is never a behaviour change. And the save path takes
 * its patch straight off an HTTP body, so it must be an allowlist: a client can
 * flip the knobs this type has, and nothing else, with a mistyped value dropped
 * rather than stored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-prefs-state-'));
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-prefs-config-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { loadPrefs, sanitiseAutomation, SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

const CONFIG_FILE = join(CONFIG_HOME, 'phase-console', 'config.json');

function writeConfig(body: unknown): void {
  mkdirSync(join(CONFIG_HOME, 'phase-console'), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

test.after(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
  rmSync(CONFIG_HOME, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Loading: a config from before the feature, and a config with typos
 * ------------------------------------------------------------------ */

test('a config written before the automation keys existed reads as the defaults', () => {
  writeConfig({ theme: 'dark', sort: 'name' });
  const prefs = loadPrefs();
  assert.equal(prefs.attachDefaultSkills, false, 'attaching extra skills is opt-in');
  assert.equal(prefs.qaByDefault, false, 'QA is opt-in');
  assert.equal(prefs.gitMode, 'default-branch');
  assert.equal(prefs.openPrOnComplete, true);
  assert.equal(prefs.repoGuard, true, 'the guard is the safe state and must be the silent one');
  // And the keys it did have survive.
  assert.equal(prefs.theme, 'dark');
  assert.equal(prefs.sort, 'name');
});

test('a typo in config.json can never mint branches or drop the guard', () => {
  writeConfig({
    gitMode: 'new-brunch', attachDefaultSkills: 'yes', qaByDefault: 1,
    openPrOnComplete: 'no', repoGuard: 0,
  });
  const prefs = loadPrefs();
  assert.equal(prefs.gitMode, 'default-branch', 'only the exact literal means new-branch');
  assert.equal(prefs.attachDefaultSkills, false);
  assert.equal(prefs.qaByDefault, false);
  assert.equal(prefs.openPrOnComplete, true);
  assert.equal(prefs.repoGuard, true);
});

test('stored choices load back as stored', () => {
  writeConfig({ gitMode: 'new-branch', attachDefaultSkills: true, repoGuard: false });
  const prefs = loadPrefs();
  assert.equal(prefs.gitMode, 'new-branch');
  assert.equal(prefs.attachDefaultSkills, true);
  assert.equal(prefs.repoGuard, false);
});

test('sanitiseAutomation is the single coercion table', () => {
  assert.deepEqual(sanitiseAutomation({}), {
    attachDefaultSkills: false, qaByDefault: false, gitMode: 'default-branch',
    openPrOnComplete: true, repoGuard: true,
    autoRecoverByDefault: true, autoContinueRecovery: true,
    mcpPolicy: 'continue',
    ladderPerPhaseRungs: 3, ladderPerPhaseUsd: 100, ladderPerRunRungs: 10, ladderPerRunUsd: 400, ladderPerDayUsd: 600,
    unblockAttempts: true, staleClaimTakeover: true, resumeAtBoot: true, autoAccountSwitch: true,
    convergeEveryMs: 300_000,
    budgetAutoRaisePct: 25, mcpRequireTimeoutMs: 1_800_000,
  });
  // Ladder caps: a finite non-negative number or the default — a string, a
  // negative or NaN must never make the ladder unbounded (or zero).
  assert.equal(sanitiseAutomation({ ladderPerPhaseUsd: 25 }).ladderPerPhaseUsd, 25);
  // The resource ladder's two numbers follow the same rule; zero is a valid
  // "off" for both (no raise; wait on `require` indefinitely).
  assert.equal(sanitiseAutomation({ budgetAutoRaisePct: 0 }).budgetAutoRaisePct, 0, 'zero is a valid "no raise"');
  assert.equal(sanitiseAutomation({ budgetAutoRaisePct: '50' } as never).budgetAutoRaisePct, 25);
  assert.equal(sanitiseAutomation({ mcpRequireTimeoutMs: 60_000 }).mcpRequireTimeoutMs, 60_000);
  assert.equal(sanitiseAutomation({ mcpRequireTimeoutMs: -5 }).mcpRequireTimeoutMs, 1_800_000);
  assert.equal(sanitiseAutomation({ ladderPerPhaseUsd: '25' } as never).ladderPerPhaseUsd, 100);
  assert.equal(sanitiseAutomation({ ladderPerRunRungs: -1 }).ladderPerRunRungs, 10);
  assert.equal(sanitiseAutomation({ ladderPerDayUsd: Number.NaN }).ladderPerDayUsd, 600);
  assert.equal(sanitiseAutomation({ convergeEveryMs: 0 }).convergeEveryMs, 0, 'zero is a valid "timer off"');
  assert.equal(sanitiseAutomation({ unblockAttempts: false }).unblockAttempts, false);
  assert.equal(sanitiseAutomation({ staleClaimTakeover: 'no' } as never).staleClaimTakeover, true);
  assert.equal(sanitiseAutomation({ gitMode: 'new-branch' }).gitMode, 'new-branch');
  // The recovery automation defaults are ON, and a typo cannot turn them off.
  assert.equal(sanitiseAutomation({ autoRecoverByDefault: 'no' } as never).autoRecoverByDefault, true);
  assert.equal(sanitiseAutomation({ autoContinueRecovery: false }).autoContinueRecovery, false);
});

test('only the exact word require can make an MCP server able to stop a plan', () => {
  // The same fail-safe direction as `gitMode`, pointing the other way: there,
  // only the exact literal may mint a branch; here, only the exact literal may
  // park a run. A config nobody edited, and a config somebody fat-fingered,
  // both keep plans moving.
  assert.equal(sanitiseAutomation({}).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'require' }).mcpPolicy, 'require');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'Require' } as never).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'required' } as never).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: true } as never).mcpPolicy, 'continue');
});

test('a config written before the MCP policy existed reads as continue', () => {
  // The behaviour change this release is a DEFAULT moving, so the upgrade path
  // is the thing most worth pinning: an operator who never opens Settings gets
  // the new behaviour, and gets it without a migration.
  writeConfig({ theme: 'dark', repoGuard: true });
  assert.equal(loadPrefs().mcpPolicy, 'continue');
});

/* ------------------------------------------------------------------ *
 * Saving: the patch is an HTTP body, so the merge is an allowlist
 * ------------------------------------------------------------------ */

function makeService() {
  return new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
}

test('savePreferences flips the knobs it knows and drops everything else', () => {
  writeConfig({});
  const service = makeService();
  try {
    const saved = service.savePreferences({
      qaByDefault: true,
      gitMode: 'new-branch',
      repoGuard: false,
      // None of these may land: wrong type, wrong value, unknown key.
      attachDefaultSkills: 'yes',
      openPrOnComplete: 'sure',
      somethingElse: { nested: true },
    } as never);
    assert.equal(saved.qaByDefault, true);
    assert.equal(saved.gitMode, 'new-branch');
    assert.equal(saved.repoGuard, false);
    assert.equal(saved.attachDefaultSkills, false, 'a mistyped value is dropped, not stored');
    assert.equal(saved.openPrOnComplete, true);
    assert.ok(!('somethingElse' in saved), 'unknown keys never reach config.json');
    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    assert.ok(!('somethingElse' in onDisk));
    assert.equal(onDisk.gitMode, 'new-branch');
  } finally {
    service.close();
  }
});

test('mcpPolicy round-trips through savePreferences, and a bad one is dropped', () => {
  writeConfig({});
  const service = makeService();
  try {
    assert.equal(service.savePreferences({ mcpPolicy: 'require' }).mcpPolicy, 'require');
    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.mcpPolicy, 'require');
    // Dropped means dropped: the stored choice survives a patch that says
    // nothing valid, rather than silently reverting to the default.
    assert.equal(service.savePreferences({ mcpPolicy: 'always' } as never).mcpPolicy, 'require');
    assert.equal(service.savePreferences({ mcpPolicy: 'continue' }).mcpPolicy, 'continue');
  } finally {
    service.close();
  }
});

test('a bad gitMode in a patch keeps the stored one — dropped means dropped', () => {
  writeConfig({ gitMode: 'new-branch' });
  const service = makeService();
  try {
    const saved = service.savePreferences({ gitMode: 'main' } as never);
    assert.equal(saved.gitMode, 'new-branch', 'the stored value survives a bad patch');
  } finally {
    service.close();
  }
});

test('an automation patch leaves the notify map alone', () => {
  writeConfig({});
  const service = makeService();
  try {
    const before = { ...service.savePreferences({}).notify };
    const after = service.savePreferences({ repoGuard: false }).notify;
    assert.deepEqual(after, before, 'flipping a knob must not reset notification categories');
  } finally {
    service.close();
  }
});
