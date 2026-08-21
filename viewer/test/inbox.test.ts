/**
 * The unified inbox builder — the properties that make it usable, held against
 * a hand-built fact set with no service, no filesystem and no clock.
 *
 * `server/inbox.ts` is pure precisely so this file can exist: every question a
 * reviewer would otherwise have to answer by starting a console and stopping a
 * run ("does a signed-out account raise one row or two?", "does turning off
 * --allow-run hide the card or grey the button?") is answered here by
 * constructing the facts and reading the list.
 *
 * Five properties, each with its own failure story:
 *
 *   1. EXACTLY ONCE PER ASK. Eight sources feed the inbox and three of them
 *      overlap — `analysis/stats.ts` turns a failing QA row into a
 *      `HealthIssue{kind:'qa-fail'}` and an expired lock into a `stale-lock`,
 *      the same facts the `qa` and `lock` kinds raise from their own sources,
 *      and the synthesized `builtIn` account is the machine login the `auth`
 *      probe already speaks for. Each of those is one ask, and one ask that
 *      arrives as two rows has two ids, two acks, and one of them survives
 *      every dismissal.
 *
 *   2. THE ACK IS KEYED ON WHAT, NOT WHEN. An ack stamped before the item's
 *      own `since` is not an ack — the thing came back. Both halves are pinned:
 *      a stale ack must not hide, and a live one must.
 *
 *   3. A FLAG NEVER HIDES. A console without `--allow-run` still has to be told
 *      its run is parked on a permission card. The id set must be identical
 *      with every capability off and with every capability on; only
 *      `InboxAction.flag` may differ.
 *
 *   4. EVERY HREF RESOLVES. `#/plan/<slug>/autopilot` was hand-written at two
 *      call sites against a tab registered as `run`, and an unknown tab is not
 *      an error the router reports — it falls back silently, so every approval
 *      notification for the life of that feature opened the wrong tab. This
 *      file copies `test/route-contract.test.ts`'s assertion and applies it to
 *      every href the builder can emit.
 *
 *   5. THE ORDER IS A FUNCTION OF THE ITEMS. `sortInbox` owns it, this builder
 *      does not re-derive it, and the list it returns is already in it.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before `server/config.ts` resolves
// them — the console's real state directory holds the operator's acks, their
// approvals and their push subscriptions.
import './state-sandbox.ts';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acksFile,
  buildInbox,
  clearAcks,
  inboxIds,
  pruneAcks,
  readAcks,
  removeAck,
  writeAck,
  type InboxFacts,
  type InboxItem,
} from '../server/inbox.ts';
import { INBOX_KINDS, INBOX_SEVERITIES, inboxItemId, sortInbox } from '../shared/attention-model.js';
import { parseHash, toHash } from '../shared/routes.js';
import { PLAN_TABS, isRouteHead } from '../shared/route-meta.js';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

/* ------------------------------------------------------------------ *
 * The fact set — one of everything Phase 4 can raise, plus one of
 * everything it must NOT raise sitting right beside it.
 * ------------------------------------------------------------------ */

