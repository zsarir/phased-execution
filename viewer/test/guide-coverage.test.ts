/**
 * The guide, asserted against the code it describes.
 *
 * `client/src/views/guide/guide.test.tsx` already pins the registry's totality
 * in both directions — a section with no content, or content with no route.
 * What it cannot see is whether the prose still matches the machine, and that is
 * the failure mode that actually happened: the permissions page said an agent
 * session is built "never with the bypass mode" for as long as it took someone
 * to add a QA review that uses exactly that.
 *
 * So the properties here are the ones a code change can silently falsify:
 * every notification category a person can be sent is a category the guide
 * names, and every section id in the frozen vocabulary is a file that exists on
 * disk with something in it. Prose is not asserted — only the identifiers that
 * would have to change anyway.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CATEGORIES } from '../server/push/catalogue.ts';
import { GUIDE_SECTIONS } from '../shared/route-meta.js';

const guideDir = fileURLToPath(new URL('../client/src/content/guide/', import.meta.url));
const read = (name: string) => readFileSync(`${guideDir}${name}.md`, 'utf8');

test('every frozen guide section is a markdown file with real content', () => {
  for (const id of GUIDE_SECTIONS) {
    assert.ok(existsSync(`${guideDir}${id}.md`), `${id}.md is missing`);
    const body = read(id);
    // `?raw` on a deleted file is '' and renders a blank tab rather than failing.
    assert.ok(body.length > 400, `${id}.md is a stub (${body.length} bytes)`);
    assert.match(body, /^##? /m, `${id}.md has no heading`);
  }
});

test('the guide names every notification category a person can be sent', () => {
  const body = read('notifications');
  for (const category of CATEGORIES) {
    assert.ok(
      body.includes(category.label),
      `the guide never mentions "${category.label}" — adding a category is two edits, and this is the second`,
    );
  }
});

test('the guide documents the off switch, recovery and reviews by the names they really have', () => {
  const body = read('sessions');
  // Identifiers, not phrasing: each is a thing that would have to be renamed in
  // the code before this assertion could become wrong for a good reason.
  for (const needle of ['bootout', 'claude --resume', 'qa-record.sh', 'Restart']) {
    assert.ok(body.includes(needle), `the sessions guide never mentions ${needle}`);
  }
});

test('nothing claims an agent session can never bypass — QA reviews can', () => {
  // The exact rot this file exists to catch, pinned as a regression.
  const permissions = read('permissions');
  assert.ok(
    !/never the bypass mode/.test(permissions),
    'permissions.md still carries the pre-QA claim that bypass is unreachable from an agent session',
  );
  assert.match(permissions, /permissionProfile/);
});
