/**
 * The inbox, the deep links, and the two things that used to be silent.
 *
 * Three failures are being pinned here, and all three were invisible rather
 * than wrong-looking:
 *
 *  1. An announcement with nobody listening simply never happened. The store
 *     has to hold it anyway — that is the entire point of it — so the test that
 *     matters most is the one with no device and no tab.
 *  2. Every approval notification opened the wrong tab, for the life of the
 *     feature, because two hand-written URLs named a tab id that does not
 *     exist. So `routeFor` is walked against the *client's own* router and the
 *     client's own tab list rather than against a copy of the table.
 *  3. A decision was true only in the browser that made it. `settle`, the
 *     timeout and `disarm` all have to reach the resolved hook, because those
 *     last two are precisely the endings nobody is watching for.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR resolves when config.ts is first imported, so the redirect has to
// happen before anything pulls it in — otherwise this writes into the
// operator's real notification history.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'phase-inbox-'));
// CONFIG_DIR resolves at the same moment and for the same reason: the gate
// tests below write preferences, and they must not land in the operator's real
// `~/.config/phase-console/config.json`.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'phase-config-'));

/*
 * The out-of-band leg is a spawned command, so it is observed the way the
 * operator would observe it: by giving `PHASE_CONSOLE_NOTIFY` a real notifier
 * that appends what it was told to a file. Nothing else can see that leg —
 * it leaves the process entirely — and it is precisely the leg that kept firing
 * for categories that were switched off.
 */