function facts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    runs: [
      {
        id: 'run-1',
        slug: 'demo',
        status: 'parked',
        updatedAt: '2026-08-22T10:00:00.000Z',
        halt: { at: '2026-08-22T09:00:00.000Z', reason: 'verification red', phase: 4, kind: 'verify-failed' },
        recoveries: {
          '4': {
            errand: {
              phase: 4,
              situation: 'verify-red',
              tried: ['re-ran the suite', 'read the transcript'],
              need: 'A look at why the suite is red.',
              how: 'Run it yourself, fix it, then press Recover & continue.',
              at: '2026-08-22T09:30:00.000Z',
            },
          },
          // A plan-wide repair slot. `errandsOf` filters on /^\d+$/, and
          // without that filter this leaks in as `phase: NaN`.
          plan: {
            errand: {
              phase: 0,
              situation: 'plan-broken',
              tried: [],
              need: 'never surfaced',
              how: 'never surfaced',
              at: '2026-08-22T09:31:00.000Z',
            },
          },
        },
      },
      // Stopped, no errand, not the operator's doing, nothing automatic will
      // touch it: the read-only-console case.
      {
        id: 'run-2',
        slug: 'other',
        status: 'halted',
        updatedAt: '2026-08-22T08:00:00.000Z',
        stoppedBy: 'system',
        halt: { at: '2026-08-22T07:45:00.000Z', reason: 'the session exited', kind: 'session-failed' },
      },
      { id: 'run-3', slug: 'ignored', status: 'finished' },
      { id: 'run-4', slug: 'dismissed', status: 'halted', resolved: { at: '2026-08-22T06:00:00.000Z' } },
      { id: 'run-5', slug: 'mine', status: 'paused', stoppedBy: 'operator' },
    ],
    approvals: [
      {
        id: 'a1',
        runId: 'run-1',
        slug: 'demo',
        phase: 4,
        kind: 'tool',
        title: 'Run `rm -rf build`?',
        detail: 'Outside the profile’s allow list.',
        createdAt: '2026-08-22T11:00:00.000Z',
        status: 'pending',
      },
      { id: 'a2', slug: 'demo', status: 'allow', createdAt: '2026-08-22T10:00:00.000Z' },
    ],
    plans: [
      {
        slug: 'demo',
        title: 'Demo plan',
        closed: false,
        updatedAt: '2026-08-22T07:00:00.000Z',
        qaMode: { mode: 'on' },
        qa: [
          { phase: 2, result: 'fail', report: 'two assertions red' },
          { phase: 3, result: 'pending' },
          // Pending on a phase nobody has finished: the table's resting state.
          { phase: 5, result: 'pending' },
        ],
        issues: [
          // Owned by the `qa` kind — must not become a second row.
          { slug: 'demo', severity: 'error', kind: 'qa-fail', message: 'phase 2 failed QA', phase: 2 },
          { slug: 'demo', severity: 'error', kind: 'undefined-dep', message: 'phase 7 depends on 99', phase: 7 },
          { slug: 'demo', severity: 'warning', kind: 'stale-handoff', message: 'not an error' },
        ],
        phases: [
          { phase: 2, title: 'Two', state: 'done' },
          { phase: 3, title: 'Three', state: 'done' },
          { phase: 5, title: 'Five', state: 'ready' },
          {
            phase: 6,
            title: 'Six',
            state: 'ready',
            gated: true,
            gateCheck: 'a human look at the screenshots',
            gateKind: 'human',
            gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' },
          },
          // Gated and already done: the gate is behind it.
          { phase: 8, title: 'Eight', state: 'done', gated: true, gate: { clear: false, kind: 'human', detail: 'x' } },
          { phase: 7, title: 'Seven', state: 'ready' },
        ],
      },
      // A closed plan keeps a live process's voice but reports no progress:
      // no gate, no QA.
      {
        slug: 'shelved',
        closed: true,
        updatedAt: '2026-08-20T07:00:00.000Z',
        qaMode: { mode: 'on' },
        qa: [{ phase: 1, result: 'fail' }],
        phases: [
          { phase: 1, state: 'done' },
          { phase: 2, state: 'ready', gated: true, gate: { clear: false, kind: 'human', detail: 'x' } },
        ],
      },
    ],
    locks: [
      { slug: 'demo', phase: 9, owner: 'alice', expired: true, leaseUntil: Date.parse('2026-08-22T06:00:00.000Z') },
      { slug: 'demo', phase: 10, owner: 'bob', expired: false, session: 's-ended' },
      { slug: 'demo', phase: 11, owner: 'carol', expired: false, session: 's-live' },
      { slug: 'demo', phase: 12, owner: 'dan', expired: false, session: 's-unknown' },
    ],
    lockPresence: { 'demo:10': 'ended', 'demo:11': 'live', 'demo:12': 'unknown' },
    queue: {
      live: 0,
      queued: 1,
      entries: [
        {
          slug: 'demo',
          phase: 13,
          since: NOW - 60_000,
          waitingOn: [{ kind: 'lock', slug: 'demo', phase: 9, owner: 'alice' }],
        },
      ],
    },
    accounts: [
      // The synthesized machine login — `auth` below already speaks for it.
      { id: 'default', builtIn: true, authState: 'signed-out' },
      { id: 'work', name: 'Work', authState: 'expired' },
      // Permanent and correct for a setup-token account.
      { id: 'tok', kind: 'token', authState: 'unknown' },
      { id: 'fine', name: 'Fine', authState: 'ok' },
    ],
    auth: { loggedIn: false, checkedAt: '2026-08-22T11:59:00.000Z' },
    mcp: [
      { id: 'ctx7', label: 'Context7', enabled: true, status: 'needs-auth' },
      { id: 'files', label: 'Files', enabled: true, status: 'failed', needsConfig: ['MCP_FS_ROOT'] },
      // Connected: a tool change alone is not a wall.
      { id: 'ok', label: 'Fine', enabled: true, status: 'connected', toolsChanged: { seenAt: '2026-08-22T04:00:00.000Z' } },
      { id: 'off', label: 'Disabled', enabled: false, status: 'needs-auth' },
      // The probe could not run. "I could not check" is not "they are down".
      { id: 'unk', label: 'Unknown', enabled: true, status: 'unknown' },
      { id: 'soon', label: 'Pending', enabled: true, status: 'pending' },
    ],
    environment: [
      { kind: 'path-missing-dir', detail: 'PATH names /opt/gone, which does not exist', fix: 'Re-run agent.sh install.' },
    ],
    watcher: { healthy: false, watching: 1, expected: 3, failures: 2 },
    degraded: { healthy: false, recent: [{ kind: 'push', message: 'delivery failed twice', at: '2026-08-22T05:00:00.000Z' }] },
    flags: {
      allowWrites: true,
      allowRun: true,
      allowTerminal: true,
      allowAgent: true,
      allowAccounts: true,
      allowMcp: true,
    },
    acks: {},
    ...over,
  };
}

