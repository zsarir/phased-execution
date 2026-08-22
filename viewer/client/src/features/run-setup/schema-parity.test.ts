/**
 * The form's vocabulary and the server's, held equal.
 *
 * `shared/run-settings.js` is pinned to the route module's own source by
 * `test/run-settings-parity.test.ts` on the node side. This is the other end
 * of that chain: every field those doors accept must be something this form
 * can send, and every field this form would send must be something a door
 * reads. Between the two suites there is no gap for a control that does
 * nothing, or a capability no control reaches.
 *
 * The mapping under test is `WIRE` in `schema.ts` — deliberately an explicit
 * table rather than an inferred one, because the interesting entries are the
 * `null`s: `prompt` and `permissionMode` are real form values that are NOT run
 * settings, and stating that is the point.
 */

import { describe, expect, it } from 'vitest';
import {
  PHASE_OPTION_FIELDS,
  RUN_SETTINGS_FIELDS,
  RUN_START_FIELDS,
  START_ONLY_FIELDS,
} from '@shared/run-settings.js';
import { EMPTY, WIRE, CONTEXT_FIELDS, parsePhases, runSetupSchema } from './schema';
import { MODES, buildRunPayload, shows } from './modes';
import type { RunSetupField } from './schema';

/** Every wire name the form can produce, from the fields that have one. */
const EMITTED = new Set(Object.values(WIRE).filter((name): name is string => name !== null));

describe('the schema covers the server, and nothing more', () => {
  it('every field POST /start accepts is reachable from the form', () => {
    for (const field of RUN_START_FIELDS) {
      if ((CONTEXT_FIELDS as readonly string[]).includes(field)) continue;
      expect(EMITTED.has(field), `no RunSetup field maps onto "${field}"`).toBe(true);
    }
  });

  it('every field POST /settings accepts is reachable from the form', () => {
    for (const field of RUN_SETTINGS_FIELDS) {
      expect(EMITTED.has(field), `no RunSetup field maps onto "${field}"`).toBe(true);
    }
  });

  it('the form would send nothing a door does not read', () => {
    const accepted = new Set<string>([...RUN_START_FIELDS, ...RUN_SETTINGS_FIELDS, ...CONTEXT_FIELDS]);
    for (const name of EMITTED) {
      expect(accepted.has(name), `the form maps a field onto "${name}", which no door reads`).toBe(true);
    }
  });

  it('the value shape and the wire map name the same fields', () => {
    // A field added to `RunSetupValues` without a `WIRE` entry is a control
    // whose payload nobody decided on; the reverse is a mapping to nothing.
    expect(Object.keys(WIRE).sort()).toEqual(Object.keys(EMPTY).sort());
  });

  it('the zod schema validates exactly the value shape', () => {
    const parsed = runSetupSchema.safeParse(EMPTY);
    expect(parsed.success).toBe(true);
    expect(Object.keys(runSetupSchema.def.shape).sort()).toEqual(Object.keys(EMPTY).sort());
  });

  it('per-phase overrides cover what the route keeps', () => {
    // `phaseOptions` is one wire field carrying nine, so the parity that
    // matters for it is the inner set — pinned against the route's own filter
    // by the node suite, and against the UI here.
    expect([...PHASE_OPTION_FIELDS].sort()).toEqual([
      'effort',
      'mcpOff',
      'mcpPolicy',
      'mcpServers',
      'model',
      'permissionMode',
      'skills',
      'skillsOff',
      'tools',
    ]);
  });
});

describe('the start-only fields never reach a settings patch', () => {
  it('`live` mode shows none of them', () => {
    for (const field of START_ONLY_FIELDS) {
      const owning = (Object.keys(WIRE) as RunSetupField[]).find((key) => WIRE[key] === field);
      if (!owning) continue; // `resumeRunId` is context, not a field.
      expect(shows('live', owning), `\`live\` shows "${owning}", which /settings refuses`).toBe(false);
    }
  });

  it('and a `live` payload carries none of them either', () => {
    const payload = buildRunPayload(
      'live',
      { ...EMPTY, model: 'opus', qa: true, accountId: 'work' },
      { slug: 'demo', run: { id: 'r1', status: 'running' } as never },
    );
    for (const field of START_ONLY_FIELDS) expect(field in payload).toBe(false);
  });
});

describe('every mode is declared', () => {
  it('names only fields the value shape has', () => {
    for (const [mode, spec] of Object.entries(MODES)) {
      for (const field of spec.fields) {
        expect(field in EMPTY, `mode "${mode}" shows "${field}", which is not a value`).toBe(true);
      }
    }
  });
});

describe('the phase list', () => {
  it('reads ranges, singles and both together', () => {
    expect(parsePhases('1, 3, 5-7')).toEqual([1, 3, 5, 6, 7]);
    expect(parsePhases('  4  ')).toEqual([4]);
    expect(parsePhases('')).toBeUndefined();
  });

  it('reads a backwards range the way it was written', () => {
    // A typo with an obvious meaning. Dropping it would silently widen the run
    // to the whole plan, which is the opposite of what was asked.
    expect(parsePhases('7-5')).toEqual([5, 6, 7]);
  });

  it('does not silently invent a scope from nonsense', () => {
    expect(parsePhases('abc')).toBeUndefined();
  });
});
