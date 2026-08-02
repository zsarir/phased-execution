/**
 * Approvals: pausing an unattended run to ask a person.
 *
 * ## What actually holds, measured rather than assumed
 *
 * Claude Code's `http` PreToolUse hook **fails open**. Probed against a real
 * session with nothing listening on the hook URL: the tool call went straight
 * through, no error, no block. Probed with the broker answering `deny`: the
 * call was blocked and the session adapted. Both are true, and the first one
 * decides the architecture.
 *
 * So this module builds settings in two layers that must not be confused:
 *
 *   **`permissions.deny` — the wall.** Evaluated inside the CLI with no
 *   network involved, verified to hold with the broker unreachable. Everything
 *   that must never happen unattended lives here. Nothing can approve past it;
 *   a person runs those commands themselves, deliberately.
 *
 *   **`ask` + the HTTP hook — the workflow.** For work that *may* proceed with
 *   a human's say-so. The hook parks the session, shows evidence, and waits.
 *   It is a convenience with a nice phone interface, and if the console dies it
 *   silently stops existing — which is exactly why nothing dangerous may depend
 *   on it alone.
 *
 * A bare "Deploy? [y/n]" would automate the ceremony of approval and delete its
 * substance, so every card carries the evidence a person would have gone and
 * looked up: the command, the phase, the diff, the verification output.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { STATE_DIR } from '../config.ts';

/* ------------------------------------------------------------------ *
 * The two lists
 * ------------------------------------------------------------------ */

/**
 * Never, whatever anyone clicks. These reach a remote, spend money, destroy
 * data, or take the guard rails off — and an unattended agent has no business
 * doing any of them at 3am on the strength of a tap on a phone.
 *
 * Deliberately conservative and deliberately generic: this file ships in a
 * public skill, so repository-specific rules belong in the operator's own
 * `autopilot.json` rather than here.
 */
export const DEFAULT_DENY = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean:*)',
  'Bash(sudo:*)',
  'Bash(terraform apply:*)',
  'Bash(terraform destroy:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(docker push:*)',
  'Bash(kubectl delete:*)',
  'Bash(kubectl apply:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
  'Bash(mkfs:*)',
  'Bash(dd:*)',
  'Bash(curl:* | sh)',
  'Bash(curl:* | bash)',
];

/**
 * Allowed, but only with a person in the loop. These are the everyday
 * irreversible-ish steps of real work — a commit, a migration, a dependency
 * install — that a run should be able to reach, but not on its own.
 */
export const DEFAULT_ASK = [
  'Bash(git commit:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(npm install:*)',
  'Bash(pnpm add:*)',
  'Bash(alembic upgrade:*)',
  'Bash(psql:*)',
  'Bash(ssh:*)',
  'WebFetch',
];

export type AutopilotPolicy = { deny: string[]; ask: string[] };

const POLICY_FILE = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'phase-console', 'autopilot.json',
);

/**
 * The operator's own rules, merged on top of the defaults. A repository with
 * its own dangerous verbs — a deploy task, a box-mutating Taskfile target —
 * adds them here; the public skill never needs to know about them.
 *
 * Merged, never replaced: a policy file that forgot `git push` must not
 * quietly become a policy that permits it.
 */