const NOTIFY_DIR = mkdtempSync(join(tmpdir(), 'phase-notify-'));
const NOTIFY_LOG = join(NOTIFY_DIR, 'announced.log');
const NOTIFIER = join(NOTIFY_DIR, 'notifier.sh');
writeFileSync(NOTIFIER, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${NOTIFY_LOG}\n`, 'utf8');
chmodSync(NOTIFIER, 0o755);
process.env.PHASE_CONSOLE_NOTIFY = NOTIFIER;

// Route vocabulary is asserted against the shared SSOT, not scraped from client
// source. `shared/route-meta.js` and `shared/routes.js` are plain dependency-free
// ESM, importable from Node with no build — that split is what makes this possible.
import { ROUTE_HEADS, PLAN_TABS } from '../shared/route-meta.js';

let notifications: typeof import('../server/notifications.ts');
let catalogue: typeof import('../server/push/catalogue.ts');
let approvalsMod: typeof import('../server/runner/approvals.ts');
// `routes.js`, not `router.js`: the rules, without the rendering runtime the
// hook needs. That split exists so this import is possible at all.
let router: typeof import('../shared/routes.js');

before(async () => {
  notifications = await import('../server/notifications.ts');
  catalogue = await import('../server/push/catalogue.ts');
  approvalsMod = await import('../server/runner/approvals.ts');
  router = await import('../shared/routes.js');
});

function store() {
  return new notifications.Notifications(mkdtempSync(join(tmpdir(), 'inbox-')));
}

function announcement(over: Record<string, unknown> = {}) {
  return {
    category: 'approval' as const,
    title: 'Permission needed',
    body: 'demo phase 2 — Bash: git commit',
    slug: 'demo',
    phase: 2,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

test('a record exists even when nothing was listening', () => {
  // No device subscribed, no tab open, no notifier configured. This is the case
  // that used to lose the event entirely.
  const inbox = store();
  const record = inbox.record(announcement());

  assert.equal(record.read, false);
  assert.deepEqual(record.delivery, [], 'nothing was delivered, and the record says so rather than implying success');
  assert.equal(inbox.unread(), 1);
  assert.equal(inbox.list().items.length, 1);
});

test('the history survives the console restarting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const first = new notifications.Notifications(dir);
  first.record(announcement({ title: 'one' }));
  first.record(announcement({ title: 'two' }));
  first.markRead();
  first.flush();

  const second = new notifications.Notifications(dir);
  assert.equal(second.list().items.length, 2, 'a restart must not empty the inbox');
  assert.equal(second.unread(), 0, 'nor forget what had been read');
  assert.deepEqual(second.list().items.map((r) => r.title), ['two', 'one'], 'newest first');
});

test('a delivery outcome is kept against the record it belongs to', () => {
  const inbox = store();
  const record = inbox.record(announcement());
  inbox.delivery(record.id, { device: 'd1', label: 'iPhone', outcome: 'failed', at: new Date().toISOString(), detail: '502' });
  // A retry from the same device replaces rather than stacks.
  inbox.delivery(record.id, { device: 'd1', label: 'iPhone', outcome: 'sent', at: new Date().toISOString() });
  inbox.delivery(record.id, { device: 'd2', label: 'Mac', outcome: 'gone', at: new Date().toISOString() });

  const [saved] = inbox.list().items;
  assert.equal(saved.delivery.length, 2);
  assert.equal(saved.delivery.find((d) => d.device === 'd1')?.outcome, 'sent');
  assert.equal(saved.delivery.find((d) => d.device === 'd2')?.outcome, 'gone');
});

test('a delivery reported against an unknown record is ignored, not invented', () => {
  const inbox = store();
  inbox.record(announcement());
  inbox.delivery('not-a-real-id', { device: 'd1', label: 'x', outcome: 'sent', at: new Date().toISOString() });
  assert.equal(inbox.list().items.length, 1);
});

test('marking read is explicit, per record or wholesale', () => {
  const inbox = store();
  const a = inbox.record(announcement({ title: 'a' }));
  inbox.record(announcement({ title: 'b' }));

  assert.equal(inbox.markRead([a.id]), 1);
  assert.equal(inbox.unread(), 1);
  assert.equal(inbox.markRead([a.id]), 0, 'marking an already-read record read changes nothing');
  assert.equal(inbox.markRead(), 1, 'no ids means every unread one');
  assert.equal(inbox.unread(), 0);
});

test('clearing says exactly what it clears', () => {
  const inbox = store();
  const keep = inbox.record(announcement({ title: 'unread' }));
  const drop = inbox.record(announcement({ title: 'read' }));
  inbox.markRead([drop.id]);

  assert.equal(inbox.clear('read'), 1);
  assert.deepEqual(inbox.list().items.map((r) => r.id), [keep.id], 'clear read keeps what you have not seen');
  assert.equal(inbox.clear({ id: keep.id }), 1);
  assert.equal(inbox.list().items.length, 0);
  assert.equal(inbox.clear('all'), 0, 'clearing an empty inbox removes nothing and does not throw');
});

test('filtering and paging read the list without changing it', () => {
  const inbox = store();
  inbox.record(announcement({ category: 'halted', title: 'halt' }));
  const middle = inbox.record(announcement({ category: 'approval', title: 'card' }));
  inbox.record(announcement({ category: 'phase', title: 'phase 3 done' }));
  inbox.markRead([middle.id]);

  assert.deepEqual(inbox.list({ category: 'approval' }).items.map((r) => r.title), ['card']);
  assert.equal(inbox.list({ unreadOnly: true }).items.length, 2);
  assert.equal(inbox.list({ limit: 1 }).more, true, 'a cut-short page says so');
  assert.equal(inbox.list({ limit: 99 }).more, false);
  assert.equal(inbox.list().unread, 2, 'the unread count is of everything, not of the filtered page');
});

test('an unknown paging cursor returns the first page rather than nothing', () => {
  const inbox = store();
  inbox.record(announcement({ title: 'one' }));
  // The row it was paging from was cleared underneath it — going blank would be
  // the worse failure.
  assert.equal(inbox.list({ before: 'vanished' }).items.length, 1);
});

test('retention is bounded by count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const inbox = new notifications.Notifications(dir);
  for (let i = 0; i < 540; i++) inbox.record(announcement({ title: `n${i}` }));
  inbox.flush();

  const all = inbox.list({ limit: 200 });
  assert.equal(all.total, 500, 'the cap holds rather than growing without bound');
  assert.equal(all.items[0].title, 'n539', 'and it is the oldest that goes');

  const lines = readFileSync(join(dir, 'notifications.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 500, 'the file is compacted, not merely the memory');
});

test('records older than the retention window do not come back after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const inbox = new notifications.Notifications(dir);
  const fresh = inbox.record(announcement({ title: 'recent' }));
  const stale = inbox.record(announcement({ title: 'ancient' }));
  // Reach in and age one past the window, then reload from the file.
  const aged = inbox.list().items.find((r) => r.id === stale.id)!;
  aged.at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  inbox.markRead([stale.id]);
  inbox.flush();

  const reopened = new notifications.Notifications(dir);
  assert.deepEqual(reopened.list().items.map((r) => r.id), [fresh.id]);
});

test('a half-written tail line does not take the inbox with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const inbox = new notifications.Notifications(dir);
  inbox.record(announcement({ title: 'intact' }));
  appendFileSync(join(dir, 'notifications.jsonl'), '{"id":"truncat');

  assert.equal(new notifications.Notifications(dir).list().items.length, 1);
});

/* ------------------------------------------------------------------ *
 * Where a notification goes
 * ------------------------------------------------------------------ */

/** Every tab id the plan view registers — the client's route-meta SSOT. */
function planTabs(): string[] {
  return [...PLAN_TABS];
}

/** Every top-level route head the shell registers — the client's route-meta SSOT. */
function appRoutes(): string[] {
  return [...ROUTE_HEADS];
}

test('every category resolves to a route the client actually matches', () => {
  const tabs = planTabs();
  const routes = appRoutes();
  assert.ok(tabs.includes('run'), 'the plan view must still register a run tab');

  for (const category of catalogue.CATEGORIES) {
    const url = catalogue.routeFor(category.id, { slug: 'demo', phase: 4 });
    const parsed = router.parseHash(url.replace(/^\//, ''));
    const [head, ...rest] = parsed.segments;

    assert.ok(routes.includes(head), `${category.id} → ${url} — the shell has no "${head}" route`);
    if (head === 'plan') {
      const [, tab] = rest;
      // The exact defect this test exists for: `autopilot` parsed fine, matched
      // no tab, and silently fell back to Route.
      assert.ok(tab === undefined || tabs.includes(tab) || tab === 'phase' || tab === 'handoff',
        `${category.id} → ${url} — "${tab}" is not a tab the plan view registers`);
    }
  }
});

test('the categories that mean "a run needs you" land on the run itself', () => {
  for (const id of ['approval', 'needs-you', 'halted', 'parked', 'finished'] as const) {
    assert.equal(catalogue.routeFor(id, { slug: 'demo' }), '/#/plan/demo/run',
      `${id} must open the queue and the console, not the Route map`);
  }
});

test('the rest of the table is what it says it is', () => {
  assert.equal(catalogue.routeFor('phase', { slug: 'demo', phase: 7 }), '/#/plan/demo/phase/7');
  assert.equal(catalogue.routeFor('ready', { slug: 'demo' }), '/#/ready');
  assert.equal(catalogue.routeFor('changed', { slug: 'demo' }), '/#/plan/demo/route');
  assert.equal(catalogue.routeFor('health'), '/#/settings');
});

test('a missing slug degrades upward instead of building #/plan/undefined', () => {
  assert.equal(catalogue.routeFor('approval'), '/#/runs');
  assert.equal(catalogue.routeFor('phase', { slug: 'demo' }), '/#/plan/demo/run', 'no phase number, so the run will do');
  assert.equal(catalogue.routeFor('changed'), '/#/plans');
});

test('a slug with a slash in it cannot escape its route', () => {
  const url = catalogue.routeFor('approval', { slug: 'a/b?c' });
  assert.equal(url, '/#/plan/a%2Fb%3Fc/run');
  assert.deepEqual(router.parseHash(url.replace(/^\//, '')).segments, ['plan', 'a/b?c', 'run']);
});

test('the router reads the URL form the server produces', () => {
  // The server builds `/#/…` because a service worker resolves it against the
  // origin; a hash link is `#/…`; an internal call is bare. All three mean one
  // route, and `toHash` is where that stops being three different bugs.
  const forms = ['plan/demo/run', '/plan/demo/run', '#/plan/demo/run', '/#/plan/demo/run'];
  assert.deepEqual([...new Set(forms.map(router.toHash))], ['#/plan/demo/run']);
});

