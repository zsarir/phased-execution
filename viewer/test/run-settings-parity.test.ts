/**
 * The accepted-fields list and the door that accepts them, held together.
 *
 * Phase 4 made both run doors 400 on a field they do not understand instead of
 * dropping it. That fixed the SERVER's half. The other half is the form: a
 * field the route accepts and no control can send is a capability nobody can
 * reach, and a field the form sends that the route never reads is a control
 * that silently does nothing. Neither shows up in a type check, because a
 * request body is `unknown` on the wire.
 *
 * So this suite reads `server/api/routes.ts` as TEXT — the two `case` blocks,
 * every `body.<field>` and `'<field>' in body` inside them — and holds that
 * set equal to `shared/run-settings.js`. The client's zod schema is built from
 * the same module (`features/run-setup/schema.ts`, pinned by
 * `schema-parity.test.ts` on the vitest side), so all three agree or this
 * fails.
 *
 * Reading source text is deliberate and not a shortcut. The alternative is
 * importing the route module and probing it with real requests, which pins
 * behaviour rather than vocabulary — and the failure mode here is a field
 * nobody wired, which a behaviour probe cannot see because nobody wrote the
 * probe either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AGENT_TICKET_FIELDS,
  PHASE_OPTION_FIELDS,
  RUN_SETTINGS_FIELDS,
  RUN_START_FIELDS,
  START_ONLY_FIELDS,
} from '../shared/run-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(join(HERE, '..', 'server', 'api', 'routes.ts'), 'utf8');

/**
 * The body of one `case '<verb>': {` block, to its matching closing brace.
 *
 * Brace counting rather than a regex to the next `case`, because the block
 * contains object literals, template strings and nested switches — and a
 * regex that stopped at the first `}` would silently read a third of the door
 * and call the rest of the fields missing.
 */
function braceBlock(source: string, opener: string, what: string): string {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `no \`${opener}\` in routes.ts — did ${what} move?`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after \`${opener}\``);
}

const caseBlock = (source: string, verb: string): string =>
  braceBlock(source, `case '${verb}': {`, `the \`${verb}\` door`);

/** Every field name the block reads off the request body, either spelling. */
function fieldsRead(block: string): Set<string> {
  const found = new Set<string>();
  for (const [, name] of block.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g)) found.add(name);
  for (const [, name] of block.matchAll(/'([A-Za-z_$][\w$]*)'\s+in\s+body/g)) found.add(name);
  return found;
}

/** Not settings: the audit attribution the route stamps on a patch. */
const NOT_A_SETTING = new Set(['by']);

test('shared/run-settings.js lists exactly what POST /start reads', () => {
  const read = fieldsRead(caseBlock(ROUTES, 'start'));
  const declared = new Set(RUN_START_FIELDS);
  for (const name of read) {
    if (NOT_A_SETTING.has(name)) continue;
    assert.ok(declared.has(name), `\`start\` reads body.${name}, which RUN_START_FIELDS does not list`);
  }
  for (const name of declared) {
    assert.ok(read.has(name), `RUN_START_FIELDS lists "${name}", which \`start\` never reads`);
  }
});

test('shared/run-settings.js lists exactly what POST /settings reads', () => {
  const read = fieldsRead(caseBlock(ROUTES, 'settings'));
  const declared = new Set(RUN_SETTINGS_FIELDS);
  for (const name of read) {
    if (NOT_A_SETTING.has(name)) continue;
    assert.ok(declared.has(name), `\`settings\` reads body.${name}, which RUN_SETTINGS_FIELDS does not list`);
  }
  for (const name of declared) {
    assert.ok(read.has(name), `RUN_SETTINGS_FIELDS lists "${name}", which \`settings\` never reads`);
  }
});

test('the start-only fields are the three a patch must never carry', () => {
  // Named rather than merely derived: this is the sentence the form's `live`
  // mode obeys, and a silent change to it would let a settings sheet try to
  // mint a run or flip a plan's QA gate.
  assert.deepEqual([...START_ONLY_FIELDS].sort(), ['accountId', 'qa', 'resumeRunId']);
});

test('PHASE_OPTION_FIELDS matches the route filter that keeps a phase honest', () => {
  // `phaseOptions()` in the route builds each phase's object key by key; the
  // set it builds is the set a per-phase row may offer.
  const filter = braceBlock(ROUTES, 'function phaseOptions(', 'the per-phase filter');
  for (const name of PHASE_OPTION_FIELDS) {
    assert.ok(
      filter.includes(`${name}:`) || filter.includes(`'${name}'`) || filter.includes(`.${name}`),
      `PHASE_OPTION_FIELDS lists "${name}", which the route's phaseOptions() never keeps`,
    );
  }
});

test('AGENT_TICKET_FIELDS covers what the ticket door reads', () => {
  // A looser pin than the run doors on purpose: the ticket route reads its
  // body through a typed helper rather than field by field, so this asserts
  // COVERAGE (nothing the two launches send is unlisted) rather than equality.
  const ticket = ROUTES.slice(ROUTES.indexOf("head === 'agent'"));
  const read = fieldsRead(ticket.slice(0, ticket.indexOf('\n    }\n')));
  const declared = new Set(AGENT_TICKET_FIELDS);
  for (const name of read) {
    assert.ok(declared.has(name), `the agent ticket reads body.${name}, unlisted in AGENT_TICKET_FIELDS`);
  }
});
