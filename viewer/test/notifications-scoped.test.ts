/**
 * Reading an inbox by looking at the thing it is about.
 *
 * P1 stopped the flood: a category that is off records nothing, so the count
 * cannot climb for something the operator switched away. That fixes the future
 * and does nothing for the present — 182 records were already sitting there,
 * and the only verb that could touch them was "mark everything read", which is
 * not triage, it is giving up on the inbox.
 *
 * What was missing is the other half: a record knew what it *said* but not what
 * it was *about*, in any form a query could match. `slug`, `runId`, `phase` and
 * now `sessionId` are those fields, and a scoped read is what they are for —
 * opening a plan clears that plan's notifications and nothing else.
 *
 * The safety property is the one worth reading twice, because this verb is
 * fired *automatically* by a page that has just loaded: **an empty scope
 * matches nothing.** `markRead()` with no ids means "everything"; a scoped read
 * with no scope means "nothing". If those two agreed, a route whose slug had
 * not parsed yet would silently clear the whole inbox — the exact bug this
 * feature exists to end, reintroduced by its own fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-scoped-inbox-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { Notifications } = await import('../server/notifications.ts');

/** A store of its own per test — the real one is shared, persisted and bounded. */
function inbox(): InstanceType<typeof Notifications> {
  return new Notifications(mkdtempSync(join(STATE_HOME, 'store-')));
}

function seed(store: InstanceType<typeof Notifications>) {
  return {
    haltedAlpha: store.record({
      category: 'halted', title: 'alpha halted', body: 'phase 6', slug: 'alpha', runId: 'r-alpha', phase: 6,
    }),
    phaseAlpha: store.record({
      category: 'phase', title: 'alpha phase 7 done', body: '', slug: 'alpha', runId: 'r-alpha', phase: 7,
    }),
    haltedBeta: store.record({
      category: 'halted', title: 'beta halted', body: '', slug: 'beta', runId: 'r-beta', phase: 2,
    }),
    session: store.record({
      category: 'session', title: 'a session ended', body: '', sessionId: '84c324dd3ef9',
    }),
    // The shape every record written before this feature has: no context at all.
    legacy: store.record({ category: 'health', title: 'the watcher stalled', body: '' }),
  };
}

/* ------------------------------------------------------------------ *
 * The context fields
 * ------------------------------------------------------------------ */

test('a record carries what it is about, and omits what it is not', () => {
  const store = inbox();
  const { haltedAlpha, session, legacy } = seed(store);

  assert.equal(haltedAlpha.slug, 'alpha');
  assert.equal(haltedAlpha.runId, 'r-alpha');
  assert.equal(haltedAlpha.phase, 6);
  assert.equal('sessionId' in haltedAlpha, false, 'an absent field is absent, not undefined');

  assert.equal(session.sessionId, '84c324dd3ef9');
  assert.equal('slug' in session, false);

  // A record from before the fields existed is still a record.
  assert.equal('slug' in legacy, false);
  assert.equal(legacy.category, 'health');
});

/* ------------------------------------------------------------------ *
 * Scoped reads
 * ------------------------------------------------------------------ */

test('opening a plan clears that plan and nothing else', () => {
  const store = inbox();
  const { haltedBeta, session, legacy } = seed(store);
  assert.equal(store.unread(), 5);

  assert.equal(store.markReadWhere({ slug: 'alpha' }), 2);
  assert.equal(store.unread(), 3);

  const unread = store.list({ unreadOnly: true }).items.map((r) => r.id).sort();
  assert.deepEqual(unread, [haltedBeta.id, session.id, legacy.id].sort());

  // Idempotent: opening the page twice reads nothing the second time.
  assert.equal(store.markReadWhere({ slug: 'alpha' }), 0);
});

test('every field in a scope has to match', () => {
  const store = inbox();
  seed(store);

  // Category alone: both halts, across two plans.
  assert.equal(store.markReadWhere({ category: 'halted' }), 2);
  assert.equal(store.unread(), 3);

  // Slug AND phase — narrower than either.
  assert.equal(store.markReadWhere({ slug: 'alpha', phase: 6 }), 0, 'already read by the halt scope');
  assert.equal(store.markReadWhere({ slug: 'alpha', phase: 7 }), 1);
  assert.equal(store.unread(), 2);
});

test('a session page clears its own session', () => {
  const store = inbox();
  seed(store);
  assert.equal(store.markReadWhere({ sessionId: '84c324dd3ef9' }), 1);
  assert.equal(store.markReadWhere({ sessionId: 'a-different-session' }), 0);
});

test('a scope that names something nothing is about clears nothing', () => {
  const store = inbox();
  seed(store);
  assert.equal(store.markReadWhere({ slug: 'never-existed' }), 0);
  assert.equal(store.markReadWhere({ runId: 'r-nope' }), 0);
  assert.equal(store.unread(), 5);
});

test('records with no context are never swept up by a scoped read', () => {
  const store = inbox();
  const { legacy } = seed(store);
  // An absent field must not read as a wildcard — otherwise opening any plan
  // would clear every record written before the fields existed.
  store.markReadWhere({ slug: 'alpha' });
  store.markReadWhere({ slug: 'beta' });
  store.markReadWhere({ sessionId: '84c324dd3ef9' });
  assert.equal(store.list({ unreadOnly: true }).items.some((r) => r.id === legacy.id), true);
});

/* ------------------------------------------------------------------ *
 * The safety property
 * ------------------------------------------------------------------ */

test('an EMPTY scope clears nothing, where an empty id list clears everything', () => {
  const store = inbox();
  seed(store);

  // This is the call a page makes before its route has parsed.
  assert.equal(store.markReadWhere({}), 0);
  assert.equal(store.markReadWhere({ slug: undefined, runId: undefined }), 0);
  assert.equal(store.unread(), 5, 'nothing may be cleared by a scope that names nothing');

  // The deliberate bulk verb still means what it always did.
  assert.equal(store.markRead(), 5);
  assert.equal(store.unread(), 0);
});

test('a scoped read survives a reload — it is written, not just remembered', () => {
  const dir = mkdtempSync(join(STATE_HOME, 'persist-'));
  const store = new Notifications(dir);
  seed(store);
  store.markReadWhere({ slug: 'alpha' });
  store.flush();

  const reopened = new Notifications(dir);
  assert.equal(reopened.unread(), 3);
  assert.deepEqual(
    reopened.list({ unreadOnly: true }).items.map((r) => r.category).sort(),
    ['halted', 'health', 'session'],
  );
  // And the context came back with it.
  const read = reopened.list().items.filter((r) => r.read);
  assert.ok(read.every((r) => r.slug === 'alpha'));
  assert.deepEqual(read.map((r) => r.phase).sort(), [6, 7]);
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));