/* ------------------------------------------------------------------ *
 * A decision made anywhere is true everywhere
 * ------------------------------------------------------------------ */

function pendingFile() {
  return join(mkdtempSync(join(tmpdir(), 'inbox-')), 'pending.json');
}

function ask(approvals: InstanceType<typeof approvalsMod.Approvals>) {
  return approvals.request({
    runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool',
    title: 'Bash: git commit -m wip', detail: 'phase 2 wants to commit',
    evidence: [],
    tool: { name: 'Bash', input: { command: 'git commit -m wip' } },
  });
}

test('a decision broadcasts, and creation still fires before it', async () => {
  const created: string[] = [];
  const resolved: string[] = [];
  const approvals = new approvalsMod.Approvals({
    notify: (a) => created.push(a.status),
    resolved: (a) => resolved.push(`${a.status}:${a.decidedBy}`),
  }, pendingFile());
  approvals.arm('run-1');

  const { approval, decided } = ask(approvals);
  assert.deepEqual(created, ['pending'], 'the create-only contract is unchanged');
  assert.deepEqual(resolved, [], 'and nothing has been resolved yet');

  approvals.settle(approval.id, 'allow', 'phone');
  await decided;
  assert.deepEqual(resolved, ['allow:phone'], 'the resolution carries the status and who made it');
});

