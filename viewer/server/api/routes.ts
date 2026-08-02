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
import { isEffort, PERMISSION_MODES } from '../runner/spawn.ts';
import { MODEL_FALLBACK as MODELS } from '../runner/errors.ts';
import { planWrite, runWrite, openInEditor, WriteError, type WriteRequest } from '../writes.ts';
import type { PhaseOptions } from '../runner/state.ts';

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
  return guardMutation(req, service.flags.allowWrites
    ? null
    : 'Writes are disabled. Restart with --allow-writes to enable them.');
}

/**
 * Starting a run is its own decision. `--allow-writes` scaffolds a file;
 * `--allow-run` spawns agent sessions that edit a repository unattended, so it
 * is a separate flag and a separate guard rather than a wider reading of one.
 */
function guardRun(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowRun
    ? null
    : 'Runs are disabled. Restart with --allow-run to enable the autopilot.');
}

function guardMutation(req: IncomingMessage, disabled: string | null): string | null {
  if (disabled) return disabled;
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

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A phase list from a browser: whole positive integers only, deduped, capped. */
function phaseList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return phases.slice(0, 500);
}

/** A skill id: what `/name` or `/plugin:name` accepts, and nothing else. */
const SKILL_ID = /^[a-z0-9][\w.-]{0,63}(:[a-z0-9][\w.-]{0,63})?$/i;

function skillList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && SKILL_ID.test(v)))].slice(0, 40);
}

/**
 * Per-phase choices from a browser.
 *
 * Everything is checked against a known set rather than passed through: these
 * values end up in a child process's argv, so "whatever the client sent" is not
 * an acceptable definition of any of them.
 */
function phaseOptions(value: unknown): Record<string, PhaseOptions> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, PhaseOptions> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    const phase = Number(key);
    if (!Number.isInteger(phase) || phase <= 0) continue;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const option: PhaseOptions = {};
    if (typeof item.model === 'string' && MODELS.includes(item.model)) option.model = item.model;
    if (isEffort(item.effort)) option.effort = item.effort;
    if (typeof item.permissionMode === 'string'
        && (PERMISSION_MODES as readonly string[]).includes(item.permissionMode)) {
      option.permissionMode = item.permissionMode;
    }
    if (Array.isArray(item.tools)) {
      const tools = item.tools.filter((t): t is string => typeof t === 'string' && /^[A-Za-z_][\w]{0,63}$/.test(t));
      if (tools.length) option.tools = [...new Set(tools)].slice(0, 40);
    }
    const skills = skillList(item.skills);
    if (skills?.length) option.skills = skills;
    if (Object.keys(option).length) out[String(phase)] = option;
  }
  return out;
}

