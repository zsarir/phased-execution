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

import { SETUP_PROMPTS, DESKTOP_LAUNCHER_PROMPT } from '../shared/setup-prompts.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The carriers: every file that reproduces a setup prompt for a reader. */
const CARRIERS = [
  'README.md',
  'viewer/client/src/content/guide/running.md',
];

test('every setup prompt is well-formed', () => {
  assert.ok(SETUP_PROMPTS.length > 0, 'expected at least one setup prompt');
  for (const p of SETUP_PROMPTS) {
    assert.ok(p.id && p.title && p.lede && p.prompt, `${p.id}: missing a field`);
    assert.ok(p.prompt.trim() === p.prompt, `${p.id}: prompt has stray outer whitespace`);
    // Pasted as-is, so a backtick would break every fence that carries it.
    assert.ok(!p.prompt.includes('```'), `${p.id}: a fence inside a fenced prompt`);
  }
});

test('the launcher prompt is reproduced verbatim wherever it is documented', () => {
  for (const file of CARRIERS) {
    const body = read(file);
    assert.ok(
      body.includes(DESKTOP_LAUNCHER_PROMPT),
      `${file} does not carry the launcher prompt verbatim — re-copy it from shared/setup-prompts.js`,
    );
    // Verbatim is not enough: outside a fence, markdown would reflow the
    // indented knob list into one paragraph and the reader would copy that.
    const fenced = body.split('```').filter((_, i) => i % 2 === 1);
    assert.ok(
      fenced.some((f) => f.includes(DESKTOP_LAUNCHER_PROMPT)),
      `${file} carries the prompt outside a code fence`,
    );
  }
});

test('the prompt keeps the promises the launcher actually makes', () => {
  const launcher = read('viewer/deploy/desktop-launcher.command');
  // Each knob the prompt tells a reader to set has to exist in the file it
  // tells them to open. A renamed knob would otherwise be found by a person
  // following instructions, at the point the instructions stop working.
  for (const knob of ['ROOT', 'WRITES', 'RUNS', 'TERM_FLAG', 'AGENT', 'PORT', 'SUPERVISED']) {
    assert.ok(DESKTOP_LAUNCHER_PROMPT.includes(knob), `prompt never mentions ${knob}`);
    assert.match(launcher, new RegExp(`^${knob}=`, 'm'), `launcher has no ${knob}= knob`);
  }
  // And the staleness warning the prompt promises at the end.
  assert.match(launcher, /^LAUNCHER_REV=/m, 'launcher has no revision marker to warn from');
});