test('a timeout resolves through the same hook as a click', async () => {
  const resolved: string[] = [];
  const approvals = new approvalsMod.Approvals({ resolved: (a) => resolved.push(`${a.status}:${a.decidedBy}`) }, pendingFile());
  approvals.arm('run-1');

  // A 5ms answer window: the ending nobody is watching for.
  const { decided } = approvals.request({
    runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool',
    title: 'Bash: rm -rf', detail: 'nobody is awake', evidence: [],
  }, 5);
  await decided;
  assert.deepEqual(resolved, ['deny:timeout'], 'silence still answers deny, and now it says so out loud');
});

test('a run ending under a pending card resolves it rather than leaving a phantom', async () => {
  const resolved: string[] = [];
  const approvals = new approvalsMod.Approvals({ resolved: (a) => resolved.push(`${a.status}:${a.decidedBy}`) }, pendingFile());
  approvals.arm('run-1');
  const { decided } = ask(approvals);

  approvals.disarm();
  await decided;
  assert.deepEqual(resolved, ['deny:run ended']);
});

test('a listener that throws cannot stop a decision', async () => {
  const approvals = new approvalsMod.Approvals({
    resolved: () => { throw new Error('a dead client'); },
  }, pendingFile());
  approvals.arm('run-1');
  const { approval, decided } = ask(approvals);
  approvals.settle(approval.id, 'allow', 'console');
  assert.equal((await decided).decision, 'allow');
});

test('the bare-function constructor still means notify-on-creation', () => {
  const seen: string[] = [];
  const approvals = new approvalsMod.Approvals((a) => seen.push(a.title), pendingFile());
  approvals.arm('run-1');
  ask(approvals);
  assert.deepEqual(seen, ['Bash: git commit -m wip']);
});

/* ------------------------------------------------------------------ *
 * The API
 * ------------------------------------------------------------------ */

type Captured = { status: number; body: unknown };