export async function handleApi(
  ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const { service } = ctx;
  const path = url.pathname;
  if (!path.startsWith('/api/') && path !== '/events' && !path.startsWith('/hooks/')) return false;

  /* ---------------- the approval hook ---------------- */
  if (path === '/hooks/pre-tool-use') {
    // Deliberately not `guardWrite`: the caller is a `claude` child process,
    // which sends neither the console header nor an origin. Its credential is
    // the per-run bearer token, compared in constant time and dead the moment
    // the run ends.
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return true; }
    if (!service.approvals.verify(req.headers.authorization)) {
      log.warn('hook.rejected', { reason: service.approvals.armed() ? 'bad token' : 'no run is armed' });
      json(res, 401, { error: 'bad or expired run token' });
      return true;
    }
    json(res, 200, await service.decideToolUse(await readBody(req)));
    return true;
  }

  /* ---------------- live updates ---------------- */
  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    // Declared before `stop` can run: a client that vanishes between the header
    // and the first write makes `send` call `stop` immediately, and reaching a
    // `const` declared further down would be a ReferenceError inside the very
    // handler whose job is to survive dead clients.
    let ping: NodeJS.Timeout | undefined;
    let off: (() => void) | undefined;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      off?.();
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

    off = service.onEvent((event, data, id) => {
      send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    ping = setInterval(() => send(': ping\n\n'), 25_000);
    // The client may already have gone during the replay above, in which case
    // `stop` ran before either of these existed. Retire them now.
    if (closed) { clearInterval(ping); off(); }

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
    if (head === 'skills' && req.method === 'GET') { json(res, 200, service.skills()); return true; }

    if (head === 'policy') {
      if (req.method === 'GET') { json(res, 200, service.policy()); return true; }
      if (req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        // Only the tightening direction. Widening what an agent may do at 3am
        // is a file edit, which is the right amount of friction for it.
        if ('allow' in body) {
          json(res, 400, {
            error: 'the allow list is not editable from here — widening what an unattended run may '
              + 'do is a deliberate file edit, not a click',
          });
          return true;
        }
        json(res, 200, service.addPolicy({
          deny: Array.isArray(body.deny) ? body.deny.filter((v): v is string => typeof v === 'string') : [],
          ask: Array.isArray(body.ask) ? body.ask.filter((v): v is string => typeof v === 'string') : [],
        }));
        return true;
      }
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

    /* ---------------- runs + approvals ---------------- */
    if (head === 'runs' && req.method === 'GET') { json(res, 200, service.allRuns()); return true; }

    // Signing in. The GET is a read of `claude auth status` — memoised, free,
    // and safe to poll. The POST opens a terminal, so it is a run-class action.
    if (head === 'auth') {
      if (req.method === 'GET') {
        json(res, 200, await service.authStatus(url.searchParams.get('force') === '1'));
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'login') {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        json(res, 200, await service.startLogin());
        return true;
      }
    }

    if (head === 'approvals') {
      if (req.method === 'GET') { json(res, 200, service.approvals.all()); return true; }
      if (req.method === 'POST' && rest[0]) {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const decision = body.decision === 'allow' ? 'allow' : 'deny';
        const settled = service.approvals.settle(
          rest[0], decision,
          typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
          typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
        );
        json(res, settled ? 200 : 404, settled ? { ok: true, decision } : { error: 'no such pending approval' });
        return true;
      }
    }

    if (head === 'run' && rest.length >= 1) {
      const slug = rest[0];
      const verb = rest[1];

      if (req.method === 'GET') {
        if (verb === 'journal') {
          const id = rest[2] ?? service.runFor(slug)?.id;
          json(res, 200, id ? service.runJournal(slug, id, Number(url.searchParams.get('limit') ?? 500)) : []);
          return true;
        }
        if (verb === 'transcript') {
          json(res, 200, service.runTranscript(slug, rest[2], Number(url.searchParams.get('limit') ?? 400)));
          return true;
        }
        json(res, 200, { run: service.runFor(slug), history: service.runsFor(slug) });
        return true;
      }

      if (req.method === 'POST') {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        switch (verb) {
          case 'start': {
            const state = await service.startRun(slug, {
              model: typeof body.model === 'string' ? body.model : undefined,
              // Checked here rather than passed through: the CLI only *warns*
              // on an unknown effort and carries on at its own default, so a
              // typo would quietly run every phase of a plan at the wrong one.
              effort: isEffort(body.effort) ? body.effort : undefined,
              autonomy: body.autonomy === 'keep-going' ? 'keep-going' : 'halt-on-everything',
              phaseBudgetUsd: numberOrNull(body.phaseBudgetUsd),
              runBudgetUsd: numberOrNull(body.runBudgetUsd),
              resumeRunId: typeof body.resumeRunId === 'string' ? body.resumeRunId : undefined,
              onlyPhases: phaseList(body.onlyPhases),
              phaseOptions: phaseOptions(body.phaseOptions),
              skills: skillList(body.skills),
            });
            json(res, 200, { run: state });
            return true;
          }
          // Every one of these goes through the service, not the runner: after a
          // console restart there is no in-memory run to act on, and the
          // runner's own methods return silently — a button that answers 200
          // and does nothing. The service edits the checkpoint on disk instead.
          case 'ask': {
            // 409 rather than 400: the request is well formed, there is simply
            // nothing listening — and the difference is what tells the console
            // to say "no session is running" instead of "bad request".
            const asked = service.askRun(
              slug,
              String(body.question ?? ''),
              typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
            );
            json(res, asked.ok ? 200 : 409, asked);
            return true;
          }
          case 'pause': json(res, 200, { run: service.pauseRun(slug) }); return true;
          case 'resume': json(res, 200, { run: service.resumePause(slug) }); return true;
          case 'stop': json(res, 200, { run: await service.stopRun(slug) }); return true;
          case 'skip': json(res, 200, { run: service.skipPhase(slug, Number(body.phase)) }); return true;
          case 'retry': json(res, 200, { run: service.retryPhase(slug, Number(body.phase)) }); return true;
          case 'settings': {
            const run = service.configureRun(slug, {
              ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
              ...('effort' in body ? { effort: isEffort(body.effort) ? body.effort : '' } : {}),
              ...(body.autonomy === 'keep-going' || body.autonomy === 'halt-on-everything'
                ? { autonomy: body.autonomy } : {}),
              ...('phaseBudgetUsd' in body ? { phaseBudgetUsd: numberOrNull(body.phaseBudgetUsd) } : {}),
              ...('runBudgetUsd' in body ? { runBudgetUsd: numberOrNull(body.runBudgetUsd) } : {}),
              ...('maxConsecutiveFailures' in body
                ? { maxConsecutiveFailures: Number(body.maxConsecutiveFailures) } : {}),
              ...('onlyPhases' in body ? { onlyPhases: phaseList(body.onlyPhases) ?? null } : {}),
              ...('phaseOptions' in body ? { phaseOptions: phaseOptions(body.phaseOptions) ?? null } : {}),
              ...('skills' in body ? { skills: skillList(body.skills) ?? null } : {}),
            });
            json(res, 200, { run });
            return true;
          }
          default:
            json(res, 404, { error: `No run verb "${verb}"` });
            return true;
        }
      }
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
