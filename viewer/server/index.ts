/**
 * Phase Console — the server.
 *
 * Serves the single-page client from `web/` and the API from `server/api`.
 * Binds to localhost only; there is no build step and no dependency to
 * install, so a fresh clone of the skill runs it straight away.
 *
 * It is also expected to stay up for hours while it supervises agent sessions,
 * so nothing here is allowed to end the process by accident: faults are
 * recorded as degraded state (`lifecycle.ts`), every exit writes down its
 * reason (`log.ts`), and shutdown waits for registered work to checkpoint.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';

import { flagsRefusal, parseFlags, VIEWER_DIR } from './config.ts';
import {
  configureLog, installExitLogging, isClientDisconnect, log, noteExit, previousRunEndedCleanly,
} from './log.ts';
import { markDegraded, runShutdownHandlers } from './lifecycle.ts';
import { Service } from './service.ts';
import { handleApi } from './api/routes.ts';
import { classify } from './api/access.ts';
import { HOOK_TIMEOUT_SECONDS } from './runner/approvals.ts';

const flags = parseFlags(process.argv.slice(2));

// Before anything opens a port: incoherent access flags are a refusal to start,
// never a warning. See `flagsRefusal` for why.
const refusal = flagsRefusal(flags);
if (refusal) {
  process.stderr.write(`\n  phase-console: ${refusal}\n\n`);
  process.exit(1);
}

// Logging comes up before anything else can fail, so the first fault is on record.
configureLog(flags.logFile);
const cleanLastTime = previousRunEndedCleanly();
installExitLogging();
log.info('start', {
  pid: process.pid,
  node: process.version,
  port: flags.port,
  allowWrites: flags.allowWrites,
  // false here means the last run was killed or died hard — the single most
  // useful fact when someone reports "it just stopped".
  ...(cleanLastTime === false ? { previousRunCrashed: true } : {}),
});
if (cleanLastTime === false) {
  log.warn('previous-run-crashed', {
    note: 'the last run wrote no exit record — SIGKILL, OOM or a hard stop',
  });
}

const service = new Service(flags);
const WEB_DIR = join(VIEWER_DIR, 'web');

/**
 * The console outliving its faults is the whole point: a watcher that throws,
 * a socket that resets under a write, a rejected promise in a background
 * refresh — none of those are worth taking the server down for, and a
 * supervisor that dies mid-run is worse than no supervisor. Record and carry on.
 */
process.on('uncaughtException', (error) => { markDegraded('uncaughtException', error); });
process.on('unhandledRejection', (reason) => { markDegraded('unhandledRejection', reason); });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // iOS ignores a manifest served as anything else, and ignoring it silently is
  // the whole difference between a home-screen app and a bookmark.
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const startRoot = flags.root ?? (process.env.PHASE_CONSOLE_ROOT || undefined);
if (startRoot) {
  const check = service.open(startRoot);
  if (!check.ok) process.stderr.write(`phase-console: ${startRoot} — ${check.reason}\n`);
}

const server = createServer(async (req, res) => {
  // A client that disappears mid-response surfaces as an 'error' on the
  // request or response stream; unhandled, that is an uncaught exception per
  // request. Handling is mandatory, logging the routine ones is not.
  const noteStreamError = (where: string) => (error: unknown) => {
    if (isClientDisconnect(error)) return;
    log.warn(where, { url: req.url, error });
  };
  res.on('error', noteStreamError('response.error'));
  req.on('error', noteStreamError('request.error'));

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Ahead of the API and the static files alike: a refused caller should not be
  // able to tell which routes exist, and `/events` is as worth guarding as any
  // of them. A no-op unless --remote is set.
  const verdict = classify(req, flags);
  if (!verdict.ok) {
    // A silent refusal on a phone is unfixable, so every one of these is on
    // record with the two facts that explain it.
    log.warn('access.refused', {
      reason: verdict.reason,
      host: req.headers.host,
      login: req.headers['tailscale-user-login'],
      url: req.url,
    });
    res.writeHead(verdict.status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`${verdict.message}\n`);
    return;
  }

  try {
    if (await handleApi({ service }, req, res, url)) return;
  } catch (error) {
    log.error('api.unhandled', { url: req.url, error });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String((error as Error)?.message ?? error));
    return;
  }

  // Static: everything under web/, with index.html as the SPA entry.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = resolve(join(WEB_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, '')));
  if (!target.startsWith(WEB_DIR) || !existsSync(target) || !statSync(target).isFile()) {
    if (!extname(requested)) { sendFile(res, join(WEB_DIR, 'index.html')); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  sendFile(res, target);
});

function sendFile(res: import('node:http').ServerResponse, path: string): void {
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  // Vendored runtime and fonts never change without a redeploy; app files are
  // served fresh so an edit is one reload away, never a stale-cache puzzle.
  const immutable = /\/(vendor|fonts)\//.test(path);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=86400' : 'no-store',
    // Nothing here is meant to be sniffed, framed, or to leak the URL it came
    // from. `frame-ancestors` only: a script-src policy would have to carry the
    // inline importmap in index.html, which is a bigger promise than this is a
    // problem.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "frame-ancestors 'none'",
  });
  const stream = createReadStream(path);
  // A file deleted between the stat above and this read, or a client that
  // navigates away mid-transfer, both arrive here rather than as a crash.
  stream.on('error', (error) => {
    if (!isClientDisconnect(error)) log.warn('static.error', { path, error });
    res.destroy();
  });
  stream.pipe(res);
}