const byKind = (items: readonly InboxItem[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
};

const find = (items: readonly InboxItem[], id: string): InboxItem | undefined => items.find((i) => i.id === id);

/** The one errand the fixture's ladder wrote — the id every ack test keys on. */
const ERRAND_ID = inboxItemId({ kind: 'errand', slug: 'demo', phase: 4, runId: 'run-1', subject: 'verify-red' });

/* ------------------------------------------------------------------ *
 * The shape of the answer
 * ------------------------------------------------------------------ */

test('no facts at all is an empty view, not an exception', () => {
  // The inbox is a diagnostic surface: a console with nothing open, or one
  // whose gatherers all failed, must still answer. A 500 here is the one
  // outcome that leaves an operator with no way to find out what is wrong.
  const view = buildInbox({}, NOW);
  assert.deepEqual(view.items, []);
  assert.equal(view.generatedAt, '2026-08-22T12:00:00.000Z');

  const bare = buildInbox(undefined, NOW);
  assert.deepEqual(bare.items, [], 'buildInbox() with no facts at all must not throw');
});

test('every kind Phase 4 produces is produced, and exactly as often as there are asks', () => {
  const { items } = buildInbox(facts(), NOW);

  assert.deepEqual(byKind(items), {
    // the ladder's errand, plus the stop nothing automatic will touch
    errand: 2,
    approval: 1,
    gate: 1,
    'sign-in': 2,
    'mcp-auth': 2,
    qa: 2,
    lock: 2,
    // environment + watcher + degraded + the plan's own error issue
    health: 4,
  });

  // Every word this builder emits must be in the shared vocabulary, which
  // `test/attention-model.test.ts` in turn holds equal to the client's unions.
  for (const item of items) {
    assert.ok(INBOX_KINDS.includes(item.kind), `${item.id}: '${item.kind}' is not an INBOX_KIND`);
    assert.ok(INBOX_SEVERITIES.includes(item.severity), `${item.id}: '${item.severity}' is not a severity`);
    assert.equal(typeof item.title, 'string');
    assert.ok(item.need, `${item.id}: every item must say what is needed`);
    assert.ok(item.how, `${item.id}: every item must say how to give it`);
    assert.ok(Array.isArray(item.actions), `${item.id}: actions is a list, empty is allowed`);
  }
});

test('stall and ruling are declared and produced by nobody', () => {
  // Phase 5 writes both detectors. They are in the vocabulary from the first
  // day so landing them changes no type, no route and no stored ack — but
  // until then, nothing may quietly start emitting one.
  const { items } = buildInbox(facts(), NOW);
  assert.equal(items.filter((i) => i.kind === 'stall').length, 0);
  assert.equal(items.filter((i) => i.kind === 'ruling').length, 0);
});

test('the asks the fixture must NOT raise are not raised', () => {
  const { items } = buildInbox(facts(), NOW);
  const ids = items.map((i) => i.id);

  const absent = (needle: string, why: string) =>
    assert.ok(!ids.some((id) => id.includes(needle)), `${why} — found ${ids.filter((i) => i.includes(needle))}`);

  absent('plan-broken', 'a `plan` recovery slot is not a phase errand');
  absent(':run-3', 'a finished run is not waiting on anybody');
  absent(':run-4', 'a resolved run keeps its record and stops being asked about');
  absent(':run-5', "an operator's own stop is not an ask");
  absent('a2', 'a settled approval is history');
  absent('shelved', 'a closed plan reports no progress');
  absent('demo:11', 'an unexpired lock whose session is live is a queue to wait in');
  absent('demo:12', 'an unexpired lock with unknown presence is not debris');
  absent('sign-in::::tok', 'authState `unknown` is permanent and correct for a token account');
  absent('mcp-auth::::off', 'a disabled server asks nothing');
  absent('mcp-auth::::unk', 'a probe that could not run degrades nothing');
  absent('mcp-auth::::soon', 'pending is not a wall');
  absent('mcp-auth::::ok', 'a tool change on a connected server is not a sign-in');

  // Gated but already done, and pending QA on a phase nobody finished.
  assert.equal(items.filter((i) => i.kind === 'gate').length, 1, 'only the open gate asks');
  assert.deepEqual(
    items.filter((i) => i.kind === 'qa').map((i) => i.phase).sort(),
    [2, 3],
    'a pending QA row on an unfinished phase is the table at rest',
  );
});

/* ------------------------------------------------------------------ *
 * Identity, dedupe and order
 * ------------------------------------------------------------------ */

test('ids are minted by inboxItemId and by nothing else', () => {
  const { items } = buildInbox(facts(), NOW);

  const expected = [
    ERRAND_ID,
    inboxItemId({ kind: 'errand', slug: 'other', runId: 'run-2', subject: 'unattended-stop' }),
    inboxItemId({ kind: 'approval', slug: 'demo', phase: 4, runId: 'run-1', subject: 'a1' }),
    inboxItemId({ kind: 'gate', slug: 'demo', phase: 6 }),
    inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }),
    inboxItemId({ kind: 'qa', slug: 'demo', phase: 3, subject: 'pending' }),
    inboxItemId({ kind: 'sign-in', subject: 'machine' }),
    inboxItemId({ kind: 'sign-in', subject: 'work' }),
    inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }),
    inboxItemId({ kind: 'mcp-auth', subject: 'files' }),
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 9, subject: 'expired' }),
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 10, subject: 'ended' }),
    inboxItemId({ kind: 'health', subject: 'path-missing-dir' }),
    inboxItemId({ kind: 'health', subject: 'watcher' }),
    inboxItemId({ kind: 'health', subject: 'push' }),
    inboxItemId({ kind: 'health', slug: 'demo', phase: 7, subject: 'undefined-dep' }),
  ];

  assert.deepEqual([...items.map((i) => i.id)].sort(), [...expected].sort());

  // The subject never leaves the server, so an id cannot be re-derived from a
  // fetched item — the shared model says so and this is what it means.
  assert.equal(ERRAND_ID, 'errand:demo:4:run-1:verify-red');
  assert.ok(!('subject' in (find(items, ERRAND_ID) as object)), 'subject must not ride the wire');
});

