/**
 * The model vocabulary must mean the same thing to bash and to the console.
 *
 * `scripts/models.env` is an F5-style single source, like `sizing.env`,
 * `mcp.env` and `verify.env` before it: `phase-graph.sh` sources the file and
 * `server/runner/models.ts` regex-parses the same lines. Two readers of one
 * file drift the moment one of them is edited alone, and the drift is silent —
 * the board sizes a plan's sessions with one answer while the runner boards
 * them with another.
 *
 * This suite pins three things to each other: the FILE, the JS reader, and the
 * hardcoded fallback the reader falls back to when it is driving an older
 * scripts directory. It also pins the two behaviours the vocabulary exists to
 * get right — that a `[1m]` variant is its base model for every purpose except
 * the budget, and that a door accepts every spelling the CLI accepts.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import {
  MODELS_ENV_FALLBACK, budgetClassOf, canonicalModelId, is1m, isKnownModel,
  loadModelsEnv, modelFamily, offeredModels,
} from '../server/runner/models.ts';
import { MODEL_FALLBACK, nextModel, fallbackChain } from '../server/runner/errors.ts';
import { loadSizing, resolveBudget } from '../server/analysis/graph.ts';

const scripts = join(SKILL_DIR, 'scripts');

test('the shipped fallback is identical to scripts/models.env', () => {
  const file = loadModelsEnv(scripts);
  assert.deepEqual([...file.aliases], [...MODELS_ENV_FALLBACK.aliases]);
  assert.deepEqual([...file.ids.entries()].sort(), [...MODELS_ENV_FALLBACK.ids.entries()].sort());
  assert.deepEqual([...file.modes].sort(), [...MODELS_ENV_FALLBACK.modes].sort());
  assert.deepEqual([...file.big].sort(), [...MODELS_ENV_FALLBACK.big].sort());
  assert.deepEqual([...file.oneMCapable], [...MODELS_ENV_FALLBACK.oneMCapable]);
  assert.equal(file.oneM, MODELS_ENV_FALLBACK.oneM);
});

test('every key the reader looks for is actually present in the file', () => {
  const text = readFileSync(join(scripts, 'models.env'), 'utf8');
  for (const key of ['MODEL_ALIASES', 'MODEL_IDS', 'MODEL_MODES', 'MODEL_1M_SUFFIX',
    'MODEL_1M_CAPABLE', 'MODEL_BIG']) {
    assert.match(text, new RegExp(`^${key}="`, 'm'), `${key} is missing from models.env`);
  }
});

test('bash can source models.env — it is the other reader', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // /bin/bash on purpose: macOS system bash is 3.2 and is the scripts' target.
  const { stdout } = await run('/bin/bash', ['-c',
    `. ${JSON.stringify(join(scripts, 'models.env'))} && printf '%s|%s|%s' "$MODEL_ALIASES" "$MODEL_1M_SUFFIX" "$MODEL_BIG"`]);
  const [aliases, suffix, big] = stdout.split('|');
  assert.deepEqual(aliases.split(/\s+/), [...MODELS_ENV_FALLBACK.aliases]);
  assert.equal(suffix, MODELS_ENV_FALLBACK.oneM);
  assert.deepEqual(big.split(/\s+/).sort(), [...MODELS_ENV_FALLBACK.big].sort());
});

test('every spelling the CLI accepts passes the door; garbage does not', () => {
  for (const good of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]',
    'claude-haiku-4-5-20251001', 'fable', 'claude-fable-5', 'opusplan', 'haiku[1m]']) {
    assert.ok(isKnownModel(good), `${good} must be accepted — the CLI takes it`);
  }
  for (const bad of ['', '   ', 'gpt-4', 'bogus-model-xyz', 'llama']) {
    assert.ok(!isKnownModel(bad), `${bad} must be refused`);
  }
});

test('a [1m] variant is its base model everywhere except the budget', () => {
  assert.equal(modelFamily('claude-opus-5[1m]'), 'opus', 'same quota, same family');
  assert.equal(is1m('claude-opus-5[1m]'), true);
  assert.equal(is1m('claude-opus-5'), false);

  // Same rank, so it demotes exactly as plain opus does.
  assert.equal(nextModel('claude-opus-5[1m]'), nextModel('opus'));
  assert.deepEqual(fallbackChain('claude-opus-5[1m]'), fallbackChain('opus'));

  // The budget is the one thing that reads the suffix.
  assert.equal(budgetClassOf('opus'), 'big');
  assert.equal(budgetClassOf('opus[1m]'), '1m');
  assert.equal(budgetClassOf('haiku'), 'haiku');
  assert.equal(budgetClassOf('gpt-4'), 'default');
});

test('the ladder is still the ladder — MODEL_FALLBACK is strongest first', () => {
  assert.deepEqual(MODEL_FALLBACK, ['fable', 'opus', 'sonnet', 'haiku']);
  // Pinned because escalation walks left and demotion walks right along it.
  assert.equal(nextModel('claude-fable-5'), 'opus');
  assert.equal(nextModel('haiku'), null);
  assert.equal(nextModel(undefined), 'opus');
});

test('canonicalModelId expands an alias and leaves a full id alone', () => {
  assert.equal(canonicalModelId('opus'), 'claude-opus-5');
  assert.equal(canonicalModelId('opus[1m]'), 'claude-opus-5[1m]');
  assert.equal(canonicalModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
  assert.equal(canonicalModelId('gpt-4'), 'gpt-4', 'unknown names are returned untouched');
});

test('the pick list offers 1M only where it is available, and is a subset of the door', () => {
  const offered = offeredModels(loadModelsEnv(scripts));
  assert.ok(offered.includes('opus[1m]'));
  assert.ok(!offered.includes('haiku[1m]'), 'the API refuses it today');
  assert.ok(isKnownModel('haiku[1m]'), 'but the door still takes it, in case that changes');
  for (const m of offered) assert.ok(isKnownModel(m), `${m} is offered but would be refused`);
});

test('resolveBudget reads the suffix, and no existing name changed value', () => {
  const sizing = loadSizing(scripts);
  assert.equal(resolveBudget('opus', sizing, scripts), sizing.budgetBig);
  assert.equal(resolveBudget('claude-opus-5', sizing, scripts), sizing.budgetBig);
  assert.equal(resolveBudget('haiku', sizing, scripts), sizing.budgetHaiku);
  assert.equal(resolveBudget('mythos', sizing, scripts), sizing.budgetBig);
  assert.equal(resolveBudget('gpt-4', sizing, scripts), sizing.budgetDefault);
  assert.equal(resolveBudget('', sizing, scripts), sizing.budgetDefault);
  assert.equal(resolveBudget('65000', sizing, scripts), 65_000, 'a raw number still wins');
  assert.equal(resolveBudget('opus[1m]', sizing, scripts), sizing.budget1m);
});

test('sizing.env keys carrying a digit are parsed — BUDGET_1M was not, once', () => {
  const sizing = loadSizing(scripts);
  const text = readFileSync(join(scripts, 'sizing.env'), 'utf8');
  const declared = /^BUDGET_1M=(\d+)/m.exec(text);
  assert.ok(declared, 'BUDGET_1M must be declared in sizing.env');
  assert.equal(sizing.budget1m, Number(declared[1]),
    'the JS reader must honour the file, not its own fallback');
});