async function call(
  service: unknown, method: string, path: string, { body = {}, header = true } = {},
): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null };
  const res = {
    writeHead(status: number) { out.status = status; return this; },
    end(text: string) { try { out.body = JSON.parse(text); } catch { out.body = text; } },
    on() { return this; },
  };
  const req = {
    method,
    headers: header ? { 'x-phase-console': '1' } : {},
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {
      if (method !== 'GET') yield Buffer.from(JSON.stringify(body));
    },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** Just enough Service for the routes under test — no source directory needed. */
function fakeService(over: Record<string, unknown> = {}) {
  const inbox = store();
  return {
    flags: { allowWrites: false, allowRun: true },
    store: null,
    inbox: (query: never) => inbox.list(query),
    markNotificationsRead: (ids: string[] | null) => ({ changed: inbox.markRead(ids), unread: inbox.unread() }),
    clearNotifications: (what: never) => ({ removed: inbox.clear(what), unread: inbox.unread() }),
    restartReadiness: () => ({ ok: true, supervisor: { kind: 'launchd', supervised: true, detail: 'x' }, busy: false, run: null }),
    restart: () => ({ ok: true }),
    _inbox: inbox,
    ...over,
  };
}

test('the inbox is readable with no source directory open', async () => {
  // Deliberately ahead of the "no source directory" wall: a console that has
  // not been pointed at a repo yet can still have been told the watcher died.
  const service = fakeService();
  service._inbox.record(announcement());
  const out = await call(service, 'GET', '/api/notifications');
  assert.equal(out.status, 200);
  assert.equal((out.body as { items: unknown[] }).items.length, 1);
});

test('mutating the inbox needs the console header and nothing more', async () => {
  const service = fakeService();
  service._inbox.record(announcement());

  const refused = await call(service, 'POST', '/api/notifications/read', { header: false });
  assert.equal(refused.status, 403, 'another page must not be able to clear your inbox');

  const ok = await call(service, 'POST', '/api/notifications/read');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { changed: 1, unread: 0 });
});

test('a delete with no scope clears nothing', async () => {
  const service = fakeService();
  service._inbox.record(announcement());

  const vague = await call(service, 'DELETE', '/api/notifications');
  assert.equal(vague.status, 400, 'the most destructive reading must never be the default');
  assert.equal(service._inbox.list().items.length, 1);

  const all = await call(service, 'DELETE', '/api/notifications?scope=all');
  assert.equal(all.status, 200);
  assert.equal(service._inbox.list().items.length, 0);
});

test('restarting is refused without --allow-run', async () => {
  const service = fakeService({ flags: { allowWrites: true, allowRun: false } });
  const out = await call(service, 'POST', '/api/restart');
  assert.equal(out.status, 403);
  assert.match(String((out.body as { error: string }).error), /--allow-run/);
});

test('a refused restart answers 409, not 200', async () => {
  const service = fakeService({
    restart: () => ({ ok: false, reason: 'a run is in flight' }),
  });
  const out = await call(service, 'POST', '/api/restart');
  assert.equal(out.status, 409, 'a button that returns 200 and does nothing is the failure being avoided');
});

/* ------------------------------------------------------------------ *
 * Is anything going to start it again?
 * ------------------------------------------------------------------ */