test('one fact that two sources report is one row', () => {
  const { items } = buildInbox(facts(), NOW);

  // `analysis/stats.ts` reports a failing QA row as HealthIssue{kind:'qa-fail'}
  // and the `qa` kind reports it from `PlanRecord.qa`. Two ids, two acks, and
  // dismissing either leaves the other — so the health side is suppressed by
  // construction rather than deduped by id, because the ids genuinely differ.
  assert.equal(items.filter((i) => i.id.includes('qa-fail')).length, 0);
  assert.equal(items.filter((i) => i.kind === 'qa' && i.phase === 2).length, 1);

  // The synthesized `builtIn` account IS the machine login the `auth` probe
  // already speaks for.
  assert.equal(items.filter((i) => i.kind === 'sign-in').length, 2);
  assert.ok(find(items, inboxItemId({ kind: 'sign-in', subject: 'machine' })));
  assert.equal(items.filter((i) => i.id.endsWith(':default')).length, 0);

  // And nothing anywhere may share an id with anything else.
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'two rows with one id means one ack silencing two asks');
});

test('the list arrives in sortInbox order: worst first, then oldest first', () => {
  const view = buildInbox(facts(), NOW);
  assert.deepEqual(view.items, sortInbox(view.items), 'the builder must not re-derive the order');

  const ranks = view.items.map((i) => INBOX_SEVERITIES.indexOf(i.severity));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'severity must be non-decreasing down the list');

  // The permission card is urgent and carries a real clock; the machine
  // sign-out is urgent with no clock at all, and an item with no clock sorts
  // LAST within its severity rather than pinning itself to the top forever.
  assert.equal(view.items[0].kind, 'approval');
  assert.equal(view.items[1].id, inboxItemId({ kind: 'sign-in', subject: 'machine' }));
  assert.equal(
    view.items[view.items.length - 1].id,
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 10, subject: 'ended' }),
  );

  const urgent = view.items.filter((i) => i.severity === 'urgent').map((i) => i.kind);
  assert.deepEqual(urgent, ['approval', 'sign-in'], 'urgent is reserved for what is stopped dead and costing');
});

