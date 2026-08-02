/**
 * Phase Console — the server.
 *
 * Serves the single-page client from `web/` and the API from `server/api`.
 * Binds to localhost only; there is no build step and no dependency to
 * install, so a fresh clone of the skill runs it straight away.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';

import { parseFlags, VIEWER_DIR } from './config.ts';
import { Service } from './service.ts';
import { handleApi } from './api/routes.ts';

const flags = parseFlags(process.argv.slice(2));
const service = new Service(flags);
const WEB_DIR = join(VIEWER_DIR, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (await handleApi({ service }, req, res, url)) return;
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' });
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
  });
  createReadStream(path).pipe(res);
}

server.listen(flags.port, flags.host, () => {
  const address = `http://${flags.host}:${flags.port}`;
  process.stdout.write(`\n  Phase Console  ${address}\n`);
  process.stdout.write(`  source        ${service.root?.path ?? 'not chosen yet — pick one in the browser'}\n`);
  process.stdout.write(`  scripts       ${flags.scriptsDir}\n`);
  process.stdout.write(`  writes        ${flags.allowWrites ? 'enabled (--allow-writes)' : 'read-only'}\n\n`);
  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [address], () => { /* opening is a convenience */ });
  }
});

const shutdown = () => { service.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
