/**
 * The rulings ledger — the append-only record of what sessions DECIDED.
 *
 * Three properties carry the whole design and each has a test here: an ack is
 * an appended line rather than an edit (so a reader never races a live
 * session), a torn tail costs one line rather than the endpoint, and identity
 * is content-derived (so re-reading the file ingests nothing twice).
 *
 * The bash half — the exact line `phase-outcome.sh <slug> <N> ruling` writes,
 * supervised and unsupervised — is pinned in `tests/unit/outcome.bats`; this
 * file reads what that one writes.
 */

// Redirects XDG_STATE_HOME before anything resolves it.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PHASE_CONSOLE_LOG = '';

const {
  appendAck, ingestRulings, readRulings, rulingId, rulingsFile, MAX_RULINGS,
} = await import('../server/runner/rulings.ts');
const { RULING_KINDS } = await import('../shared/attention-model.js');

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));

function ledger(): string {
  return join(mkdtempSync(join(tmpdir(), 'pc-rulings-')), 'rulings.ndjson');
}

const line = (body: Record<string, unknown>): string => `${JSON.stringify({ version: 1, type: 'ruling', ...body })}\n`;

const RULING = {
  slug: 'demo', phase: 5, kind: 'deviation', what: 'kept the old field',
  why: 'a reader predating it still exists', cost_if_wrong: 'one dead branch',
  at: '2026-08-10T21:10:03Z',
};

/* ------------------------------------------------------------------ *
 * Reading what bash writes
 * ------------------------------------------------------------------ */

test('a line written by phase-outcome.sh reads back whole, with a content-derived id', () => {
  const file = ledger();
  // The real script, under the real target runtime — the two halves of this
  // feature meet at exactly one byte format and nothing else pins the join.
  execFileSync('/bin/bash', [
    join(SCRIPTS, 'phase-outcome.sh'), 'demo', '5', 'ruling',
    '--kind', 'deviation', '--what', 'kept the old field',
    '--why', 'a reader predating it still exists', '--cost-if-wrong', 'one dead branch',
  ], { env: { ...process.env, PE_RULINGS_FILE: file, PE_NOW: '2026-08-10T21:10:03Z', PE_SESSION_ID: 'sess-1' } });

  const [ruling, ...rest] = readRulings(file);
  assert.equal(rest.length, 0);
  assert.deepEqual(ruling, {
    id: rulingId('demo', 5, '2026-08-10T21:10:03Z', 'kept the old field'),
    slug: 'demo',
    phase: 5,
    kind: 'deviation',
    what: 'kept the old field',
    why: 'a reader predating it still exists',
    costIfWrong: 'one dead branch',
    sessionId: 'sess-1',
    at: '2026-08-10T21:10:03Z',
  });
});

test('a ledger that does not exist is an empty ledger, not an error', () => {
  assert.deepEqual(readRulings(join(tmpdir(), 'pc-rulings-nope', 'rulings.ndjson')), []);
});

test('every kind bash accepts is a kind this reads, and an unknown one degrades to the weakest', () => {
  const file = ledger();
  for (const kind of RULING_KINDS) {
    appendFileSync(file, line({ ...RULING, kind, what: `decided ${kind}`, at: `2026-08-10T21:1${RULING_KINDS.indexOf(kind)}:00Z` }));
  }
  appendFileSync(file, line({ ...RULING, kind: 'from-a-later-console', what: 'newer', at: '2026-08-10T21:20:00Z' }));
  const kinds = readRulings(file).map((r) => r.kind);
  assert.deepEqual(kinds, [...RULING_KINDS, 'ambiguity'],
    'a console one version behind must still show the row, under the weakest claim');
});

/* ------------------------------------------------------------------ *
 * The torn tail
 * ------------------------------------------------------------------ */

test('a torn last line costs that line and nothing else', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  appendFileSync(file, line({ ...RULING, what: 'second', at: '2026-08-10T21:11:00Z' }));
  // The console died between the write and the newline.
  appendFileSync(file, '{"version":1,"type":"ruling","slug":"demo","pha');

  const rulings = readRulings(file);
  assert.deepEqual(rulings.map((r) => r.what), ['first', 'second']);
});

test('a line missing what makes it a ruling is dropped, not half-read', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'good' }));
  appendFileSync(file, line({ ...RULING, what: '' }));                 // nothing decided
  appendFileSync(file, line({ ...RULING, what: 'x', phase: 0 }));      // no phase
  appendFileSync(file, line({ ...RULING, what: 'x', at: '' }));        // no clock
  appendFileSync(file, `${JSON.stringify({ version: 2, type: 'ruling', ...RULING })}\n`); // a version we do not speak
  assert.deepEqual(readRulings(file).map((r) => r.what), ['good']);
});

/* ------------------------------------------------------------------ *
 * Acks are appends
 * ------------------------------------------------------------------ */

