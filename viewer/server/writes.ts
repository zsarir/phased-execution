/**
 * The guarded write verbs.
 *
 * Writing is off unless the server was started with `--allow-writes`, every
 * argument is validated against a strict shape before it reaches a script, and
 * `--git` is never passed — so the console can scaffold and record, but can
 * never commit, push, or touch a remote. Arguments are passed as an argv array
 * (never a shell string), so nothing here can be turned into shell injection.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { openerCandidates } from './platform.ts';

export type WriteAction = 'new-plan' | 'new-handoff' | 'qa-record' | 'lock-claim' | 'lock-release' | 'open-editor';

export type WriteRequest = {
  action: WriteAction;
  slug?: string;
  phase?: number;
  title?: string;
  status?: string;
  result?: string;
  report?: string;
  owner?: string;
  qa?: boolean;
  force?: boolean;
  path?: string;
};

export type WriteOutcome = {
  ok: boolean;
  /** Exactly what ran, for the confirmation dialog and the result panel. */
  command: string;
  code: number;
  stdout: string;
  stderr: string;
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TITLE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const HANDOFF_STATUS = ['complete', 'in-progress', 'blocked', 'pending'];
const QA_RESULT = ['pass', 'fail', 'waived', 'pending'];
const OWNER = /^[\w.@+-]{1,64}\/[\w.@+-]{1,64}$/;

export class WriteError extends Error {}

function requireSlug(slug?: string): string {
  if (!slug || !SLUG.test(slug)) throw new WriteError('Slug must be kebab-case: lowercase letters, digits and dashes.');
  return slug;
}

function requirePhase(phase?: number): number {
  if (!Number.isInteger(phase) || (phase as number) < 1 || (phase as number) > 999) {
    throw new WriteError('Phase must be a whole number between 1 and 999.');
  }
  return phase as number;
}

export type WritePlan = { script: string; args: string[]; description: string };

/** Translate a request into the exact script invocation, or refuse it. */
export function planWrite(request: WriteRequest, opts: { root: string; docsDir?: string }): WritePlan {
  switch (request.action) {
    case 'new-plan': {
      const slug = requireSlug(request.slug);
      if (opts.docsDir && existsSync(join(opts.docsDir, 'plans', `${slug}.md`))) {
        throw new WriteError(`docs/plans/${slug}.md already exists.`);
      }
      return { script: 'new-plan.sh', args: [slug], description: `Scaffold docs/plans/${slug}.md` };
    }

    case 'new-handoff': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const title = (request.title ?? '').trim();
      if (!TITLE.test(title)) throw new WriteError('Title must be kebab-case, e.g. cart-api-endpoint.');
      const status = request.status ?? 'complete';
      if (!HANDOFF_STATUS.includes(status)) throw new WriteError(`Status must be one of ${HANDOFF_STATUS.join(', ')}.`);
      const args = [slug, String(phase), title, status];
      if (request.qa) args.push('--qa');
      if (request.force) args.push('--force');
      return {
        script: 'new-handoff.sh',
        args,
        description: `Scaffold the phase ${phase} handoff for ${slug} (${status})`,
      };
    }

    case 'qa-record': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const result = request.result ?? '';
      if (!QA_RESULT.includes(result)) throw new WriteError(`QA result must be one of ${QA_RESULT.join(', ')}.`);
      const report = (request.report ?? '').trim();
      if (!report || isAbsolute(report) || normalize(report).startsWith('..')) {
        throw new WriteError('Report must be a relative path inside the handoff folder.');
      }
      return {
        script: 'qa-record.sh',
        args: [slug, String(phase), result, '--report', report],
        description: `Record QA ${result} for ${slug} phase ${phase}`,
      };
    }

    case 'lock-claim':
    case 'lock-release': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const owner = (request.owner ?? '').trim();
      if (!OWNER.test(owner)) throw new WriteError('Owner must look like "account/session".');
      const verb = request.action === 'lock-claim' ? 'claim' : 'release';
      const args = [slug, verb, String(phase), '--owner', owner];
      if (request.force && verb === 'claim') args.push('--force');
      return {
        script: 'phase-lock.sh',
        args,
        description: `${verb === 'claim' ? 'Claim' : 'Release'} the phase ${phase} lock on ${slug} as ${owner}`,
      };
    }

    case 'open-editor':
      throw new WriteError('Editor launches do not go through planWrite.');

    default:
      throw new WriteError('Unknown action.');
  }
}

export async function runWrite(
  plan: WritePlan,
  opts: { scriptsDir: string; root: string },
): Promise<WriteOutcome> {
  if (plan.args.includes('--git')) throw new WriteError('refusing to run a script with --git');

  const command = `${plan.script} ${plan.args.join(' ')}`;
  return new Promise((resolveOutcome) => {
    execFile(
      'bash',
      [join(opts.scriptsDir, plan.script), ...plan.args],
      {
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.root,
        env: { ...process.env, DOCS_ROOT: opts.root, NO_COLOR: '1', TERM: 'dumb' },
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0;
        resolveOutcome({ ok: code === 0, command, code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Hand a file to the user's editor. It writes nothing itself, but it does
 * spawn a process, so it stays inside the docs tree and behind the same flag.
 */
export async function openInEditor(path: string, docsDir: string): Promise<WriteOutcome> {
  const target = resolve(path);
  if (!target.startsWith(resolve(docsDir))) throw new WriteError('Refusing to open a file outside the docs directory.');
  if (!existsSync(target)) throw new WriteError('No such file.');

  const editor = process.env.VISUAL || process.env.EDITOR;
  const [command, args] = editor
    ? [editor.split(/\s+/)[0], [...editor.split(/\s+/).slice(1), target]]
    // `open` on macOS, `wslview` on WSL (the file's viewer is on the Windows
    // side), `xdg-open` on a Linux desktop. A miss is an honest ok:false.
    : [openerCandidates()[0] ?? 'xdg-open', [target]];

  return new Promise((resolveOutcome) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      resolveOutcome({
        ok: !error,
        command: `${command} ${args.join(' ')}`,
        code: error ? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}
