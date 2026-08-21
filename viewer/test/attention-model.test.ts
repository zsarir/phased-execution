/**
 * The attention model — the inbox's two invariants, held here because nothing
 * else can hold them.
 *
 *   1. AGREEMENT. `client/src/lib/api/inbox.ts` carries the wire TYPES and
 *      `shared/attention-model.js` carries the VALUES. TypeScript unions erase
 *      at runtime, so no import can hold the pair together; this file reads the
 *      contract's source and asserts the same words in the same order. A kind
 *      added on one side and not the other fails here, on the day it lands.
 *
 *   2. IDENTITY. `inboxItemId` is the key an acknowledgement is stored under,
 *      in a file that outlives the process. An id that moves between two polls
 *      silently un-acks its item and asks the operator the same question again;
 *      an id shared by two different asks lets acknowledging one silence the
 *      other. So: stable (no clock, no counter, no prose), and injective over
 *      the five components — including the adversarial pairs a naive
 *      `[a, b].join(':')` would collide.
 *
 * The ordering tests pin the ties as hard as the ordering, because ties are
 * where a sort stops being a function of its input: `Array.sort` is stable, so
 * an under-specified comparator would leave the operator's list in whatever
 * order the server gathered its facts — reshuffling under the cursor between
 * two identical requests.
 */

// Nothing here reaches ../server, but the suite's rule is the redirect first
// and always — it costs one line and is never wrong.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  INBOX_KINDS,
  INBOX_KIND_LABELS,
  INBOX_SEVERITIES,
  SEVERITY_UI,
  STALL_KINDS,
  STALL_META,
  inboxItemId,
  sortInbox,
} from '../shared/attention-model.js';
import { UI_STATES, isUiState } from '../shared/status-vocab.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The words inside `export type X = 'a' | 'b' …;` in a source file — the
 * `status-vocab.test.ts` helper, copied rather than shared for the same reason
 * it exists there: the types erase, and a hand-copied word list in a test would
 * be a third place to forget.
 */
