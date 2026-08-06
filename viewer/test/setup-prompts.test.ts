/**
 * The setup prompts say the same thing in all three places.
 *
 * The launcher prompt appears on the Settings page, in the in-app guide and in
 * the README. Two of those are markdown files a person edits by hand, so
 * without a check the three drift — and an install procedure that is subtly
 * wrong in one place is worse than one that is missing, because the reader has
 * no reason to doubt it.
 *
 * `shared/setup-prompts.js` is the source; this asserts the markdown carries it
 * verbatim, inside a fence, so a copy that was reflowed or half-updated fails
 * here rather than on someone's first day.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SETUP_PROMPTS, DESKTOP_LAUNCHER_PROMPT, INSTALL_PROMPT, TAILSCALE_PROMPT,
} from '../shared/setup-prompts.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Which files must reproduce which prompt.
 *
 * Per-prompt rather than one global list, because they are documented in
 * different places: the README carries the two prompts a new reader needs and
 * deliberately carries nothing else — it is kept short on purpose, and a test
 * that demanded every prompt appear there would push it back towards the
 * thousand-line version this replaced.
 */
const CARRIERS: [string, string[]][] = [
  ['install', ['README.md']],
  ['tailscale', ['README.md', 'viewer/client/src/content/guide/mobile.md']],
  ['desktop-launcher', ['docs/install.md', 'viewer/client/src/content/guide/running.md']],
];

const PROMPTS: Record<string, string> = {
  install: INSTALL_PROMPT,
  tailscale: TAILSCALE_PROMPT,
  'desktop-launcher': DESKTOP_LAUNCHER_PROMPT,
};

test('every setup prompt is well-formed', () => {
  assert.ok(SETUP_PROMPTS.length > 0, 'expected at least one setup prompt');
  for (const p of SETUP_PROMPTS) {
    assert.ok(p.id && p.title && p.lede && p.prompt, `${p.id}: missing a field`);
    assert.ok(p.prompt.trim() === p.prompt, `${p.id}: prompt has stray outer whitespace`);
    // Pasted as-is, so a backtick would break every fence that carries it.
    assert.ok(!p.prompt.includes('```'), `${p.id}: a fence inside a fenced prompt`);
  }
});

test('every prompt is reproduced verbatim wherever it is documented', () => {
  for (const [id, files] of CARRIERS) {
    const prompt = PROMPTS[id];
    assert.ok(prompt, `no prompt exported for ${id}`);
    for (const file of files) {
      const body = read(file);
      assert.ok(
        body.includes(prompt),
        `${file} does not carry the ${id} prompt verbatim — re-copy it from shared/setup-prompts.js`,
      );
      // Verbatim is not enough: outside a fence, markdown would reflow the
      // indented lists into one paragraph and the reader would copy that.
      const fenced = body.split('```').filter((_, i) => i % 2 === 1);
      assert.ok(
        fenced.some((f) => f.includes(prompt)),
        `${file} carries the ${id} prompt outside a code fence`,
      );
    }
  }
});

test('every prompt in the module is documented somewhere', () => {
  // A prompt the console shows and no document carries is one that only exists
  // for someone who already found the Settings page.
  const declared = new Set(CARRIERS.map(([id]) => id));
  for (const p of SETUP_PROMPTS) {
    assert.ok(declared.has(p.id), `${p.id} has no carrier — add one to CARRIERS`);
  }
});

test('the README stays short enough to be read', () => {
  // The whole point of the rewrite: deep content lives under docs/. The two
  // install prompts are most of what is left, so this is a ceiling on the
  // prose around them, not on the prompts themselves.
  const lines = read('README.md').split('\n').length;
  assert.ok(lines < 200, `README.md is ${lines} lines — move deep sections into docs/`);
});

test('the prompt keeps the promises the launcher actually makes', () => {
  const launcher = read('viewer/deploy/desktop-launcher.command');
  // Each knob the prompt tells a reader to set has to exist in the file it
  // tells them to open. A renamed knob would otherwise be found by a person
  // following instructions, at the point the instructions stop working.
  for (const knob of ['ROOT', 'WRITES', 'RUNS', 'TERM_FLAG', 'AGENT', 'ACCOUNTS', 'PORT', 'SUPERVISED']) {
    assert.ok(DESKTOP_LAUNCHER_PROMPT.includes(knob), `prompt never mentions ${knob}`);
    assert.match(launcher, new RegExp(`^${knob}=`, 'm'), `launcher has no ${knob}= knob`);
  }
  // And the staleness warning the prompt promises at the end.
  assert.match(launcher, /^LAUNCHER_REV=/m, 'launcher has no revision marker to warn from');
});
