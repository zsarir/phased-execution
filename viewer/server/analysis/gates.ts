/**
 * The gate-check vocabulary + category split, read from the skill's own
 * `scripts/gates.env` (F5 single-source pattern, like sizing.env) so the
 * console and the bash engine can never disagree about which Gate-check types
 * exist or which category — human / ai / auto — a gate falls into. Status
 * still comes from the engine (`--gate-status`); this module only names the
 * category, which is a property of the plan text, not of the world. Parity
 * with `--gate-kind` is pinned per phase by test/engine-parity.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GateKind = 'human' | 'ai' | 'auto' | 'none';

export type GateVocab = { types: string[]; human: string[]; ai: string[] };

const FALLBACK: GateVocab = {
  types: ['phase', 'phases', 'plan', 'cmd', 'date', 'deadline', 'by', 'manual', 'ai'],
  human: ['manual'],
  ai: ['ai'],
};

function tokens(value: string | undefined): string[] | undefined {
  const list = (value ?? '').trim().split(/\s+/).filter(Boolean);
  return list.length ? list : undefined;
}

/** Read the canonical vocabulary from `scripts/gates.env`. */
export function loadGateVocab(scriptsDir: string): GateVocab {
  try {
    const text = readFileSync(join(scriptsDir, 'gates.env'), 'utf8');
    const values: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)="([^"]*)"/.exec(line.trim());
      if (m) values[m[1]] = m[2];
    }
    return {
      types: tokens(values.GATE_TYPES) ?? FALLBACK.types,
      human: tokens(values.GATE_TYPES_HUMAN) ?? FALLBACK.human,
      ai: tokens(values.GATE_TYPES_AI) ?? FALLBACK.ai,
    };
  } catch {
    return { ...FALLBACK };
  }
}

/**
 * Mirrors the engine's `gate_kind`: human for `manual`, for a *(GATED)* phase
 * with no Gate-check line at all, and for unknown types (fail-safe); ai for
 * the `ai` type; auto for the self-evaluating rest; none when not gated.
 * Deliberately case-sensitive on the type token, exactly like the engine —
 * `Date 2026-01-01` is an unknown type there, so it must be one here too.
 */
export function gateKindOf(gateCheck: string | undefined, gated: boolean, vocab: GateVocab): GateKind {
  if (!gated) return 'none';
  const type = (gateCheck ?? '').trim().split(/\s+/)[0] ?? '';
  if (!type) return 'human';
  if (vocab.human.includes(type)) return 'human';
  if (vocab.ai.includes(type)) return 'ai';
  return vocab.types.includes(type) ? 'auto' : 'human';
}