/* ------------------------------------------------------------------ *
 * Acknowledgement
 * ------------------------------------------------------------------ */

test('an ack older than the item’s own since is not an ack — the thing came back', () => {
  // The errand's clock is 09:30. An ack from 09:00 was given to an EARLIER
  // instance of the same ask; treating it as current is how a wall that was
  // fixed, then broke again, stays silently acknowledged.
  const stale = buildInbox(facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T09:00:00.000Z', by: 'me' } } }), NOW);
  const item = find(stale.items, ERRAND_ID);
  assert.ok(item, 'a stale ack must not hide the item');
  assert.equal(item.ack, undefined, 'and must not be reported as an acknowledgement');

  const live = buildInbox(facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'me' } } }), NOW);
  assert.equal(find(live.items, ERRAND_ID), undefined, 'a live ack hides the item by default');
});

test('default hides acked items; all:true includes them, carrying the ack', () => {
  const acked = facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'mobin' } } });

  const hidden = buildInbox(acked, NOW);
  const shown = buildInbox(acked, NOW, { all: true });

  assert.equal(hidden.items.length, shown.items.length - 1);
  assert.equal(find(hidden.items, ERRAND_ID), undefined);
  assert.deepEqual(find(shown.items, ERRAND_ID)?.ack, { at: '2026-08-22T10:00:00.000Z', by: 'mobin' });

  // `inboxIds` is the keep-set `pruneAcks` needs, and it must be the FULL id
  // space — deriving it from the filtered list would prune the ack of every
  // item the filter just hid, un-acking everything on the next request.
  const ids = inboxIds(acked, NOW);
  assert.ok(ids.includes(ERRAND_ID));
  assert.equal(ids.length, shown.items.length);
});

test('an item with no clock keeps its ack, because absence is what un-acks it', () => {
  // A signed-out account records no WHEN, so `since` is empty and no timestamp
  // comparison can tell a returning sign-out from the acknowledged one. That
  // is `pruneAcks`' job, and it is why the ack must survive here.
  const id = inboxItemId({ kind: 'sign-in', subject: 'machine' });
  const view = buildInbox(facts({ acks: { [id]: { at: '2020-01-01T00:00:00.000Z' } } }), NOW, { all: true });
  const item = find(view.items, id);
  assert.equal(item?.since, '', 'a fact with no start clock must not invent one');
  assert.deepEqual(item?.ack, { at: '2020-01-01T00:00:00.000Z' });
});

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

test('a capability flag never hides an item — it disables the action and names the flag', () => {
  const on = buildInbox(facts(), NOW);
  const off = buildInbox(
    facts({
      flags: {
        allowWrites: false,
        allowRun: false,
        allowTerminal: false,
        allowAgent: false,
        allowAccounts: false,
        allowMcp: false,
      },
    }),
    NOW,
  );

  assert.deepEqual(off.items.map((i) => i.id), on.items.map((i) => i.id), 'a read-only console sees the same asks');

  // On a fully-capable console nothing is flagged: `flag` means "this cannot be
  // pressed", so its presence has to be information rather than decoration.
  for (const item of on.items) {
    for (const action of item.actions) {
      assert.equal(action.flag, undefined, `${item.id}/${action.verb} must not be flagged on a capable console`);
    }
  }

  const flagOf = (id: string, verb: string) => find(off.items, id)?.actions.find((a) => a.verb === verb)?.flag;
  assert.equal(flagOf(ERRAND_ID, 'recover'), 'run');
  assert.equal(flagOf(inboxItemId({ kind: 'approval', slug: 'demo', phase: 4, runId: 'run-1', subject: 'a1' }), 'allow'), 'run');
  assert.equal(flagOf(inboxItemId({ kind: 'gate', slug: 'demo', phase: 6 }), 'approve'), 'writes');
  assert.equal(flagOf(inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }), 'qa-session'), 'agent');
  assert.equal(flagOf(inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }), 'qa-record'), 'writes');
  assert.equal(flagOf(inboxItemId({ kind: 'sign-in', subject: 'work' }), 'login'), 'accounts');
  assert.equal(flagOf(inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }), 'login'), 'mcp');
  assert.equal(flagOf(inboxItemId({ kind: 'lock', slug: 'demo', phase: 9, subject: 'expired' }), 'release'), 'writes');

  // Dismissing a card is a judgement about what deserves attention, and a
  // console that cannot even do that is the dead end these cards were built to
  // end. Never flagged, on either console.
  assert.equal(flagOf(ERRAND_ID, 'dismiss'), undefined);
  assert.equal(flagOf(inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }), 'refresh'), undefined);
});