/**
 * A parked approval holds its hook request open for the whole answer window,
 * and that window is now an hour.
 *
 * Node's defaults would kill it long before: `requestTimeout` is five minutes
 * and destroys the socket when it fires. A destroyed hook request is not a
 * denial — it is silence, and **this hook fails open**, so the tool call the
 * console was holding for a person would simply proceed unsupervised. That is
 * the exact failure the approval queue exists to prevent, arriving through the
 * back door.
 *
 * Bounded rather than disabled (`0`), so a stuck client still cannot hold a
 * socket forever: the window, plus a minute for the answer to be written.
 */
server.requestTimeout = (HOOK_TIMEOUT_SECONDS + 60) * 1000;
server.headersTimeout = 60_000;

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    noteExit('port-in-use', { port: flags.port });
    process.stderr.write(
      `\n  phase-console: port ${flags.port} is already in use.\n` +
      `  A console may already be running — open http://${flags.host}:${flags.port}\n` +
      `  or start this one elsewhere with --port <n>.\n\n`,
    );
    process.exit(1);
  }
  markDegraded('server', error);
});

server.listen(flags.port, flags.host, () => {
  const address = `http://${flags.host}:${flags.port}`;
  process.stdout.write(`\n  Phase Console  ${address}\n`);
  process.stdout.write(`  source        ${service.root?.path ?? 'not chosen yet — pick one in the browser'}\n`);
  process.stdout.write(`  scripts       ${flags.scriptsDir}\n`);
  process.stdout.write(`  writes        ${flags.allowWrites ? 'enabled (--allow-writes)' : 'read-only'}\n`);
  process.stdout.write(`  autopilot     ${flags.allowRun ? 'enabled (--allow-run) — this console can spawn agent sessions' : 'off'}\n`);
  if (flags.remoteHosts.length) {
    process.stdout.write(`  remote        ${flags.remoteHosts.join(', ')} — only ${flags.remoteUsers.join(', ')}\n`);
  }
  process.stdout.write(`  log           ${flags.logFile ?? 'stderr only'}\n\n`);
  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [address], () => { /* opening is a convenience */ });
  }
});

/* ------------------------------------------------------------------ *
 * Shutdown
 * ------------------------------------------------------------------ */

/**
 * Long enough for a runner to checkpoint and let a child settle. Idle shutdown
 * is still instant: with nothing registered there is nothing to await.
 */
const SHUTDOWN_BUDGET_MS = 120_000;

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  noteExit(reason);
  log.info('shutdown.begin', { reason });

  // Stop taking new work first, so nothing starts while handlers are draining.
  server.close();
  service.close();

  await runShutdownHandlers(SHUTDOWN_BUDGET_MS);

  log.info('shutdown.end', { reason });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Closing the terminal must not kill a run in progress. Under launchd the
// process is detached and never sees this; in the foreground it now survives,
// and Ctrl-C or `launchctl` remains the way to stop it deliberately.
process.on('SIGHUP', () => log.warn('sighup.ignored', { note: 'terminal closed; still running' }));

// A hard second interrupt is an explicit "I mean it" — skip the drain.
process.on('SIGQUIT', () => { noteExit('SIGQUIT'); process.exit(131); });
