/**
 * Finding the skills a phase could invoke.
 *
 * Every case here is one that a real machine turned up rather than one that
 * looked plausible: skills nested under a plugin's own `.claude/skills`, a
 * plugin whose entry point is a `commands/*.md` file with no name in its front
 * matter at all, several installed versions of the same plugin sitting side by
 * side in the cache, and descriptions written as YAML block scalars.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { listSkills, forgetSkills, skillDirective, claudeHome, installedPlugins } =
  await import('../server/skills.ts');

function file(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function skill(path: string, name: string, description = `about ${name}`): void {
  file(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

type World = { home: string; root: string; env: NodeJS.ProcessEnv; cleanup: () => void };

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pc-skills-'));
  const home = join(dir, 'home');
  const root = join(dir, 'repo');

  skill(join(home, 'skills', 'investigate'), 'investigate', 'systematic debugging');
  skill(join(root, '.claude', 'skills', 'db-context'), 'db-context');

  // A folded block scalar, which is how a paragraph-long description is
  // actually written — and which naive parsing reduces to the character ">".
  file(join(root, '.claude', 'skills', 'wordy', 'SKILL.md'),
    '---\nname: wordy\ndescription: >\n  A long description that runs\n  across several lines.\n---\n\n# wordy\n');

  // Two installs of one plugin: only the recorded one is what a session loads.
  const installed = join(home, 'plugins', 'cache', 'market', 'toolkit', '2.0.0');
  const stale = join(home, 'plugins', 'cache', 'market', 'toolkit', '1.0.0');
  skill(join(installed, 'skills', 'deploy'), 'deploy', 'ship it');
  skill(join(stale, 'skills', 'ghost'), 'ghost', 'an old version nobody loads');

  // Skills nested under the plugin's own `.claude/skills` — a real layout that
  // a blanket dotfile skip made completely invisible.
  const nested = join(home, 'plugins', 'cache', 'market', 'nested', '1.2.3');
  skill(join(nested, '.claude', 'skills', 'design'), 'design', 'visual work');

  // A plugin whose entry point is a command: the name comes from the FILENAME,
  // because a command's front matter carries a description and no name.
  const commanded = join(home, 'plugins', 'cache', 'market', 'feature-dev', 'unknown');
  file(join(commanded, 'commands', 'feature-dev.md'),
    '---\ndescription: Guided feature development\n---\n\nDo the thing.\n');

  file(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'toolkit@market': [
        { scope: 'user', installPath: stale, lastUpdated: '2026-01-01T00:00:00.000Z' },
        { scope: 'user', installPath: installed, lastUpdated: '2026-08-01T00:00:00.000Z' },
      ],
      'nested@market': [{ scope: 'user', installPath: nested, lastUpdated: '2026-08-01T00:00:00.000Z' }],
      'feature-dev@market': [{ scope: 'user', installPath: commanded, lastUpdated: '2026-08-01T00:00:00.000Z' }],
      'uninstalled@market': [{ scope: 'user', installPath: join(dir, 'gone'), lastUpdated: '2026-08-01T00:00:00.000Z' }],
    },
  }));

  forgetSkills();
  return {
    home,
    root,
    env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    cleanup: () => { forgetSkills(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ids = (w: World) => listSkills(w.root, w.env).map((s) => s.id);

test('personal, project and plugin skills are all found, and named as they are invoked', () => {
  const w = world();
  const found = ids(w);
  assert.ok(found.includes('investigate'), 'a personal skill');
  assert.ok(found.includes('db-context'), 'a project skill');
  assert.ok(found.includes('toolkit:deploy'), 'a plugin skill is namespaced by its plugin');
  w.cleanup();
});

test('a plugin that keeps its skills under .claude is not invisible', () => {
  const w = world();
  // Skipping every dot-directory hid an entire real plugin's skills.
  assert.ok(ids(w).includes('nested:design'));
  w.cleanup();
});

test('a plugin whose entry point is a command is found, named after the file', () => {
  const w = world();
  const found = listSkills(w.root, w.env).find((s) => s.id === 'feature-dev:feature-dev');
  assert.ok(found, 'commands are invoked exactly like skills');
  assert.equal(found.description, 'Guided feature development');
  w.cleanup();
});

test('only the installed version of a plugin is offered', () => {
  const w = world();
  const found = ids(w);
  assert.ok(found.includes('toolkit:deploy'));
  assert.ok(!found.includes('toolkit:ghost'), 'an older version in the cache is not loadable');
  w.cleanup();
});

test('a plugin recorded as installed but no longer on disk is skipped', () => {
  const w = world();
  assert.deepEqual(installedPlugins(w.home).filter((p) => p.plugin === 'uninstalled'), []);
  w.cleanup();
});

test('a block-scalar description is read as the paragraph it is', () => {
  const w = world();
  const found = listSkills(w.root, w.env).find((s) => s.id === 'wordy');
  assert.equal(found.description, 'A long description that runs across several lines.');
  w.cleanup();
});

test('the home a session will use decides what is on offer', () => {
  const w = world();
  assert.equal(claudeHome(w.env), w.home);
  // With no project there are no project skills, and nothing throws.
  const noProject = listSkills(undefined, w.env).map((s) => s.id);
  assert.ok(!noProject.includes('db-context'));
  assert.ok(noProject.includes('investigate'));
  w.cleanup();
});

test('a missing home is empty, not an error', () => {
  forgetSkills();
  const found = listSkills(undefined, { ...process.env, CLAUDE_CONFIG_DIR: '/nowhere-at-all' });
  assert.deepEqual(found, []);
  forgetSkills();
});

test('the directive is additive, deduped, and silent when nothing was chosen', () => {
  assert.equal(skillDirective([]), '');
  assert.equal(skillDirective(['', '']), '');
  const text = skillDirective(['investigate', 'toolkit:deploy', 'investigate']);
  assert.match(text, /\/investigate, \/toolkit:deploy/);
  assert.doesNotMatch(text, /\/investigate.*\/investigate/, 'named once, however many times it was asked for');
  // It must read as an addition. The plan's own skills line comes from the
  // engine, and nothing here may look like it replaced it.
  assert.match(text, /in addition to any the plan names/);
});
