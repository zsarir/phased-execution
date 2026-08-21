/**
 * The `require` MCP park's clock, and the flip out of it.
 *
 * A phase whose MCP policy is `require` parks at boarding when a server it
 * names will not connect — correct for the phase that genuinely cannot run
 * without it, and a dead end for the run when nobody is watching: a signed-out
 * server held plans for hours that would have been better served by the
 * phase running without it and saying so. So the park has a clock now
 * (`mcpRequireTimeoutMs`, 30 minutes by default): past it, the phase continues
 * WITHOUT the servers, the session is told which and asked to record what it
 * could not do, the errand is written once, and the operator hears once.
 * `healMcpParks` still requeues the phase sooner when the server heals.
 *
 * Two callers, one flip: the runner (live run — flip the record, wake the
 * loop) and the service (stopped run — flip the stored record, restart). Both
 * go through `continueMcpParkedRecord`, which is pure over the state and
 * journals nothing; the caller journals in its own voice.
 */

import { errandFor } from './ladder.ts';
import { mcpReasonText, resetForRetry, type Errand, type PhaseRecord, type RunState } from './state.ts';

/** Thirty minutes: long enough for a heal in progress, short enough to matter. */
export const DEFAULT_MCP_REQUIRE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * When this record's `require` park times out, as epoch ms — or null when it
 * never will: not such a park, a park from before the clock existed (no
 * `mcpPark`), or a timeout of 0 (the operator's "wait indefinitely").
 */
export function mcpParkDueAt(record: PhaseRecord | undefined | null, timeoutMs: number): number | null {
  if (!record || record.status !== 'parked' || !record.mcpPark) return null;
  if (!(timeoutMs > 0)) return null;
  const at = Date.parse(record.mcpPark.at);
  return Number.isFinite(at) ? at + timeoutMs : null;
}

export type McpContinueResult = {
  /** The servers the phase goes ahead without. */
  servers: string[];
  /** How long the park lasted. */
  waitedMs: number;
  /** The one ask left on the phase: sign them in, or decide the phase does not need them. */
  errand: Errand;
};

/**
 * Flip a `require` park into continue-without-it.
 *
 * The phase's OWN policy becomes `continue` — the one level that outranks the
 * plan's `require`, because this is the operator's standing instruction (the
 * timeout preference) applied to one phase, not a run-wide blanket — the
 * record is reset to board fresh under normal admission with the ladder's
 * hint on it, both rungs of the `mcp-unavailable` ladder are written as
 * climbed (the wait that timed out, the continue that follows), and the
 * errand is recorded on the phase's recovery slot. The rungs are written
 * directly rather than through `accountRung`: that bumps the legacy
 * launch counter, and nothing here launched anything.
 *
 * Null when the record is not a `require` park (already retried, healed, or
 * never parked) — the callers' races all land here and all answer "nothing
 * to do".
 */
export function continueMcpParkedRecord(
  state: RunState, phase: number, opts: { by: string; now?: Date },
): McpContinueResult | null {
  const record = state.phases[String(phase)];
  if (!record || record.status !== 'parked' || !record.mcpPark) return null;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const park = record.mcpPark;
  const began = Date.parse(park.at);
  const waitedMs = Math.max(0, now.getTime() - (Number.isFinite(began) ? began : now.getTime()));
  const minutes = Math.round(waitedMs / 60_000);
  const servers = park.degraded.map((row) => row.id);
  const named = park.degraded.map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`).join(', ');

  const key = String(phase);
  (state.phaseOptions ??= {})[key] = { ...(state.phaseOptions?.[key] ?? {}), mcpPolicy: 'continue' };
  resetForRetry(record);
  record.boardingHint = { situation: 'mcp-unavailable', rung: 'mcp-continue', brief: 'fresh', at: nowIso, by: opts.by };

  const slot = ((state.recoveries ??= {})[key] ??= { attempts: 0, lastAt: nowIso });
  (slot.rungs ??= []).push(
    {
      situation: 'mcp-unavailable', rung: 'wait-heal', at: park.at, outcome: 'failed',
      note: `waited ${minutes} min for ${servers.join(', ')}`,
    },
    { situation: 'mcp-unavailable', rung: 'mcp-continue', at: nowIso, outcome: 'running', note: 'Continue without it' },
  );
  slot.lastAt = nowIso;
  const one = servers.length === 1;
  const errand: Errand = {
    ...errandFor('mcp-unavailable', slot.rungs, phase, nowIso),
    need: `MCP server${one ? '' : 's'} ${named} signed in and reachable — phase ${phase} went ahead without `
      + `${one ? 'it' : 'them'} after waiting ${minutes} min, and was told to record what it could not do.`,
  };
  slot.errand = errand;
  return { servers, waitedMs, errand };
}