test('an ack is a further line, and it folds onto the ruling it names', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  const [before] = readRulings(file);
  assert.equal(before.ack, undefined);

  const before_bytes = readFileSync(file, 'utf8');
  assert.equal(appendAck(file, before.id, 'mo', '2026-08-11T09:00:00Z'), true);
  // Appended, never rewritten: a reader that edited this file would be racing
  // every live session that is still writing to it.
  assert.ok(readFileSync(file, 'utf8').startsWith(before_bytes), 'the earlier bytes are untouched');

  const [after] = readRulings(file);
  assert.deepEqual(after.ack, { at: '2026-08-11T09:00:00Z', by: 'mo' });
});

test('acking twice is not an error, and the newer stamp is the one that shows', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  const [ruling] = readRulings(file);
  appendAck(file, ruling.id, 'mo', '2026-08-11T09:00:00Z');
  appendAck(file, ruling.id, 'sam', '2026-08-12T09:00:00Z');
  assert.deepEqual(readRulings(file)[0].ack, { at: '2026-08-12T09:00:00Z', by: 'sam' });
});

test('an ack naming nothing in the ledger is ignored rather than invented', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  appendAck(file, 'not-an-id', 'mo');
  const rulings = readRulings(file);
  assert.equal(rulings.length, 1);
  assert.equal(rulings[0].ack, undefined);
});

test('a ledger that cannot be written refuses quietly rather than throwing', () => {
  assert.equal(appendAck('/dev/null/nowhere/rulings.ndjson', 'abc', 'mo'), false);
  assert.equal(appendAck(ledger(), '', 'mo'), false, 'an empty id names nothing');
});

/* ------------------------------------------------------------------ *
 * Ingesting once
 * ------------------------------------------------------------------ */

test('re-reading the same file ingests nothing twice', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  appendFileSync(file, line({ ...RULING, what: 'second', at: '2026-08-10T21:11:00Z' }));

  const first = ingestRulings(undefined, readRulings(file));
  assert.equal(first.added.length, 2);
  assert.equal(first.rulings.length, 2);

  // The watcher fires again — a touch, a debounce that landed twice, a boot.
  const again = ingestRulings(first.rulings, readRulings(file));
  assert.equal(again.added.length, 0, 'identity is the ruling id, so this is idempotent');
  assert.equal(again.rulings.length, 2);

  // ...and a genuinely new line comes back as exactly that one.
  appendFileSync(file, line({ ...RULING, what: 'third', at: '2026-08-10T21:12:00Z' }));
  const third = ingestRulings(again.rulings, readRulings(file));
  assert.deepEqual(third.added.map((r) => r.what), ['third']);
});

test('an ack appended after ingestion does not re-ingest the ruling', () => {
  const file = ledger();
  appendFileSync(file, line({ ...RULING, what: 'first' }));
  const first = ingestRulings(undefined, readRulings(file));
  appendAck(file, first.rulings[0].id, 'mo');
  assert.equal(ingestRulings(first.rulings, readRulings(file)).added.length, 0);
});

test('both halves are bounded, so one long-lived plan cannot become one huge payload', () => {
  const file = ledger();
  for (let i = 0; i < MAX_RULINGS + 40; i++) {
    appendFileSync(file, line({ ...RULING, what: `decision ${i}`, at: `2026-08-10T21:10:${String(i % 60).padStart(2, '0')}Z` }));
  }
  const read = readRulings(file);
  assert.equal(read.length, MAX_RULINGS);
  // The NEWEST are kept: an old ruling that still matters has been read by now.
  assert.equal(read.at(-1)!.what, `decision ${MAX_RULINGS + 39}`);

  const merged = ingestRulings(read, [{ ...read[0], id: 'brand-new', what: 'one more' }]);
  assert.equal(merged.rulings.length, MAX_RULINGS);
  assert.equal(merged.rulings.at(-1)!.what, 'one more');
});

/* ------------------------------------------------------------------ *
 * Where it lives
 * ------------------------------------------------------------------ */

test('the ledger sits beside the outcomes inbox, per PLAN and not per run', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-rulings-root-'));
  const file = rulingsFile(root, 'demo');
  assert.match(file, /\/runs\/[0-9a-f]{8}-[^/]+\/demo\/rulings\.ndjson$/);
  // Two runs of one plan share it; two plans never do.
  assert.notEqual(rulingsFile(root, 'demo'), rulingsFile(root, 'other'));
});

test('a long decision is capped rather than allowed to become the payload', () => {
  const file = ledger();
  writeFileSync(file, line({ ...RULING, what: 'x'.repeat(5_000), why: 'y'.repeat(5_000), cost_if_wrong: 'z'.repeat(5_000) }));
  const [ruling] = readRulings(file);
  assert.equal(ruling.what.length, 500);
  assert.equal(ruling.why!.length, 800);
  assert.equal(ruling.costIfWrong!.length, 300);
});