test('a server that can never connect is raised, with no sign-in button', () => {
  const { items } = buildInbox(facts(), NOW);
  const unconfigured = find(items, inboxItemId({ kind: 'mcp-auth', subject: 'files' }));
  assert.ok(unconfigured, '`needsConfig` raises: it is a wall, just not an auth one');
  assert.equal(
    unconfigured.actions.some((a) => a.verb === 'login'),
    false,
    'an unfilled ${VAR} can never connect, so a sign-in button would be a button that cannot work',
  );
  assert.ok(unconfigured.need.includes('MCP_FS_ROOT'), 'and it names what is missing');
});

test('the stop nothing automatic will touch is raised only while nothing will', () => {
  const halted = {
    id: 'run-9',
    slug: 'auto',
    status: 'halted',
    updatedAt: '2026-08-22T08:00:00.000Z',
    stoppedBy: 'system' as const,
    autoRecover: { attempts: 1 },
    halt: { at: '2026-08-22T07:00:00.000Z', reason: 'verification red' },
  };
  const only = (over: Partial<InboxFacts>) =>
    buildInbox({ runs: [halted], ...over }, NOW).items.filter((i) => i.kind === 'errand');

  assert.equal(only({ flags: { allowRun: true } }).length, 0, 'the ladder owns a run that opted in on a running console');
  assert.equal(only({ flags: { allowRun: false } }).length, 1, 'a read-only console must still be told');
  assert.equal(
    only({ flags: { allowRun: true }, runs: [{ ...halted, autoRecover: undefined }] as never }).length,
    1,
    'auto-recovery off means nothing climbs it by itself',
  );
  assert.equal(
    only({ flags: { allowRun: true }, runs: [{ ...halted, stoppedBy: 'operator' }] as never }).length,
    0,
    "an operator's own stop is not an ask",
  );
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

test('every href the builder can emit lands on a head the client registers', () => {
  // Copied from `test/route-contract.test.ts`, which explains why: an unknown
  // head or an unregistered plan tab is not an error the router reports — it
  // falls back silently, so a wrong href is a link that looks like it worked.
  const { items } = buildInbox(facts(), NOW, { all: true });
  assert.ok(items.length > 10, 'the fact set must actually exercise every builder');

  for (const item of items) {
    const { segments } = parseHash(toHash(item.href));
    assert.ok(isRouteHead(segments[0]), `${item.id} → ${item.href} — '${segments[0]}' is not in ROUTE_HEADS`);
    assert.ok(!item.href.includes('undefined'), `${item.id} leaked an undefined into ${item.href}`);
    if (segments[0] !== 'plan') continue;
    const tail = segments[2];
    assert.ok(
      PLAN_TABS.includes(tail) || tail === 'phase' || tail === 'handoff',
      `${item.id} targets plan tab '${tail}', which the plan view does not register`,
    );
  }
});

test('a slug that needs encoding survives into the href', () => {
  const { items } = buildInbox(
    {
      runs: [
        {
          id: 'r',
          slug: 'a plan/with?odd chars',
          status: 'halted',
          stoppedBy: 'system',
          halt: { at: '2026-08-22T07:00:00.000Z' },
        },
      ],
    },
    NOW,
  );
  const { segments } = parseHash(items[0].href);
  assert.deepEqual(segments, ['plan', 'a plan/with?odd chars', 'run']);
});

/* ------------------------------------------------------------------ *
 * The acks file
 * ------------------------------------------------------------------ */

/**
 * A disposable acks directory per test.
 *
 * Every acks function takes its directory as a parameter for exactly this
 * reason — the `launcher.ts` rule, same incident class: a test that reached
 * `INSTANCE_STATE_DIR` would be writing into the operator's own console state,
 * which is what `state-sandbox.ts` exists to make impossible and what this
 * makes unnecessary.
 */
const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-acks-'));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover tmpdir is not a failure */
    }
  }
});

