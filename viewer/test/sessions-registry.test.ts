/**
 * The session registry — who is in the repository right now, as the hook
 * reports it and as the scheduler, the classifier and the Pulse read it.
 *
 * Pinned: the payload contract (validation, caps, both field spellings), the
 * fold of events into a record (start, heartbeat, end, revival on resume,
 * out-of-order replay), the three-valued presence (ended by hook, ended by a
 * gone process, live, unknown after the window), correlation (strong by
 * `session=`, weak by owner+time — and only strong may ever mean debris), and
 * the registry itself (persist + reload, the inbox drained oldest-first and
 * emptied, junk deleted, pruning, views).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  SessionRegistry, LIVE_WINDOW_MS, RETAIN_ENDED_MS, RETAIN_SILENT_MS,
  applyEvent, correlate, kindOf, parseHookPayload, presenceOf,
} = await import('../server/sessions/registry.ts');
type HookPayload = import('../server/sessions/registry.ts').HookPayload;
type SessionRecord = import('../server/sessions/registry.ts').SessionRecord;

const T0 = '2026-08-21T10:00:00.000Z';
const at = (plusMs: number): string => new Date(Date.parse(T0) + plusMs).toISOString();

function payload(over: Partial<HookPayload> & { event: HookPayload['event'] }): HookPayload {
  return { session_id: 's1', cwd: '/work/hub', ...over };
}

/* ---------------- the payload ---------------- */

test('parseHookPayload: accepts the hook\'s record, caps every string, reads both field spellings, rejects what is not a session event', () => {
  const ok = parseHookPayload({
    version: 1, session_id: 'abc-123', event: 'SessionStart', cwd: '/work/hub', transcript_path: '/t/a.jsonl',
    source: 'startup', owner: 'autopilot/ab12cd34', scope: 'web-app', user: 'sam', host: 'laptop', pid: 4242, root: '/work/hub',
    at: T0,
  });
  assert.deepEqual(ok, {
    session_id: 'abc-123', event: 'SessionStart', cwd: '/work/hub', transcript_path: '/t/a.jsonl',
    source: 'startup', owner: 'autopilot/ab12cd34', scope: 'web-app', user: 'sam', host: 'laptop', pid: 4242, root: '/work/hub', at: T0,
  });
  // The documented spelling of the event field.
  assert.equal(parseHookPayload({ session_id: 's', hook_event_name: 'Stop', cwd: '/x' })?.event, 'Stop');
  // Caps and sanitising.
  const long = parseHookPayload({ session_id: 's', event: 'Stop', cwd: '/x', reason: 'r'.repeat(500), source: 'a\nb' });
  assert.equal(long?.reason?.length, 64);
  assert.equal(long?.source, 'a b');
  // A bad pid or date is dropped, not rejected.
  const loose = parseHookPayload({ session_id: 's', event: 'Stop', cwd: '/x', pid: -3, at: 'yesterday' });
  assert.equal(loose?.pid, undefined);
  assert.equal(loose?.at, undefined);
  // Rejections.
  assert.equal(parseHookPayload(null), null);
  assert.equal(parseHookPayload('x'), null);
  assert.equal(parseHookPayload({ event: 'Stop', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 'has space', event: 'Stop', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'PreToolUse', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'Stop', cwd: 'relative' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'Stop' }), null);
});

test('kindOf: the owner vocabulary the locks use', () => {
  assert.equal(kindOf('autopilot/ab12cd34'), 'autopilot');
  assert.equal(kindOf('console/agent-1'), 'agent');
  assert.equal(kindOf('sam@laptop'), 'foreign');
  assert.equal(kindOf(undefined), 'foreign');
});

/* ---------------- the fold ---------------- */

test('applyEvent: start, heartbeat, end — and a resume revives an ended id', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', source: 'startup', user: 'sam', host: 'laptop', pid: 7, at: T0 }), T0);
  assert.deepEqual(started, {
    sessionId: 's1', kind: 'foreign', cwd: '/work/hub', user: 'sam', host: 'laptop', pid: 7,
    startedAt: T0, lastSeen: T0, source: 'startup', turns: 0,
  });
  const beat = applyEvent(started, payload({ event: 'Stop', at: at(60_000) }), at(60_000));
  assert.equal(beat.turns, 1);
  assert.equal(beat.lastSeen, at(60_000));
  assert.equal(beat.startedAt, T0);
  const ended = applyEvent(beat, payload({ event: 'SessionEnd', reason: 'prompt_input_exit', at: at(120_000) }), at(120_000));
  assert.equal(ended.endedAt, at(120_000));
  assert.equal(ended.reason, 'prompt_input_exit');
  // `claude --resume s1`: SessionStart(source: resume) for the same id — live again.
  const revived = applyEvent(ended, payload({ event: 'SessionStart', source: 'resume', at: at(300_000) }), at(300_000));
  assert.equal(revived.endedAt, undefined);
  assert.equal(revived.reason, undefined);
  assert.equal(revived.source, 'resume');
  assert.equal(revived.startedAt, T0, 'the first start stays the start');
  // An owner arriving later re-kinds the record; facts absent from a payload are kept.
  const owned = applyEvent(revived, payload({ event: 'Stop', owner: 'autopilot/ab12cd34', at: at(360_000) }), at(360_000));
  assert.equal(owned.kind, 'autopilot');
  assert.equal(owned.user, 'sam');
});

