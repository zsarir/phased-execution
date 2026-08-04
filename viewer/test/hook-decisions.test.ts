/**
 * What the PreToolUse hook is told, and in whose voice.
 *
 * Three reports came out of one line of this path. A bypass run — the profile
 * whose whole promise is "stop asking me" — raised a card for a wrapped
 * command, waited out the hook's full hour with nobody watching, and timed out
 * into a deny; the CLI renders a deny with its own canned "The user doesn't
 * want to proceed with this tool use", so standing configuration reached the
 * session as a person refusing its work. It apologised and went looking for a
 * way around a rule that was never a person's opinion.
 *
 * So: the profile reaches the classifier, a denial says whose decision it is,
 * and a veto is written down where it can be read afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Both are read when the modules below load, so the redirect has to come first:
// a policy read out of the operator's real config would make this suite depend
// on rules that are none of its business.
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/**
 * A service whose live run is whatever this test says it is.
 *
 * `decideToolUse` reads four things off the run — its id, its slug, the phase
 * it is on and its profile — so standing one up beats driving a real session to
 * reach one branch of a classifier.
 */
function serviceOn(profile: string): { service: InstanceType<typeof Service>; noted: Noted[] } {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runner: unknown }).runner = {
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile }),
    note: (event: string, data: Record<string, unknown>, phase?: number) =>
      noted.push({ event, data, phase }),
    park: () => {},
  };
  return { service, noted };
}

function decision(reply: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

const WRAPPED = { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock ./job.sh' } };

test('a bypass run is not asked about a wrapper it said it did not want to be asked about', async () => {
  const { service } = serviceOn('bypass');
  // No `await` race to arrange: an 'ask' verdict would block on a decision
  // nobody is going to make, so if this resolves at all it did not raise a card.
  const answer = decision(await service.decideToolUse(WRAPPED, 'r1'));
  assert.equal(answer.permissionDecision, 'allow');
  assert.match(answer.permissionDecisionReason, /bypass profile/);
  service.close();
});

test('a guarded run still gets a person for the same command', async () => {
  const { service } = serviceOn('guarded');
  // An 'ask' verdict parks until somebody answers, so "it asked" is expressible
  // only as "it had not answered by itself" — hence the race rather than an
  // await that would sit here for the hook's full hour.
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(WRAPPED, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'guarded raised a card instead of deciding for itself');
  assert.equal(service.approvals.pending().length, 1, 'and the card is a real one, in the queue');

  // Settle it, or the request holds a timer and this suite never exits.
  service.approvals.disarm();
  service.close();
});

test('a denial says whose decision it is, names the rule, and is written down', async () => {
  const { service, noted } = serviceOn('bypass');
  const answer = decision(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, 'r1',
  ));

  assert.equal(answer.permissionDecision, 'deny', 'the wall is identical in every profile');
  // The wording is the fix. A session that reads "the user doesn't want to
  // proceed" has been told a person judged its work; one that reads this knows
  // it is policy, that a retry cannot change it, and what to do instead.
  assert.match(answer.permissionDecisionReason, /standing policy/i);
  assert.match(answer.permissionDecisionReason, /not a person rejecting your work/i);
  assert.match(answer.permissionDecisionReason, /do not retry/i);
  assert.match(answer.permissionDecisionReason, /rule:/, 'and it names the line that stopped it');

  // A veto used to happen inside a hook reply and leave no trace at all, so a
  // phase that quietly worked around a blocked command was unexplainable later.
  const denied = noted.find((n) => n.event === 'phase.tool-denied');
  assert.ok(denied, 'the veto reaches the journal');
  assert.equal(denied!.data.tool, 'Bash');
  assert.match(String(denied!.data.rule), /push/);
  assert.equal(denied!.phase, 2, 'attributed to the phase it happened in');
  service.close();
});

test('a wrapper cannot smuggle a denied command past a profile that stopped asking', async () => {
  // The hole the profile change would otherwise have opened. `stripWrappers`
  // refuses to peel `flock` — its arguments vary too much to guess — so the
  // deny rules, which match the START of a command, never saw the `git push`
  // one word in. Under guarded that was survivable (a person got the card);
  // under bypass it would have run.
  const { service } = serviceOn('bypass');
  const answer = decision(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock git push origin main' } }, 'r1',
  ));
  assert.equal(answer.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, /rule:/);
  service.close();
});

process.on('exit', () => {
  rmSync(CONFIG_HOME, { recursive: true, force: true });
  rmSync(STATE_HOME, { recursive: true, force: true });
});
