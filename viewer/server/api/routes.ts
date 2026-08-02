/**
 * The API surface.
 *
 * Reads are plain GETs. Writes are POSTs that require the `--allow-writes`
 * flag, a same-origin request and an `x-phase-console` header — a browser will
 * not send that header cross-origin without a CORS preflight, and no CORS
 * headers are ever sent, so another site cannot drive this server.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Service } from '../service.ts';
import { checkRoot, listDirs } from '../config.ts';
import { isClientDisconnect, log } from '../log.ts';
import { planWrite, runWrite, openInEditor, WriteError, type WriteRequest } from '../writes.ts';

export type ApiContext = { service: Service };

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** A write must come from this app, in this browser, with writes enabled. */
function guardWrite(req: IncomingMessage, service: Service): string | null {
  if (!service.flags.allowWrites) {
    return 'Writes are disabled. Restart with --allow-writes to enable them.';
  }
  if (req.headers['x-phase-console'] !== '1') return 'Missing console header.';
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host ?? '';
    try {
      if (new URL(origin).host !== host) return 'Cross-origin write refused.';
    } catch { return 'Bad origin.'; }
  }
  return null;
}

export async function handleApi(
  ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const { service } = ctx;
  const path = url.pathname;
  if (!path.startsWith('/api/') && path !== '/events') return false;

  /* ---------------- live updates ---------------- */
  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      off();
    };

    /**
     * A browser that navigated away, slept, or crashed leaves a socket that
     * fails under the next write. Unhandled, that is an uncaught exception per
     * dead client — so a write failure just retires this listener.
     */
    const send = (chunk: string): void => {
      if (closed || res.writableEnded || res.destroyed) { stop(); return; }
      try {
        res.write(chunk);
      } catch (error) {
        if (!isClientDisconnect(error)) log.warn('sse.write', { error });
        stop();
      }
    };

    // Replay anything the client missed while reconnecting. Browsers resend the
    // last id automatically, so a dropped connection costs no events — which
    // matters once a run is streaming phase progress through here.
    const lastSeen = Number(req.headers['last-event-id']);
    const missed = Number.isFinite(lastSeen) ? service.eventsSince(lastSeen) : [];

    send(`event: hello\ndata: ${JSON.stringify({
      generation: service.generation,
      cursor: service.eventCursor,
      replayed: missed.length,
    })}\n\n`);
    for (const item of missed) {
      send(`id: ${item.id}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }

    const off = service.onEvent((event, data, id) => {
      send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const ping = setInterval(() => send(': ping\n\n'), 25_000);

    res.on('error', (error) => {
      if (!isClientDisconnect(error)) log.warn('sse.socket', { error });
      stop();
    });
    res.on('close', stop);
    req.on('close', stop);
    req.on('error', stop);
    return true;
  }

  const segments = path.replace(/^\/api\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, ...rest] = segments;

  try {
    /* ---------------- session + source directory ---------------- */
    if (head === 'state' && req.method === 'GET') { json(res, 200, service.state()); return true; }

    if (head === 'fs' && req.method === 'GET') {
      json(res, 200, listDirs(url.searchParams.get('path') ?? ''));
      return true;
    }

    if (head === 'root') {
      if (req.method === 'GET') {
        json(res, 200, checkRoot(url.searchParams.get('path') ?? ''));
        return true;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const check = service.open(String(body.path ?? ''));
        json(res, check.ok ? 200 : 400, { check, state: service.state() });
        return true;
      }
    }

    if (head === 'prefs' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, service.savePreferences(body));
      return true;
    }

    if (!service.store) { json(res, 409, { error: 'No source directory is open.' }); return true; }

    /* ---------------- portfolio ---------------- */
    if (head === 'plans' && rest.length === 0) { json(res, 200, await service.summaries()); return true; }
    if (head === 'stats') { json(res, 200, await service.portfolio()); return true; }
    if (head === 'search') {
      json(res, 200, service.searchAll(url.searchParams.get('q') ?? ''));
      return true;
    }

    /* ---------------- one plan ---------------- */
    if (head === 'plans' && rest.length >= 1) {
      const slug = rest[0];
      const sub = rest[1];
      const arg = rest[2];

      if (!sub) {
        const detail = await service.detail(slug, url.searchParams.get('model') ?? undefined);
        if (!detail) { json(res, 404, { error: `No plan named ${slug}` }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (sub === 'raw') {
        const record = service.store.get(slug);
        text(res, record?.plan ? 200 : 404, record?.plan?.body ?? 'not found');
        return true;
      }

      if (sub === 'handoff' && arg) {
        const handoff = service.handoff(slug, Number(arg));
        if (!handoff) { json(res, 404, { error: 'No handoff for that phase' }); return true; }
        json(res, 200, handoff);
        return true;
      }

      if (sub === 'prompt' && arg) { text(res, 200, await service.bootPrompt(slug, Number(arg))); return true; }
      if (sub === 'next-prompt') {
        text(res, 200, await service.nextPhasePrompt(slug, arg ?? 'none'));
        return true;
      }
      if (sub === 'qa-prompt' && arg) { text(res, 200, await service.qaPrompt(slug, Number(arg))); return true; }
      if (sub === 'memory-block') { text(res, 200, await service.memoryBlock(slug)); return true; }
      if (sub === 'board') { text(res, 200, await service.boardText(slug)); return true; }
      if (sub === 'gate' && arg) { json(res, 200, await service.gateStatus(slug, Number(arg))); return true; }
      if (sub === 'session-plan') {
        json(res, 200, await service.sessionPlan(slug, url.searchParams.get('model') ?? undefined));
        return true;
      }
      if (sub === 'lint') { json(res, 200, await service.lint(slug)); return true; }
      if (sub === 'work') { json(res, 200, await service.work(slug)); return true; }
    }

    /* ---------------- guarded writes ---------------- */
    if (head === 'write' && req.method === 'POST') {
      const refusal = guardWrite(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }

      const body = (await readBody(req)) as WriteRequest;
      const root = service.root!;

      if (body.action === 'open-editor') {
        const outcome = await openInEditor(String(body.path ?? ''), root.docsDir ?? root.path);
        json(res, outcome.ok ? 200 : 500, outcome);
        return true;
      }

      const plan = planWrite(body, { root: root.path, docsDir: root.docsDir });
      if (url.searchParams.get('dry') === '1') {
        json(res, 200, { dryRun: true, command: `${plan.script} ${plan.args.join(' ')}`, description: plan.description });
        return true;
      }
      const outcome = await runWrite(plan, { scriptsDir: service.flags.scriptsDir, root: root.path });
      service.invalidateAll();
      json(res, outcome.ok ? 200 : 500, { ...outcome, description: plan.description });
      return true;
    }

    json(res, 404, { error: `No API route for ${path}` });
    return true;
  } catch (error) {
    const message = error instanceof WriteError ? error.message : String((error as Error)?.message ?? error);
    json(res, error instanceof WriteError ? 400 : 500, { error: message });
    return true;
  }
}