test('applyEvent: an event older than the end it would undo (inbox replay out of order) does not revive', () => {
  const ended = applyEvent(
    applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0),
    payload({ event: 'SessionEnd', reason: 'other', at: at(100_000) }), at(100_000),
  );
  const late = applyEvent(ended, payload({ event: 'Stop', at: at(50_000) }), at(200_000));
  assert.equal(late.endedAt, at(100_000));
  assert.equal(late.turns, 1, 'the heartbeat still counts');
  assert.equal(late.lastSeen, at(100_000), 'lastSeen never moves backwards');
  // A payload with no `at` takes the receiver's clock.
  const noAt = applyEvent(undefined, payload({ event: 'SessionStart' }), at(1));
  assert.equal(noAt.startedAt, at(1));
});

/* ---------------- presence ---------------- */

test('presenceOf: ended by the hook, ended by a gone process, live, unknown past the window', () => {
  const live: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99 };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(live, now), 'live');
  assert.equal(presenceOf({ ...live, endedAt: at(10) }, now), 'ended');
  assert.equal(presenceOf(live, now, () => false), 'ended', 'a dead process is an ended session');
  assert.equal(presenceOf(live, now, () => true), 'live');
  assert.equal(presenceOf(live, now, () => { throw new Error('ps broke'); }), 'live', 'a probe that cannot answer never demotes');
  assert.equal(presenceOf(live, Date.parse(T0) + LIVE_WINDOW_MS + 1), 'unknown');
  assert.equal(presenceOf({ ...live, pid: undefined }, now, () => false), 'live', 'no pid, no process verdict');
});

/* ---------------- correlation ---------------- */

test('correlate: strong by session=, weak by <user>@<host> within the session\'s life — newest claim wins', () => {
  const rec: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', user: 'sam', host: 'laptop', startedAt: T0, lastSeen: at(600_000), turns: 3 };
  const now = Date.parse(T0) + 700_000;
  const t = (ms: number) => Date.parse(T0) + ms;
  assert.deepEqual(
    correlate(rec, [
      { slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) },
      { slug: 'beta', phase: 5, owner: 'other', session: 's1', claimedAt: t(20_000) },
    ], now),
    { slug: 'beta', phase: 5, strong: true },
  );
  assert.deepEqual(
    correlate(rec, [
      { slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) },
      { slug: 'alpha', phase: 3, owner: 'sam@laptop', claimedAt: t(30_000) },
    ], now),
    { slug: 'alpha', phase: 3, strong: false },
  );
  // A claim from long before the session, or after it ended, is not its own.
  assert.equal(correlate(rec, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(-3_600_000) }], now), undefined);
  assert.equal(correlate({ ...rec, endedAt: at(100_000) }, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(200_000) }], now), undefined);
  // A lock that names ANOTHER session is never this one's, whatever the owner says.
  assert.equal(correlate(rec, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', session: 's2', claimedAt: t(10_000) }], now), undefined);
  // No user/host on the record: strong only.
  assert.equal(correlate({ ...rec, user: undefined }, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) }], now), undefined);
});

