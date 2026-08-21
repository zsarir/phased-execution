/**
 * The `require` MCP park's clock and the flip out of it — pure over the state.
 *
 * What matters: the due time is the park's own start plus the timeout (never
 * "now", so a console that slept through it fires at once on boot); a park
 * written before the clock existed, or a timeout of 0, never times out; and
 * the flip touches exactly what the boarding reads — the phase's own policy,
 * the reset record with its hint, the two rungs, the errand — and nothing the
 * second time.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { mcpParkDueAt, continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS } = await import('../server/runner/mcp-park.ts');
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;

const AT = '2026-08-21T10:00:00.000Z';
const degraded = [{ id: 'gh', reason: 'needs-auth' as const }, { id: 'fs', reason: 'failed' as const, detail: 'MCP_FS_ROOT is not set' }];

function parked(over: Partial<PhaseRecord> = {}): PhaseRecord {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  const record = phaseRecord(state, 1);
  Object.assign(record, {
    status: 'parked', note: 'phase 1 cannot start: MCP servers gh (needs authentication), fs (MCP_FS_ROOT is not set).',
    mcpPark: { at: AT, degraded },
  }, over);
  return record;
}

test('mcpParkDueAt is the park\'s start plus the timeout — null for no park, a pre-clock park, or timeout 0', () => {
  assert.equal(mcpParkDueAt(parked(), 60_000), Date.parse(AT) + 60_000);
  assert.equal(mcpParkDueAt(parked(), DEFAULT_MCP_REQUIRE_TIMEOUT_MS), Date.parse(AT) + 30 * 60_000);
  assert.equal(mcpParkDueAt(parked(), 0), null, 'zero is "wait indefinitely"');
  assert.equal(mcpParkDueAt(parked({ mcpPark: undefined }), 60_000), null, 'a park from before the clock never times out');
  assert.equal(mcpParkDueAt(parked({ status: 'pending' }), 60_000), null, 'not parked any more');
  assert.equal(mcpParkDueAt(undefined, 60_000), null);
  assert.equal(DEFAULT_MCP_REQUIRE_TIMEOUT_MS, 30 * 60 * 1000);
});

test('continueMcpParkedRecord flips exactly a require park — policy, reset, hint, rungs, errand — and answers null the second time', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  const record = phaseRecord(state, 1);
  Object.assign(record, { status: 'parked', note: 'phase 1 cannot start: MCP servers …', mcpPark: { at: AT, degraded } });
  const now = new Date(Date.parse(AT) + 31 * 60_000);

  const result = continueMcpParkedRecord(state, 1, { by: 'timeout', now });
  assert.ok(result);
  assert.deepEqual(result.servers, ['gh', 'fs']);
  assert.equal(result.waitedMs, 31 * 60_000);
  // The phase's OWN policy — the one level that outranks a plan's `require`.
  assert.equal(state.phaseOptions?.['1']?.mcpPolicy, 'continue');
  // Reset to board fresh, with the ladder's hint and nothing of the park left.
  assert.equal(record.status, 'pending');
  assert.equal(record.note, undefined);
  assert.equal(record.mcpPark, undefined);
  assert.deepEqual(record.boardingHint && { situation: record.boardingHint.situation, rung: record.boardingHint.rung, brief: record.boardingHint.brief, by: record.boardingHint.by },
    { situation: 'mcp-unavailable', rung: 'mcp-continue', brief: 'fresh', by: 'timeout' });
  // Both rungs written as climbed — directly, not through the launch counter.
  const slot = state.recoveries?.['1'];
  assert.ok(slot);
  assert.deepEqual(slot.rungs?.map((r) => `${r.rung}:${r.outcome}`), ['wait-heal:failed', 'mcp-continue:running']);
  assert.equal(slot.attempts, 0, 'nothing was launched, so the legacy launch counter does not move');
  // The one ask, naming the servers and what already happened.
  assert.equal(slot.errand?.situation, 'mcp-unavailable');
  assert.equal(result.errand, slot.errand);
  assert.match(slot.errand?.need ?? '', /gh \(needs authentication\), fs \(MCP_FS_ROOT is not set\)/);
  assert.match(slot.errand?.need ?? '', /went ahead without them after waiting 31 min/);
  assert.match(slot.errand?.how ?? '', /Settings ▸ MCP/);
  assert.deepEqual(slot.errand?.tried.length, 2);

  assert.equal(continueMcpParkedRecord(state, 1, { by: 'timeout', now }), null, 'flipped once; the second fire finds nothing');
  assert.equal(continueMcpParkedRecord(state, 2, { by: 'timeout', now }), null, 'a phase that never parked');
});

test('a parked record without the clock (written by an older console) is not flipped', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  const record = phaseRecord(state, 1);
  Object.assign(record, { status: 'parked', note: 'phase 1 cannot start: MCP server gh (needs authentication).' });
  assert.equal(continueMcpParkedRecord(state, 1, { by: 'timeout' }), null);
  assert.equal(record.status, 'parked', 'left exactly as it was — a heal or a person still ends it');
});
