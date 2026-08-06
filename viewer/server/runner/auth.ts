/**
 * Is Claude Code signed in, and how does someone fix it if not?
 *
 * An expired login is the cheapest failure in this whole system to detect and
 * the most expensive to discover the hard way. The hard way looks like this,
 * and it is what a real run did:
 *
 *     phase 14 started on sonnet
 *     claude-sonnet-5 started · 28 tools available
 *     Failed to authenticate: OAuth session expired and could not be refreshed
 *     success · 1 turns · $0.000
 *
 * A session that spends a turn, reports `success`, changes nothing, and costs
 * nothing. Multiply by every phase in a plan and an overnight run burns itself
 * out against a login prompt nobody was there to answer.
 *
 * `claude auth status` answers the question in about a second, as JSON, without
 * spending a token — so the run asks before it starts rather than finding out
 * per phase. And because "go and log in" is a useless instruction to give a
 * browser, this also knows how to put a real terminal in front of the operator
 * with the right command already in it.
 */

import { spawn } from 'node:child_process';

import { log } from '../log.ts';

export type AuthStatus = {
  loggedIn: boolean;
  /** Who the CLI thinks you are — worth showing, since the wrong account looks like the right one. */
  email?: string;
  method?: string;
  organisation?: string;
  subscription?: string;
  checkedAt: string;
  /** Present when the probe itself could not answer, as opposed to answering "no". */
  detail?: string;
};

/** Long enough for a cold CLI start, short enough that the UI is not left hanging. */
const PROBE_TIMEOUT_MS = 20_000;
/** The answer barely changes; re-probing on every poll would spawn a process per second. */
const CACHE_MS = 10_000;

let cached: { at: number; status: AuthStatus } | null = null;

/** Drop the memo — after a login attempt the previous answer is worse than none. */
export function forgetAuth(): void {
  cached = null;
}

export async function checkAuth(cwd: string, force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const status = await probe(cwd);
  cached = { at: Date.now(), status };
  return status;
}

function probe(cwd: string): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const checkedAt = new Date().toISOString();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['auth', 'status'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ loggedIn: false, checkedAt, detail: `could not run \`claude auth status\`: ${(error as Error).message}` });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (status: AuthStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ loggedIn: false, checkedAt, detail: '`claude auth status` did not answer within 20s' });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { err += chunk; });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        loggedIn: false,
        checkedAt,
        detail: error.code === 'ENOENT'
          ? 'the `claude` CLI is not on PATH for this process'
          : `could not run \`claude auth status\`: ${error.message}`,
      });
    });

    child.on('close', () => finish(parseAuth(out, err, checkedAt)));
  });
}

/**
 * The CLI prints JSON today. Treating an unparseable answer as "signed out"
 * would block every run the moment that output format changes, so an answer we
 * cannot read is reported as unknown-but-usable with the reason attached — the
 * probe is a courtesy, and it must never become a second way to fail.
 */
export function parseAuth(stdout: string, stderr: string, checkedAt: string): AuthStatus {
  const text = stdout.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.loggedIn === 'boolean') {
      return {
        loggedIn: parsed.loggedIn,
        email: str(parsed.email),
        method: str(parsed.authMethod),
        organisation: str(parsed.orgName),
        subscription: str(parsed.subscriptionType),
        checkedAt,
      };
    }
  } catch { /* fall through to the text reading below */ }

  // No JSON to read. Only a clear negative counts as signed out.
  const all = `${text}\n${stderr}`.toLowerCase();
  if (/not logged in|logged out|no credentials|please (run )?.*login/.test(all)) {
    return { loggedIn: false, checkedAt, detail: text.slice(0, 200) || stderr.slice(0, 200) };
  }
  return {
    loggedIn: true,
    checkedAt,
    detail: `could not read \`claude auth status\` (${text.slice(0, 120) || 'no output'}) — assuming signed in`,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * Putting a terminal in front of the operator
 * ------------------------------------------------------------------ */

/**
 * `claude auth login` is an interactive OAuth flow: it needs a terminal, and a
 * web page cannot be one. What the console *can* do is open a real terminal
 * already sitting in the right directory with the right command typed — which
 * is the whole distance between "authentication failed" and being signed in.
 *
 * Nothing is typed on the operator's behalf beyond that command, and the flow
 * itself happens in their terminal and their browser, where it belongs.
 */
export function loginCommand(cwd: string): string {
  return `cd ${shellQuote(cwd)} && claude auth login`;
}

export function openLoginTerminal(cwd: string): { opened: boolean; command: string; detail?: string } {
  return openCommandTerminal(loginCommand(cwd));
}

/**
 * The same Terminal.app trick for any server-composed command — the accounts
 * flow signs a PROFILE in, which is this command with a `CLAUDE_CONFIG_DIR=`
 * assignment in front of it.
 */
export function openCommandTerminal(command: string): { opened: boolean; command: string; detail?: string } {
  if (process.platform !== 'darwin') {
    return {
      opened: false,
      command,
      detail: 'opening a terminal automatically is only wired up for macOS — run the command yourself.',
    };
  }
  try {
    const script = `tell application "Terminal" to do script ${appleScriptString(command)}`;
    const child = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    log.info('auth.login-terminal', { command: command.replace(/CLAUDE_CODE_OAUTH_TOKEN=\S+/, 'CLAUDE_CODE_OAUTH_TOKEN=…') });
    return { opened: true, command };
  } catch (error) {
    return { opened: false, command, detail: (error as Error).message };
  }
}

/** Single-quote for POSIX sh: everything is literal except a quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literals escape only backslash and double quote. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