/* ---------------- the registry ---------------- */

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-registry-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('registry: ingest persists one record per session; a fresh registry reloads it; presence and views answer', () => {
  const { dir, cleanup } = scratch();
  try {
    const changes: string[] = [];
    const reg = new SessionRegistry({ dir, now: () => new Date(at(0)), pidAlive: null, onChange: (r, e) => changes.push(`${e}:${r.sessionId}`) }).load();
    reg.ingest(payload({ event: 'SessionStart', user: 'sam', host: 'laptop', at: T0 }));
    reg.ingest(payload({ event: 'Stop', at: at(1_000) }));
    reg.ingest({ session_id: 's2', event: 'SessionStart', cwd: '/work/hub', owner: 'autopilot/ab12cd34', at: at(2_000) });
    assert.deepEqual(changes, ['SessionStart:s1', 'Stop:s1', 'SessionStart:s2']);
    assert.ok(existsSync(join(dir, 's1.json')));
    assert.ok(existsSync(join(dir, 's2.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, 's1.json'), 'utf8')).turns, 1);
    assert.equal(reg.presence('s1'), 'live');
    assert.equal(reg.presence('nobody'), 'unknown');
    assert.equal(reg.presenceOfLock({ session: 's1' }), 'live');
    assert.equal(reg.presenceOfLock({}), 'unknown');

    const again = new SessionRegistry({ dir, now: () => new Date(at(5_000)), pidAlive: null }).load();
    assert.equal(again.get('s1')?.turns, 1);
    assert.equal(again.get('s2')?.kind, 'autopilot');
    const views = again.views([{ slug: 'alpha', phase: 4, owner: 'sam@laptop', claimedAt: Date.parse(T0) + 500 }]);
    assert.equal(views.length, 2);
    const s1 = views.find((v) => v.sessionId === 's1')!;
    assert.equal(s1.presence, 'live');
    assert.deepEqual(s1.plan, { slug: 'alpha', phase: 4, strong: false });
    reg.close(); again.close();
  } finally { cleanup(); }
});

test('registry: the inbox is drained oldest-first (by at, then start<stop<end), applied, emptied; junk is deleted', () => {
  const { dir, cleanup } = scratch();
  try {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    // Dropped while the console was down — names in the hook's shape, deliberately out of order.
    writeFileSync(join(inbox, '1700000002-s1-SessionEnd.json'), JSON.stringify(payload({ event: 'SessionEnd', reason: 'other', at: at(2_000) })));
    writeFileSync(join(inbox, '1700000000-s1-SessionStart.json'), JSON.stringify(payload({ event: 'SessionStart', at: at(0) })));
    writeFileSync(join(inbox, '1700000001-s1-Stop.json'), JSON.stringify(payload({ event: 'Stop', at: at(1_000) })));
    // Same second, the two event kinds: start before end.
    writeFileSync(join(inbox, '1700000005-s3-SessionEnd.json'), JSON.stringify({ session_id: 's3', event: 'SessionEnd', cwd: '/w', at: at(5_000) }));
    writeFileSync(join(inbox, '1700000005-s3-SessionStart.json'), JSON.stringify({ session_id: 's3', event: 'SessionStart', cwd: '/w', at: at(5_000) }));
    writeFileSync(join(inbox, 'junk.json'), 'not json');
    writeFileSync(join(inbox, 'wrong.json'), JSON.stringify({ hello: 'world' }));
    const reg = new SessionRegistry({ dir, now: () => new Date(at(10_000)), pidAlive: null }).load();
    assert.equal(reg.get('s1')?.turns, 1);
    assert.equal(reg.get('s1')?.endedAt, at(2_000));
    assert.equal(reg.presence('s1'), 'ended');
    assert.equal(reg.get('s3')?.endedAt, at(5_000), 'start then end within one second');
    assert.deepEqual(readdirSync(inbox), [], 'the inbox is emptied, junk included');
    reg.close();
  } finally { cleanup(); }
});

test('registry: prune forgets ended records past their keep and silent ones past a week; the files go with them', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = Date.parse(T0);
    const reg = new SessionRegistry({ dir, now: () => new Date(now), pidAlive: null }).load();
    reg.ingest(payload({ session_id: 'ended', event: 'SessionEnd', at: T0 }));
    reg.ingest(payload({ session_id: 'silent', event: 'SessionStart', at: T0 }));
    reg.ingest(payload({ session_id: 'fresh', event: 'SessionStart', at: T0 }));
    now += RETAIN_ENDED_MS + 1;
    assert.equal(reg.prune(), 1);
    assert.equal(reg.get('ended'), undefined);
    assert.ok(!existsSync(join(dir, 'ended.json')));
    assert.equal(reg.presence('silent'), 'unknown', 'past the live window, not ended');
    now += RETAIN_SILENT_MS;
    assert.equal(reg.prune(), 2);
    assert.equal(reg.list().length, 0);
    reg.close();
  } finally { cleanup(); }
});

test('registry: a gone process reads ended through the injected probe; the probe is not consulted for records without a pid', () => {
  const { dir, cleanup } = scratch();
  try {
    const asked: number[] = [];
    const reg = new SessionRegistry({ dir, now: () => new Date(at(1_000)), pidAlive: (pid) => { asked.push(pid); return pid !== 404; } }).load();
    reg.ingest(payload({ session_id: 'gone', event: 'SessionStart', pid: 404, at: T0 }));
    reg.ingest(payload({ session_id: 'here', event: 'SessionStart', pid: 200, at: T0 }));
    reg.ingest(payload({ session_id: 'nopid', event: 'SessionStart', at: T0 }));
    assert.equal(reg.presence('gone'), 'ended');
    assert.equal(reg.presence('here'), 'live');
    assert.equal(reg.presence('nopid'), 'live');
    assert.deepEqual([...new Set(asked)].sort(), [200, 404]);
    reg.close();
  } finally { cleanup(); }
});