export function loadPolicy(file = POLICY_FILE): AutopilotPolicy {
  let extra: Partial<AutopilotPolicy> = {};
  try { extra = JSON.parse(readFileSync(file, 'utf8')) as Partial<AutopilotPolicy>; }
  catch { /* no policy file is the normal case */ }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  return {
    deny: [...new Set([...DEFAULT_DENY, ...strings(extra.deny)])],
    ask: [...new Set([...DEFAULT_ASK, ...strings(extra.ask)])],
  };
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

/**
 * Only two, on purpose. The docs also describe `defer`, but this hook fails
 * open, and an unrecognised decision is indistinguishable from no answer at
 * all — the difference between "wait for me" and "go ahead unsupervised" would
 * come down to a spelling. `deny` is the behaviour actually measured against a
 * live session, so a timeout denies and says it timed out.
 */
export type Decision = 'allow' | 'deny';

export type Evidence = { label: string; body: string };

export type Approval = {
  id: string;
  runId: string;
  slug: string;
  phase: number | null;
  kind: 'gate' | 'tool';
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: { name: string; input: unknown; cwd?: string };
  createdAt: string;
  expiresAt: string;
  status: 'pending' | Decision | 'expired';
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
};

type Waiting = { approval: Approval; settle: (decision: Decision, by: string, reason?: string) => void; timer: NodeJS.Timeout };

/**
 * The hook's own timeout governs how long the session waits. Answer a little
 * before it, so the decision is ours and reads as a decision — not as the
 * silence that fails open.
 */
export const HOOK_TIMEOUT_SECONDS = 600;
const ANSWER_BY_MS = (HOOK_TIMEOUT_SECONDS - 20) * 1000;

export class Approvals {
  private waiting = new Map<string, Waiting>();
  private history: Approval[] = [];
  private token: Buffer | null = null;
  private runId: string | null = null;
  private counter = 0;
  private notify: (approval: Approval) => void;

  constructor(notify: (approval: Approval) => void = () => {}) {
    this.notify = notify;
  }

  /* ---- the per-run token ---- */

  /**
   * Mint a token for one run. The hook endpoint is unauthenticated otherwise —
   * anything on this machine could POST to it — so the token is what ties a
   * request to the run we started, and it dies with the run.
   */
  arm(runId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.token = Buffer.from(token);
    this.runId = runId;
    return token;
  }

  disarm(): void {
    this.token = null;
    this.runId = null;
    // Anything still waiting is answered rather than left hanging: a session
    // blocked on a dead broker would sit there until the hook timed out.
    for (const [id] of this.waiting) this.settle(id, 'deny', 'run ended', 'the run ended before this was decided');
  }

  /** Constant-time, so a wrong token leaks nothing about the right one. */
  verify(header: string | undefined): boolean {
    if (!this.token || !header) return false;
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    if (presented.length !== this.token.length) return false;
    return timingSafeEqual(presented, this.token);
  }

  armed(): boolean { return this.token !== null; }

  /* ---- the queue ---- */

  /**
   * Park until somebody decides, or until we are nearly out of the hook's
   * patience. Answering just before the hook's own timeout matters: our answer
   * is a decision, its timeout is silence, and silence lets the call through.
   */
  request(
    request: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
  ): { approval: Approval; decided: Promise<{ decision: Decision; by: string; reason?: string }> } {
    const id = `${Date.now().toString(36)}-${++this.counter}`;
    const approval: Approval = {
      ...request,
      id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ANSWER_BY_MS).toISOString(),
      status: 'pending',
    };

    const decided = new Promise<{ decision: Decision; by: string; reason?: string }>((resolve) => {
      const settle = (decision: Decision, by: string, reason?: string) => {
        const entry = this.waiting.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete(id);
        approval.status = decision;
        approval.decidedAt = new Date().toISOString();
        approval.decidedBy = by;
        approval.reason = reason;
        this.remember(approval);
        resolve({ decision, by, reason });
      };
      // Unreferenced: the listening socket is what keeps this process alive, and
      // a pending approval must never be the reason it cannot exit.
      const timer = setTimeout(
        () => settle('deny', 'timeout', `nobody answered within ${Math.round(ANSWER_BY_MS / 60000)} minutes`),
        ANSWER_BY_MS,
      ).unref();
      this.waiting.set(id, { approval, settle, timer });
    });

    log.info('approval.requested', { id, runId: approval.runId, phase: approval.phase, title: approval.title });
    try { this.notify(approval); } catch { /* a notifier must never block a decision */ }
    return { approval, decided };
  }

  settle(id: string, decision: Decision, by: string, reason?: string): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    log.info('approval.decided', { id, decision, by });
    entry.settle(decision, by, reason);
    return true;
  }

  pending(): Approval[] { return [...this.waiting.values()].map((w) => w.approval); }
  recent(limit = 50): Approval[] { return this.history.slice(-limit); }
  all(): Approval[] { return [...this.pending(), ...this.recent()]; }

  private remember(approval: Approval): void {
    this.history.push(approval);
    if (this.history.length > 200) this.history.shift();
  }
}

/* ------------------------------------------------------------------ *
 * The settings handed to each child
 * ------------------------------------------------------------------ */

export type SettingsOptions = {
  runId: string;
  token: string;
  /** Where this console is listening — the child posts its hook calls here. */
  origin: string;
  policy?: AutopilotPolicy;
};

export function buildSettings(opts: SettingsOptions): Record<string, unknown> {
  const policy = opts.policy ?? loadPolicy();
  return {
    permissions: {
      // The layer that holds with the console dead. Verified, not assumed.
      deny: policy.deny,
      ask: policy.ask,
    },
    hooks: {
      PreToolUse: [
        {
          // Only the tools that can reach outside this repo are worth a round
          // trip; matching everything would put a network hop in front of every
          // Read and turn a phase into a slideshow.
          matcher: 'Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch',
          hooks: [
            {
              type: 'http',
              url: `${opts.origin}/hooks/pre-tool-use`,
              headers: { Authorization: `Bearer ${opts.token}` },
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write the settings where only this user can read them.
 *
 * `--settings` takes a file or a JSON string, and a string would put the run
 * token in argv, which `ps` shows to every account on the machine. A 0600 file
 * in the state directory does not.
 */
export function writeSettingsFile(runId: string, settings: Record<string, unknown>): string {
  const dir = join(STATE_DIR, 'settings');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-${runId}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is only applied on create; an existing file keeps its
  // own, so set it explicitly rather than trusting the happy path.
  chmodSync(path, 0o600);
  return path;
}