test('acks round-trip through a file that outlives the process', () => {
  const dir = sandbox();

  // The console's dedupe maps (`notifiedRun` / `notifiedPhase`) are in-memory
  // and re-announce after a restart on purpose. An inbox may not: it
  // accumulates, so its acks have to be a real file.
  assert.deepEqual(readAcks(dir), {}, 'a missing file is "nothing is acknowledged", not an error');

  writeAck(dir, ERRAND_ID, 'mobin', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'lock:demo:9::expired', undefined, '2026-08-22T10:05:00.000Z');

  assert.deepEqual(readAcks(dir), {
    [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'mobin' },
    'lock:demo:9::expired': { at: '2026-08-22T10:05:00.000Z' },
  });

  assert.equal(removeAck(dir, ERRAND_ID), true);
  assert.equal(removeAck(dir, ERRAND_ID), false, 'removing what is not there is not an error');
  assert.deepEqual(Object.keys(readAcks(dir)), ['lock:demo:9::expired']);

  clearAcks(dir);
  assert.deepEqual(readAcks(dir), {});
  clearAcks(dir);
});

test('an unreadable acks file degrades to empty rather than taking the route down', () => {
  const dir = sandbox();
  writeFileSync(acksFile(dir), 'not json at all');
  assert.deepEqual(readAcks(dir), {});

  writeFileSync(acksFile(dir), JSON.stringify({ version: 99, acks: { x: { at: 'now' } } }));
  assert.deepEqual(readAcks(dir), {}, 'a version this console does not know is not readable state');

  writeFileSync(acksFile(dir), JSON.stringify({ version: 1, acks: { good: { at: 'a' }, bad: { by: 'no at' } } }));
  assert.deepEqual(readAcks(dir), { good: { at: 'a' } }, 'a malformed entry is dropped, the rest survives');
});

test('pruning drops the acks of asks that have gone, and only those', () => {
  const dir = sandbox();
  writeAck(dir, 'still-asking', 'me', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'gone-away', 'me', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'ancient', 'me', '2020-01-01T00:00:00.000Z');

  const dropped = pruneAcks(dir, ['still-asking', 'ancient'], { now: NOW });
  assert.equal(dropped, 2, 'the vanished one and the aged-out one');
  assert.deepEqual(Object.keys(readAcks(dir)), ['still-asking']);

  assert.equal(pruneAcks(dir, ['still-asking'], { now: NOW }), 0, 'nothing to do writes nothing');
});

test('an item that goes away and comes back returns unacknowledged', () => {
  // The whole reason `pruneAcks` exists: a signed-out account carries no clock,
  // so nothing about its `since` can say it is new. Absence can.
  const dir = sandbox();
  const id = inboxItemId({ kind: 'sign-in', subject: 'machine' });
  const out = facts({ auth: { loggedIn: false } });

  writeAck(dir, id, 'mobin', '2026-08-22T11:00:00.000Z');
  assert.equal(find(buildInbox({ ...out, acks: readAcks(dir) }, NOW).items, id), undefined, 'acked, so hidden');

  // Signed in: the item is gone, and the route prunes against the ids the
  // build produced.
  const back = facts({ auth: { loggedIn: true } });
  pruneAcks(dir, inboxIds(back, NOW), { now: NOW });
  assert.deepEqual(readAcks(dir), {}, 'its ack goes with it');

  // Signed out again — same id, no ack.
  const again = find(buildInbox({ ...out, acks: readAcks(dir) }, NOW).items, id);
  assert.ok(again, 'the ask returns');
  assert.equal(again.ack, undefined);
});

test('the acks file is written the way small JSON state is written here', () => {
  const dir = sandbox();
  writeAck(dir, 'x', 'me', '2026-08-22T10:00:00.000Z');
  const raw = readFileSync(acksFile(dir), 'utf8');
  assert.equal(JSON.parse(raw).version, 1, 'a version envelope, so a later shape is recognisable');
  assert.ok(raw.endsWith('\n'));
});