function unionWords(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  assert.ok(start >= 0, `${typeName} not found in the client contract`);
  const bare = source.slice(start).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body = bare.slice(0, bare.indexOf(';'));
  return [...body.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
}

const CONTRACT = readFileSync(here('../client/src/lib/api/inbox.ts'), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. Agreement with the client contract
 * ------------------------------------------------------------------ */

test('INBOX_KINDS is the InboxKind union, same words, same order', () => {
  const union = unionWords(CONTRACT, 'InboxKind');
  assert.deepEqual(
    [...INBOX_KINDS],
    union,
    'shared/attention-model.js and client/src/lib/api/inbox.ts have drifted — the union order is also the inbox sort tie-break, so a reorder is a behaviour change',
  );
  assert.equal(union.length, 10, union.join(','));
  assert.ok(Object.isFrozen(INBOX_KINDS), 'a vocabulary is frozen');
});

test('INBOX_SEVERITIES is the InboxSeverity union, worst first', () => {
  assert.deepEqual([...INBOX_SEVERITIES], unionWords(CONTRACT, 'InboxSeverity'));
  assert.deepEqual([...INBOX_SEVERITIES], ['urgent', 'needs-you', 'fyi'], 'index is rank');
  assert.ok(Object.isFrozen(INBOX_SEVERITIES));
});

test('the contract still spells the fields the model assumes', () => {
  // `inboxItemId` reads kind/slug/phase/runId; `sortInbox` reads severity,
  // since, kind and id. A rename on the wire that this file did not see would
  // otherwise show up as an inbox that sorts by nothing.
  for (const field of ['id', 'kind', 'severity', 'slug', 'phase', 'runId', 'since', 'ack']) {
    assert.match(CONTRACT, new RegExp(`\\n\\s*${field}\\??:`), `InboxItem.${field} is gone from the contract`);
  }
});

test('every kind has a label, and no label is for an unknown kind', () => {
  assert.deepEqual(Object.keys(INBOX_KIND_LABELS).sort(), [...INBOX_KINDS].sort());
  for (const kind of INBOX_KINDS) {
    const label = INBOX_KIND_LABELS[kind];
    assert.ok(label && label.length >= 2, kind);
    assert.ok(!label.endsWith('.'), `${kind}: a label is a noun phrase, never a sentence`);
  }
  assert.ok(Object.isFrozen(INBOX_KIND_LABELS));
});

test('every severity paints with a real UI state from the one status vocabulary', () => {
  assert.deepEqual(Object.keys(SEVERITY_UI).sort(), [...INBOX_SEVERITIES].sort());
  for (const severity of INBOX_SEVERITIES) {
    assert.ok(isUiState(SEVERITY_UI[severity]), `${severity} → ${SEVERITY_UI[severity]} is not a UI state`);
    assert.ok(UI_STATES.includes(SEVERITY_UI[severity] as never));
  }
  assert.equal(SEVERITY_UI['needs-you'], 'needs-you', 'the word and the state are the same word on purpose');
});

/* ------------------------------------------------------------------ *
 * 2. Identity — stability
 * ------------------------------------------------------------------ */

test('the id is a function of WHAT is asking, never of when', () => {
  const subject = { kind: 'errand', slug: 'console-frontend-redesign', phase: 4, runId: 'r-1', subject: 'verify-red' };
  const first = inboxItemId(subject);

  // Same facts, a fresh object literal a restart would rebuild from disk.
  const second = inboxItemId({
    kind: 'errand',
    slug: 'console-frontend-redesign',
    phase: 4,
    runId: 'r-1',
    subject: 'verify-red',
  });
  assert.equal(second, first, 'an id that does not survive a restart silently un-acks its item');

  // The clock is not part of the identity: two sweeps a day apart, one id.
  const withClocks = [
    { ...subject, since: '2026-08-20T09:00:00.000Z', title: 'first sweep' },
    { ...subject, since: '2026-08-21T22:31:07.512Z', title: 'a day later' },
  ].map(inboxItemId);
  assert.equal(withClocks[0], withClocks[1], 'a timestamp in the id is how an inbox grows a row per poll');

  assert.match(first, /^errand:console-frontend-redesign:4:r-1:verify-red$/, 'readable: the ack file is read by people');
});

test('absent, null, empty and blank are one slot; a non-positive phase is no phase', () => {
  const base = inboxItemId({ kind: 'health' });
  for (const variant of [
    { kind: 'health', slug: undefined },
    { kind: 'health', slug: '' },
    { kind: 'health', slug: '   ' },
    { kind: 'health', slug: null as never },
    { kind: 'health', runId: '' },
    { kind: 'health', subject: '' },
  ]) {
    assert.equal(inboxItemId(variant), base, JSON.stringify(variant));
  }

  // The ladder writes `phase: 0` on a run-level errand to mean "no phase". If
  // 0 and undefined minted different ids, one errand would be two rows
  // depending on which producer wrote it.
  const noPhase = inboxItemId({ kind: 'errand', slug: 'p', runId: 'r' });
  for (const phase of [0, -1, 1.5, NaN, null, undefined, '', 'four']) {
    assert.equal(
      inboxItemId({ kind: 'errand', slug: 'p', runId: 'r', phase: phase as never }),
      noPhase,
      `phase ${String(phase)} must mean no phase`,
    );
  }
  assert.notEqual(inboxItemId({ kind: 'errand', slug: 'p', runId: 'r', phase: 1 }), noPhase);
  // A numeric string from a query parameter is the same phase as the number.
  assert.equal(
    inboxItemId({ kind: 'errand', slug: 'p', runId: 'r', phase: '4' }),
    inboxItemId({ kind: 'errand', slug: 'p', runId: 'r', phase: 4 }),
  );
});

test('a missing kind mints a row, not an exception', () => {
  assert.equal(inboxItemId({} as never), 'unknown::::');
  assert.equal(inboxItemId(undefined as never), 'unknown::::');
});

/* ------------------------------------------------------------------ *
 * 2. Identity — no collisions
 * ------------------------------------------------------------------ */

test('two genuinely different asks never share an id', () => {
  const subjects = [
    // One field at a time.
    { kind: 'errand', slug: 'alpha', phase: 4, runId: 'r-1', subject: 'verify-red' },
    { kind: 'gate', slug: 'alpha', phase: 4, runId: 'r-1', subject: 'verify-red' },
    { kind: 'errand', slug: 'beta', phase: 4, runId: 'r-1', subject: 'verify-red' },
    { kind: 'errand', slug: 'alpha', phase: 5, runId: 'r-1', subject: 'verify-red' },
    { kind: 'errand', slug: 'alpha', phase: 4, runId: 'r-2', subject: 'verify-red' },
    { kind: 'errand', slug: 'alpha', phase: 4, runId: 'r-1', subject: 'resource-wall:auth' },
    // The same phase in two runs, and the run-level errand of each — the four
    // rows one halted plan produces.
    { kind: 'errand', slug: 'alpha', phase: 0, runId: 'r-1' },
    { kind: 'errand', slug: 'alpha', phase: 0, runId: 'r-2' },
    // Several subjects of one kind under one plan: two servers, two accounts,
    // two health issues, two approvals of one run.
    { kind: 'mcp-auth', subject: 'github' },
    { kind: 'mcp-auth', subject: 'linear' },
    { kind: 'sign-in', subject: 'default' },
    { kind: 'sign-in', subject: 'profile-2' },
    { kind: 'health', slug: 'alpha', subject: 'qa-fail' },
    { kind: 'health', slug: 'alpha', subject: 'stale-lock' },
    { kind: 'approval', slug: 'alpha', runId: 'r-1', subject: 'ap-1' },
    { kind: 'approval', slug: 'alpha', runId: 'r-1', subject: 'ap-2' },
    // The adversarial pairs a bare join would collide.
    { kind: 'lock', slug: 'a:b' },
    { kind: 'lock', slug: 'a', runId: 'b' },
    { kind: 'lock', slug: 'a', subject: 'b' },
    { kind: 'lock', slug: 'a%3Ab' },
    { kind: 'lock', slug: 'a%b' },
    { kind: 'lock', slug: 'a', phase: 1 },
    { kind: 'lock', slug: 'a', runId: '1' },
  ];

  const seen = new Map<string, unknown>();
  for (const subject of subjects) {
    const id = inboxItemId(subject as never);
    const clash = seen.get(id);
    assert.equal(
      clash,
      undefined,
      `id collision on "${id}": acknowledging one of these would silence the other\n  ${JSON.stringify(clash)}\n  ${JSON.stringify(subject)}`,
    );
    seen.set(id, subject);
  }
  assert.equal(seen.size, subjects.length);
});

/* ------------------------------------------------------------------ *
 * 3. Order
 * ------------------------------------------------------------------ */

const at = (iso: string) => `2026-08-${iso}`;

/** A minimal item: only what the comparator reads. */
function item(severity: string, since: string, kind = 'errand', id = `${kind}-${since}`) {
  return { id, kind, severity, since };
}

test('severity first: urgent, then needs-you, then fyi', () => {
  const sorted = sortInbox([
    item('fyi', at('20T10:00:00Z')),
    item('needs-you', at('20T10:00:00Z')),
    item('urgent', at('20T10:00:00Z')),
  ]);
  assert.deepEqual(sorted.map((i) => i.severity), ['urgent', 'needs-you', 'fyi']);
});

test('oldest first inside a severity — the ask most likely already scrolled past', () => {
  const sorted = sortInbox([
    item('needs-you', at('22T09:00:00Z')),
    item('needs-you', at('19T23:59:59Z')),
    item('needs-you', at('21T12:00:00Z')),
    item('urgent', at('22T23:00:00Z')),
  ]);
  assert.deepEqual(sorted.map((i) => i.since), [
    at('22T23:00:00Z'), // urgent outranks every needs-you whatever its clock
    at('19T23:59:59Z'),
    at('21T12:00:00Z'),
    at('22T09:00:00Z'),
  ]);
});

test('a tie on severity and clock breaks by kind, then by id — never by input order', () => {
  const one = [
    item('needs-you', at('20T10:00:00Z'), 'lock', 'lock-b'),
    item('needs-you', at('20T10:00:00Z'), 'errand', 'errand-a'),
    item('needs-you', at('20T10:00:00Z'), 'lock', 'lock-a'),
    item('needs-you', at('20T10:00:00Z'), 'approval', 'ap-z'),
  ];
  const expected = ['errand-a', 'ap-z', 'lock-a', 'lock-b']; // kind rank, then id
  assert.deepEqual(sortInbox(one).map((i) => i.id), expected);

  // Shuffled input, identical output: the order is a function of the items.
  const shuffled = [one[3], one[2], one[0], one[1]];
  assert.deepEqual(sortInbox(shuffled).map((i) => i.id), expected);
});

test('a word this console does not know sorts last in its column, never first', () => {
  const sorted = sortInbox([
    item('screaming', at('19T00:00:00Z')),
    item('fyi', at('21T00:00:00Z')),
    item('urgent', at('21T00:00:00Z')),
  ]);
  assert.deepEqual(sorted.map((i) => i.severity), ['urgent', 'fyi', 'screaming']);

  // Same for a kind: it ties last rather than jumping the queue.
  const kinds = sortInbox([
    item('fyi', at('20T00:00:00Z'), 'telepathy', 'z'),
    item('fyi', at('20T00:00:00Z'), 'ruling', 'a'),
  ]);
  assert.deepEqual(kinds.map((i) => i.kind), ['ruling', 'telepathy']);
});

test('an unparseable or missing clock sorts last in its severity, not first', () => {
  const sorted = sortInbox([
    { id: 'broken', kind: 'health', severity: 'needs-you', since: 'whenever' },
    { id: 'none', kind: 'health', severity: 'needs-you' },
    { id: 'real', kind: 'health', severity: 'needs-you', since: at('21T00:00:00Z') },
  ]);
  assert.deepEqual(
    sorted.map((i) => i.id),
    ['real', 'broken', 'none'],
    'a malformed row pinned to the top of the inbox is forever',
  );
});

test('sortInbox returns a new array and leaves the caller\'s list alone', () => {
  const input = [item('fyi', at('21T00:00:00Z')), item('urgent', at('20T00:00:00Z'))];
  const before = input.map((i) => i.id);
  const sorted = sortInbox(input);
  assert.notEqual(sorted, input);
  assert.deepEqual(input.map((i) => i.id), before, 'a cached fact set must not be sorted in place');
  assert.deepEqual(sorted.map((i) => i.severity), ['urgent', 'fyi']);
});

test('an empty or absent list is an empty list', () => {
  assert.deepEqual(sortInbox([]), []);
  assert.deepEqual(sortInbox(undefined as never), []);
});

/* ------------------------------------------------------------------ *
 * 4. The stall vocabulary Phase 5 fills
 * ------------------------------------------------------------------ */

test('every stall kind has a meaning, a clock and a severity', () => {
  assert.ok(Object.isFrozen(STALL_KINDS));
  assert.deepEqual(Object.keys(STALL_META).sort(), [...STALL_KINDS].sort());
  for (const kind of STALL_KINDS) {
    const meta = STALL_META[kind];
    assert.ok(meta.label.length >= 4, kind);
    assert.ok(meta.blurb.length >= 40, `${kind}: say WHY, not what`);
    assert.ok(Number.isFinite(meta.afterMs) && meta.afterMs > 0, `${kind}: afterMs`);
    assert.ok(INBOX_SEVERITIES.includes(meta.severity), `${kind}: ${meta.severity}`);
  }
});

test('the lock-wait stall arrives while it is still a queue', () => {
  // `LOCK_WAIT_CAP_MS` (server/runner/runner.ts) turns a two-hour wait into a
  // halt with a halt card of its own. A stall raised at or past the cap would
  // be a second row for the same event, one of them already stale.
  assert.ok(
    STALL_META['queued-behind-lock'].afterMs < 2 * 60 * 60_000,
    'raise the queued-behind-lock stall strictly before the runner caps the wait',
  );
});

test('stall is a declared kind of the inbox, and nothing produces one yet', () => {
  assert.ok(INBOX_KINDS.includes('stall'));
  assert.ok(INBOX_KINDS.includes('ruling'));
  // The ids a Phase-5 detector will mint, pinned now so the ack file it writes
  // is readable by the console that ships before it.
  assert.equal(
    inboxItemId({ kind: 'stall', slug: 'alpha', phase: 4, runId: 'r-1', subject: 'session-silent' }),
    'stall:alpha:4:r-1:session-silent',
  );
});