test('a process nothing is watching is reported as unsupervised', async () => {
  const { detectSupervisor } = await import('../server/lifecycle.ts');
  const bare = detectSupervisor({} as NodeJS.ProcessEnv, 'darwin');
  assert.equal(bare.supervised, false);
  assert.equal(bare.kind, 'none');

  // launchd's own idle marker, not a job label.
  const idle = detectSupervisor({ XPC_SERVICE_NAME: '0' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(idle.supervised, false, '"0" is what a terminal gets, and it is not a job');
});

test('an explicit declaration wins in both directions', async () => {
  const { detectSupervisor } = await import('../server/lifecycle.ts');
  assert.equal(detectSupervisor({ PHASE_CONSOLE_SUPERVISED: '1' } as NodeJS.ProcessEnv, 'linux').supervised, true);
  assert.equal(
    detectSupervisor({ PHASE_CONSOLE_SUPERVISED: '0', XPC_SERVICE_NAME: 'com.phase-console' } as NodeJS.ProcessEnv, 'darwin').supervised,
    false,
    'a launchd job whose operator said no is still a no',
  );
});

test('KeepAlive is read from the plist rather than assumed', async () => {
  const { detectSupervisor } = await import('../server/lifecycle.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');

  const home = mkdtempSync(join(tmpdir(), 'launchd-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const plist = (keepAlive: string) =>
    `<plist><dict><key>Label</key><string>com.test</string>${keepAlive}</dict></plist>`;

  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.test.plist'),
    plist('<key>KeepAlive</key><true/>'));
  const on = detectSupervisor({ HOME: home, XPC_SERVICE_NAME: 'com.test' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(on.supervised, true);
  assert.equal(on.assumed, undefined, 'it was read, so it is not an assumption');

  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.test.plist'),
    plist('<key>KeepAlive</key><false/>'));
  const off = detectSupervisor({ HOME: home, XPC_SERVICE_NAME: 'com.test' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(off.supervised, false, 'KeepAlive off means exiting stops the console rather than restarting it');

  // A job whose plist cannot be found: supervision is inferred, and says so.
  const unknown = detectSupervisor({ HOME: home, XPC_SERVICE_NAME: 'com.absent' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(unknown.supervised, true);
  assert.equal(unknown.assumed, true);
});

/* ------------------------------------------------------------------ *
 * The gate: one switch per category, in front of every leg
 * ------------------------------------------------------------------ */

/**
 * The failure being pinned here is a toggle that lied.
 *
 * Categories used to be stored per subscribed push device, so they filtered
 * exactly one of the four legs an announcement leaves by. With "Plans changed
 * on disk" switched off, the inbox record was still written, the SSE event was
 * still emitted and `PHASE_CONSOLE_NOTIFY` was still run — and a console with
 * no device subscribed had nowhere to store the preference in the first place.
 * That is how an inbox reaches 182 unread notifications in a category that is
 * off by default.
 *
 * So the matrix is table-driven over the catalogue rather than written per
 * category: a category added later is covered the day it is added, and the test
 * fails if a fifth leg is ever attached above the gate.
 */

/** The out-of-band leg is a spawned process; wait for the ledger to settle. */
async function outOfBandLines(expected: number): Promise<string[]> {
  const read = () => (existsSync(NOTIFY_LOG)
    ? readFileSync(NOTIFY_LOG, 'utf8').split('\n').filter(Boolean)
    : []);
  for (let i = 0; i < 200 && read().length < expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // A grace beyond the last expected line, so a leaked announcement has time to
  // show up and fail the assertion rather than racing past it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return read();
}

test('every category is gated on all four legs, in both directions', async () => {
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR } = await import('../server/config.ts');

  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);

  // Leg 2 — the SSE event a tab would receive.
  const emitted: string[] = [];
  service.onEvent((event, data) => {
    if (event === 'notification') emitted.push((data as { title: string }).title);
  });

  // Leg 4 — push. Replaced rather than driven through a real subscription on
  // purpose: the point is that the gate holds with ZERO devices registered,
  // which is exactly the console that had no per-device preference to consult.
  const pushed: string[] = [];
  service.push.announce = ((_category: unknown, message: { title: string }) => {
    pushed.push(message.title);
  }) as typeof service.push.announce;
  assert.equal(service.push.list().length, 0, 'the whole matrix runs with no device subscribed');

  const announce = (service as unknown as {
    announce: (c: string, m: { title: string; body: string; tag: string }) => unknown;
  }).announce.bind(service);

  const allOff = Object.fromEntries(catalogue.CATEGORIES.map((c) => [c.id, false]));
  const expectedOutOfBand: string[] = [];

  for (const category of catalogue.CATEGORIES) {
    // ---- enabled: all four legs fire ----
    service.savePreferences({ notify: { ...allOff, [category.id]: true } } as never);
    const on = `on:${category.id}`;
    const record = announce(category.id, { title: on, body: 'body', tag: `tag-on-${category.id}` });
    expectedOutOfBand.push(`Phase Console: ${on}`);

    assert.ok(record, `${category.id}: enabled must produce a record`);
    assert.equal(
      service.inbox({ limit: 500 }).items.filter((r) => r.title === on).length, 1,
      `${category.id}: enabled must be written to the inbox exactly once`,
    );
    assert.ok(emitted.includes(on), `${category.id}: enabled must emit over SSE`);
    assert.ok(pushed.includes(on), `${category.id}: enabled must reach the push leg`);

    // ---- disabled: nothing, anywhere ----
    service.savePreferences({ notify: { ...allOff, [category.id]: false } } as never);
    const off = `off:${category.id}`;
    const suppressed = announce(category.id, { title: off, body: 'body', tag: `tag-off-${category.id}` });

    assert.equal(suppressed, null, `${category.id}: disabled must announce nothing`);
    assert.equal(
      service.inbox({ limit: 500 }).items.filter((r) => r.title === off).length, 0,
      `${category.id}: disabled must not write an inbox record — this is what keeps the unread count honest`,
    );
    assert.ok(!emitted.includes(off), `${category.id}: disabled must not emit over SSE`);
    assert.ok(!pushed.includes(off), `${category.id}: disabled must not reach the push leg`);
  }

  // Leg 3 — the operator's own notifier, asserted once for the whole matrix
  // because it is the only leg that leaves the process.
  const lines = await outOfBandLines(expectedOutOfBand.length);
  assert.deepEqual(
    [...lines].sort(), [...expectedOutOfBand].sort(),
    'the notifier ran for exactly the enabled announcements and for none of the disabled ones',
  );
});

test('the firehose is off out of the box, and what stops work is on', () => {
  const defaults = catalogue.defaultCategories();
  assert.equal(defaults.changed, false, '"plans changed on disk" is a firehose and must default to silent');
  assert.equal(defaults.ready, false, 'work becoming ready is frequent and must default to silent');
  for (const id of ['approval', 'needs-you', 'halted'] as const) {
    assert.equal(defaults[id], true, `${id} stops work dead and must default to on`);
  }
});

test('a category absent from a stored config takes its own default, not undefined', async () => {
  const { sanitiseCategories } = await import('../server/push/catalogue.ts');

  // What a config written by an older version looks like once a category is
  // added: the key simply is not there. Reading it as `undefined` would gate
  // the new category off — silently, and in the direction that loses
  // notifications rather than the one that merely annoys.
  const stored = sanitiseCategories({ changed: true });
  assert.equal(stored.changed, true, 'what was stored is honoured');
  for (const category of catalogue.CATEGORIES) {
    assert.equal(typeof stored[category.id], 'boolean', `${category.id} must resolve to a real boolean`);
    if (category.id !== 'changed') {
      assert.equal(stored[category.id], category.byDefault, `${category.id} falls back to its catalogue default`);
    }
  }

  // Junk from a hand-edited file or an older client cannot turn anything on.
  assert.deepEqual(sanitiseCategories({ 'not-a-category': true }), catalogue.defaultCategories());
  assert.deepEqual(sanitiseCategories(null), catalogue.defaultCategories());
});

test('a toggle survives a restart, with no push device in the picture', async () => {
  const { Service, } = await import('../server/service.ts');
  const { SKILL_DIR, loadPrefs } = await import('../server/config.ts');

  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);

  // Start from the catalogue defaults explicitly: the config file is shared
  // with the matrix test above, and a test that depends on what ran before it
  // is a test that will lie later.
  service.savePreferences({ notify: catalogue.defaultCategories() } as never);
  assert.equal(service.state().prefs.notify.approval, true, 'baseline: approval is on by default');

  // One category, the way the Preferences card sends it: a delta, not the map.
  service.savePreferences({ notify: { changed: true } } as never);

  // A partial patch must not reset everything else to its default — that is the
  // difference between a PATCH and an accidental factory reset.
  assert.equal(service.state().prefs.notify.changed, true);
  assert.equal(service.state().prefs.notify.approval, true, 'untouched categories keep their value');

  service.savePreferences({ notify: { approval: false } } as never);
  assert.equal(service.state().prefs.notify.changed, true, 'the earlier choice survived the second patch');
  assert.equal(service.state().prefs.notify.approval, false);

  // The restart: what a fresh process would read off disk.
  const reloaded = loadPrefs();
  assert.equal(reloaded.notify.changed, true, 'preferences live in config.json, not in a device record');
  assert.equal(reloaded.notify.approval, false);
});

/* ------------------------------------------------------------------ *
 * resolveWhere — a subject that dissolved stands its records down
 * ------------------------------------------------------------------ */

test('resolveWhere annotates the scoped records, marks them read, and survives a reload', async () => {
  const { Notifications } = await import('../server/notifications.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-notif-resolve-'));
  const store = new Notifications(dir);
  const halted = store.record({
    category: 'halted', title: 'demo halted', body: 'phase 2 did not verify',
    runId: 'run-1', slug: 'demo',
  });
  store.record({
    category: 'halted', title: 'other halted', body: 'x', runId: 'run-2', slug: 'other',
  });
  store.record({
    category: 'finished', title: 'demo finished', body: 'y', runId: 'run-1', slug: 'demo',
  });

  const changed = store.resolveWhere({ runId: 'run-1', category: 'halted' }, 'the board moved past the halt');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, halted.id);
  assert.equal(changed[0].read, true);
  assert.match(changed[0].resolved!.reason, /moved past/);

  // Scoped: the other run's card and the finished card are untouched.
  assert.equal(store.list({}).items.filter((row) => row.resolved).length, 1);
  // Idempotent: an already-resolved record is not changed twice.
  assert.equal(store.resolveWhere({ runId: 'run-1', category: 'halted' }, 'again').length, 0);
  // An empty scope matches nothing — same discipline as markReadWhere.
  assert.equal(store.resolveWhere({}, 'nothing').length, 0);

  // The annotation is JSONL-durable (flush past the debounce first).
  store.flush();
  const reloaded = new Notifications(dir);
  assert.equal(
    reloaded.list({}).items.find((row) => row.id === halted.id)?.resolved?.reason,
    'the board moved past the halt');
});

test('a run-level errand reaches the push channel, like a phase one', async () => {
  // Converge writes an errand for a stop that belongs to no single phase, and
  // `ConvergeDeps.announceErrand` types the parameter `number | null` precisely
  // so it can. The service's implementation then dropped every one of them:
  // `if (typeof phase !== 'number') return`. The ask was stored on the run and
  // rendered on the run page — and never pushed, which is the one thing an
  // errand exists to do: reach somebody who is not already looking.
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);

  const sent: Array<{ title: string; body: string }> = [];
  service.push.announce = ((_c: unknown, message: { title: string; body: string }) => {
    sent.push(message);
  }) as typeof service.push.announce;

  const announceErrand = (service as unknown as {
    announceErrand: (data: unknown) => void;
  }).announceErrand.bind(service);

  const runLevel = {
    slug: 'demo', runId: 'r1', phase: null,
    errand: { at: '2026-08-22T09:00:00.000Z', need: 'Someone to continue this run.', how: 'Press Continue.' },
  };
  announceErrand(runLevel);
  assert.equal(sent.length, 1, 'a run-level errand must be announced');
  assert.match(sent[0].title, /^demo needs you$/, 'and must not claim a phase it does not have');
  assert.match(sent[0].body, /Someone to continue this run/);

  // A phase errand is unchanged, and the dedupe still tells the two apart.
  announceErrand({
    slug: 'demo', runId: 'r1', phase: 2,
    errand: { at: '2026-08-22T09:00:00.000Z', need: 'A verdict.', how: 'Record it.' },
  });
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /phase 2 needs you/);

  announceErrand(runLevel);
  assert.equal(sent.length, 2, 'the same ask twice is still one ask');
});
