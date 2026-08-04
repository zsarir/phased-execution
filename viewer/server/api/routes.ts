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
import { agentEnabled, checkRoot, listDirs } from '../config.ts';
import { buildAgentLaunch } from '../agent.ts';
import { parseRecoveryRequest, type RecoveryFacts } from '../recovery.ts';
import { parseQaRequest, type QaFacts } from '../qa-session.ts';
import { isClientDisconnect, log } from '../log.ts';
import { isEffort, PERMISSION_MODES } from '../runner/spawn.ts';
import { isPermissionProfile, type PolicyScope } from '../runner/approvals.ts';
import { MODEL_FALLBACK as MODELS } from '../runner/errors.ts';
import { planWrite, runWrite, openInEditor, WriteError, type WriteRequest } from '../writes.ts';
import { TERMINAL_PATH, type LaunchSpec } from '../terminal.ts';
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

/**
 * The shell gate — a third capability, not a wider reading of the other two.
 *
 * `--allow-run` spawns an agent inside a permission policy this console
 * enforces and can revoke; `--allow-terminal` hands over a shell where the only
 * policy is the person typing. Minting a ticket is also the only place the
 * cross-site check can be made — the WebSocket upgrade that follows cannot make
 * it, because CORS does not apply to upgrades and Origin is forgeable there.
 */
function guardTerminal(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowTerminal
    ? null
    : 'The terminal is disabled. Restart with --allow-terminal to enable it.');
}

/**
 * The agent gate — a fourth capability, again not a wider reading of any
 * other. An agent session is an interactive `claude` under the person's own
 * eyes: its argv is server-built from allowlisted fields (`agent.ts`) and the
 * CLI asks before it acts, which is less than a raw shell hands over and more
 * than the autopilot's policy allows. `agentEnabled()` rather than the flag,
 * so folding the capability into `--allow-terminal` stays a one-line change.
 */
function guardAgent(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, agentEnabled(service.flags)
    ? null
    : 'Agent sessions are disabled. Restart with --allow-agent to enable them.');
}

/**
 * For verbs on an EXISTING session of either kind — reattach, close. Either
 * capability opens the door; `mint()` still gates by the session's own kind,
 * so an agent-only console can never be talked into handing out a live shell.
 */
function guardAnySession(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, (service.flags.allowTerminal || agentEnabled(service.flags))
    ? null
    : 'The terminal is disabled. Restart with --allow-terminal to enable it.');
}

/**
 * The cross-site check on its own, for POSTs that are not a capability.
 *
 * Choosing a source directory and saving a theme both have to work in a
 * read-only console, so neither belongs behind `--allow-writes`. They still
 * must not be drivable by another page, which is what this is.
 */
function guardCsrf(req: IncomingMessage): string | null {
  return guardMutation(req, null);
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

/**
 * The keys that make a mark-read request *scoped*.
 *
 * Presence, not usefulness: see the note at the call site. A body carrying any
 * of these is asking about something in particular, and must never be answered
 * by clearing the whole inbox.
 */
const SCOPE_KEYS = ['slug', 'category', 'runId', 'sessionId', 'phase'] as const;

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The phase a run control was aimed at, when it named one.
 *
 * Absent means "whatever is running", which is what every control meant before
 * they could be aimed — so an omitted or unusable value must read as null and
 * never as phase 0. The service compares it against the live child and refuses
 * by name rather than acting on whichever phase happens to be running now.
 */
function targetPhase(body: Record<string, unknown>): number | null {
  const n = Number(body.phase);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A phase list from a browser: whole positive integers only, deduped, capped. */
function phaseList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return phases.slice(0, 500);
}

/**
 * The client's idempotency key for a write to a live session.
 *
 * Read from the header first because that is where the convention lives, and
 * from the body as a fallback so a `curl` or `bin/btw` can send one too. Kept
 * short and to a safe alphabet: it is used as a map key and echoed back.
 */
function idempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string | undefined {
  const raw = req.headers['idempotency-key'] ?? body.key;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const key = value.trim().slice(0, 100);
  return /^[\w.:-]{8,100}$/.test(key) ? key : undefined;
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
    // Authentication is unchanged — `verify` above still decides that. This
    // asks the second question the same token can answer: WHICH run sent it, so
    // the decision is made under that run's profile rather than under whichever
    // run happens to be current. One runner makes those the same; a pool does
    // not, and threading the id now is what keeps that change to one place.
    const hookRunId = service.approvals.runIdFor(req.headers.authorization);
    json(res, 200, await service.decideToolUse(await readBody(req), hookRunId));
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
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const check = service.open(String(body.path ?? ''));
        json(res, check.ok ? 200 : 400, { check, state: service.state() });
        return true;
      }
    }

    if (head === 'prefs' && req.method === 'POST') {
      const refusal = guardCsrf(req);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      const body = await readBody(req);
      json(res, 200, service.savePreferences(body));
      return true;
    }

    /* ---------------- push notifications ---------------- */
    if (head === 'push') {
      // Reading the catalogue and the public key is harmless. Everything that
      // changes who gets woken is a mutation, and gets the cross-site check —
      // but not `--allow-writes`: subscribing a device writes nothing in a
      // repository, and a read-only console is exactly where you would want
      // to be told a run needs you.
      if (req.method === 'GET' && rest.length === 0) { json(res, 200, service.push.state()); return true; }

      if (req.method === 'POST') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const action = rest[0] ?? '';

        if (action === 'subscribe') {
          const result = service.push.subscribe(body.subscription, body.categories, body.label);
          if ('error' in result) { json(res, 400, result); return true; }
          json(res, 200, { device: result, state: service.push.state() });
          return true;
        }
        if (action === 'unsubscribe') {
          json(res, 200, { removed: service.push.unsubscribe(body.id ?? body.endpoint), state: service.push.state() });
          return true;
        }
        if (action === 'categories') {
          const device = service.push.setCategories(body.id, body.categories);
          if (!device) { json(res, 404, { error: 'no such device' }); return true; }
          json(res, 200, { device, state: service.push.state() });
          return true;
        }
        if (action === 'test') {
          json(res, 200, await service.push.test(String(body.id ?? '')));
          return true;
        }
      }
    }

    /* ---------------- the notification inbox ---------------- */
    if (head === 'notifications') {
      // Reads are unguarded like the rest of the read API. Mutations take the
      // cross-site check but NOT `--allow-writes`: marking a notification read
      // writes nothing in a repository, and a read-only console is exactly
      // where you would want to clear an inbox.
      if (req.method === 'GET') {
        json(res, 200, service.inbox({
          category: url.searchParams.get('category'),
          unreadOnly: url.searchParams.get('unread') === '1',
          limit: Number(url.searchParams.get('limit') ?? 50),
          before: url.searchParams.get('before'),
        }));
        return true;
      }

      if (req.method === 'POST' && rest[0] === 'read') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        // A scope marks read only what it matches — this is the auto-read a
        // run or plan page fires when you open it.
        //
        // The branch is chosen by which KEYS the body carries, never by whether
        // their values are usable. `{slug: ""}` is a page whose route has not
        // parsed yet, and reading it as "no scope" sends it down the bulk path,
        // where it clears the entire inbox — observed doing exactly that on a
        // scratch console. Asking to read *something* can never be answered by
        // reading *everything*: a blank scope reaches `markReadWhere`, which
        // matches nothing, and 0 records change.
        const scoped = SCOPE_KEYS.some((key) => key in body);
        if (scoped) {
          const str = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 128) : undefined);
          json(res, 200, service.markNotificationsReadFor({
            ...(str(body.slug) ? { slug: str(body.slug) } : {}),
            ...(str(body.category) ? { category: str(body.category) } : {}),
            ...(str(body.runId) ? { runId: str(body.runId) } : {}),
            ...(str(body.sessionId) ? { sessionId: str(body.sessionId) } : {}),
            ...(Number.isInteger(body.phase) ? { phase: Number(body.phase) } : {}),
          }));
          return true;
        }

        // No `ids` means every unread one — "mark all read" is the common case
        // and does not deserve the client enumerating an inbox to express it.
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((v): v is string => typeof v === 'string').slice(0, 1_000)
          : null;
        json(res, 200, service.markNotificationsRead(ids));
        return true;
      }

      if (req.method === 'DELETE') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = url.searchParams.get('id');
        const scope = url.searchParams.get('scope');
        // Explicit or nothing: an unrecognised scope clears nothing rather than
        // falling through to the most destructive reading of it.
        if (id) { json(res, 200, service.clearNotifications({ id })); return true; }
        if (scope === 'read' || scope === 'all') { json(res, 200, service.clearNotifications(scope)); return true; }
        json(res, 400, { error: 'pass ?id=<id>, ?scope=read or ?scope=all' });
        return true;
      }
    }

    /* ---------------- restarting the console itself ---------------- */
    if (head === 'restart') {
      if (req.method === 'GET') { json(res, 200, service.restartReadiness()); return true; }
      if (req.method === 'POST') {
        // Run-class, not write-class: this ends a process that may be
        // supervising agent sessions.
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
        const outcome = service.restart(by, body.force === true);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- stopping the console itself ---------------- */
    if (head === 'shutdown') {
      if (req.method === 'GET') { json(res, 200, service.shutdownReadiness()); return true; }
      if (req.method === 'POST') {
        // Deliberately `guardCsrf` and NOT `guardRun`, unlike restart. Turning
        // a process off is the one verb every console must have: gating it on
        // `--allow-run` would mean a read-only console — the common case — has
        // no off switch at all, which is the bug. The cross-site check still
        // applies, so another page cannot press it for you.
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        // An explicit confirmation in the body, so a bare POST — a stray curl, a
        // replayed request — cannot end the console by accident.
        if (body.confirm !== true) {
          json(res, 400, { error: 'pass {"confirm":true} — shutting the console down is not a default.' });
          return true;
        }
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
        const outcome = service.shutdown(by);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- the terminal ---------------- */
    if (head === 'terminal') {
      // Deliberately above the "no source directory is open" wall below: a
      // shell is exactly what you want on a machine where there is nothing to
      // open yet.
      if (req.method === 'GET') { json(res, 200, service.terminals.state()); return true; }

      if (req.method === 'POST') {
        // The body decides which gate applies, so it is read first; the
        // guards still run before anything is created or looked up.
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : undefined;
        const kind = body.kind === 'claude' ? 'claude'
          : body.kind == null || body.kind === 'shell' ? 'shell'
          : null;
        if (kind === null) { json(res, 400, { error: "unknown session kind — 'shell' or 'claude'." }); return true; }

        // Reattach goes by the session's own kind (mint checks it); a fresh
        // session goes by the kind being asked for.
        const refusal = sessionId ? guardAnySession(req, service)
          : kind === 'claude' ? guardAgent(req, service)
          : guardTerminal(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }

        let launch: LaunchSpec | undefined;
        if (!sessionId && kind === 'claude') {
          // A recovery names its target; the SERVER reads the board, the run,
          // the diagnosis and the lock and composes the briefing from those.
          // The browser never dictates what an agent session is told, and the
          // three guards (autopilot driving, already recovering, signed out)
          // live with the facts they are about.
          let recovery: RecoveryFacts | undefined;
          if (body.intent === 'recovery') {
            const parsed = parseRecoveryRequest(body);
            if (!parsed.ok) { json(res, parsed.status, { error: parsed.error }); return true; }
            const resolved = await service.resolveRecovery(parsed.request);
            if (!resolved.ok) {
              json(res, resolved.status, {
                error: resolved.error,
                ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
              });
              return true;
            }
            recovery = resolved.facts;
          }

          // Same split for a review, and the same reason: the browser names the
          // phase, the SERVER reads the plan, the handoff, the history and the
          // board. The guard that keeps a review independent lives with those
          // facts, not in the page that offered the button.
          let qa: QaFacts | undefined;
          if (body.intent === 'qa') {
            const parsed = parseQaRequest(body);
            if (!parsed.ok) { json(res, parsed.status, { error: parsed.error }); return true; }
            const resolved = await service.resolveQa(parsed.request);
            if (!resolved.ok) {
              json(res, resolved.status, {
                error: resolved.error,
                ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
              });
              return true;
            }
            qa = resolved.facts;
          }

          const built = buildAgentLaunch(body, {
            skills: () => service.skills(),
            scriptsDir: service.flags.scriptsDir,
            rootOpen: Boolean(service.store),
            ...(recovery ? { recovery } : {}),
            ...(qa ? { qa } : {}),
          });
          if (!built.ok) { json(res, built.status, { error: built.error }); return true; }
          launch = built.launch;
        }

        const minted = await service.terminals.mint(sessionId, {
          cols: Number(body.cols), rows: Number(body.rows),
        }, launch);
        if (!minted.ok) { json(res, minted.status, { error: minted.error }); return true; }
        // The socket path travels with the ticket so the client never has to
        // hard-code it — one source of truth for where the terminal lives.
        json(res, 200, { ...minted, path: TERMINAL_PATH });
        return true;
      }

      if (req.method === 'DELETE') {
        const refusal = guardAnySession(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = url.searchParams.get('id') ?? rest[0] ?? '';
        // Two different verbs on the same record, and conflating them is how a
        // "tidy the list" button ends up killing a working session. `dismiss`
        // drops a record whose process is already gone and refuses on a live
        // one; the default closes the session.
        if (url.searchParams.get('action') === 'dismiss') {
          const outcome = service.terminals.dismiss(id);
          json(res, outcome.ok ? 200 : 409, { ...outcome, state: service.terminals.state() });
          return true;
        }
        json(res, 200, { closed: service.terminals.kill(id), state: service.terminals.state() });
        return true;
      }
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
      if (req.method === 'GET') {
        json(res, 200, service.policy(url.searchParams.get('slug')));
        return true;
      }
      if (req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        // `add`/`remove` is the editor's shape and may widen — deliberately,
        // named, scoped and journaled (see `editPolicy`). A bare `{deny, ask}`
        // body is the old tightening-only contract and still means what it did.
        if ('add' in body || 'remove' in body) {
          const rules = (value: unknown) => (Array.isArray(value)
            ? value.filter((v): v is string => typeof v === 'string') : []);
          const lists = (value: unknown) => {
            const part = (value ?? {}) as Record<string, unknown>;
            return { deny: rules(part.deny), ask: rules(part.ask), allow: rules(part.allow) };
          };
          const slug = typeof body.slug === 'string' ? body.slug : null;
          const scope: PolicyScope = body.scope === 'plan' ? 'plan' : 'global';
          if (scope === 'plan' && !slug) {
            json(res, 400, { error: 'a plan-scoped rule needs a plan' });
            return true;
          }
          json(res, 200, service.editPolicy({
            scope,
            slug,
            add: lists(body.add),
            remove: lists(body.remove),
            by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
          }));
          return true;
        }

        if ('allow' in body) {
          json(res, 400, {
            error: 'to widen, post {add:{allow:[…]}, scope:"plan"|"global"} — a bare allow list is '
              + 'the old tightening-only shape and cannot say who asked or at what scope',
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

      /* Turn QA on for a plan that has it off. Write-class — it creates
       * `test-status.md` and backfills the already-complete phases — so it sits
       * behind `--allow-writes`, not behind the agent flag: activating QA and
       * minting a reviewer are two different permissions. */
      if (sub === 'qa-mode' && req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const phase = Number(body.phase);
        if (!Number.isInteger(phase) || phase < 1) {
          json(res, 400, { error: 'pass {phase} — activation records that phase and waives the rest' });
          return true;
        }
        const outcome = await service.activateQa(slug, phase);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- the admission queue ----------------
     * Read-only, and unauthenticated like every other read: it says what is
     * holding a scope and what is waiting on it. `waitingOn` is the part that
     * matters — "queued" alone is the same non-answer `pausing` used to be,
     * naming a thing that is not happening without naming what would have to
     * change for it to happen. */
    if (head === 'queue' && req.method === 'GET') {
      json(res, 200, service.queueSnapshot());
      return true;
    }

    /* ---------------- stale claims ----------------
     * Release reads the owner out of the lock file rather than asking a person
     * to retype it — see `Service.releaseLock`. Write-class, because it removes
     * a file inside the repository. */
    if (head === 'locks' && req.method === 'POST' && rest[0] === 'release') {
      const refusal = guardWrite(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      const body = await readBody(req);

      // `{expired: true}` is the bulk verb: every stale claim in the source, one
      // result per lock so a single refusal cannot hide the rest.
      if (body.expired === true) {
        const results = await service.releaseExpiredLocks();
        json(res, 200, { results, released: results.filter((r) => r.ok).length });
        return true;
      }

      const slug = typeof body.slug === 'string' ? body.slug : '';
      const phase = Number(body.phase);
      if (!slug || !Number.isInteger(phase)) {
        json(res, 400, { error: 'pass {slug, phase} for one lock, or {expired: true} for every stale one' });
        return true;
      }
      const result = await service.releaseLock(slug, phase);
      // 409 rather than 400 on a live lease: the request is well formed, the
      // phase is simply still being worked. `error` carries the explanation
      // because that is the field `lib/api.ts` turns into the thrown message —
      // without it a refusal reads as "Request failed (409)".
      json(res, result.ok ? 200 : 409, result.ok ? result : { ...result, error: result.detail });
      return true;
    }

    /* ---------------- runs + approvals ---------------- */
    if (head === 'runs' && req.method === 'GET') { json(res, 200, await service.allRuns()); return true; }

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
        // `remember: "plan" | "global"` turns this one answer into a rule. Any
        // other value is just an answer — a typo must not widen anything.
        const scope = body.remember === 'plan' ? 'plan'
          : body.remember === 'global' ? 'global' : null;
        const answered = service.decideApproval(
          rest[0], decision,
          typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
          typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
          scope && typeof body.rule === 'string' && body.rule
            ? { scope, rule: body.rule.slice(0, 200) } : undefined,
        );
        json(res, answered.ok ? 200 : 404, answered);
        return true;
      }
    }

    if (head === 'run' && rest.length >= 1) {
      const slug = rest[0];
      const verb = rest[1];

      if (req.method === 'GET') {
        if (verb === 'journal') {
          const id = rest[2] ?? service.runIdFor(slug);
          json(res, 200, id ? service.runJournal(slug, id, Number(url.searchParams.get('limit') ?? 500)) : []);
          return true;
        }
        if (verb === 'transcript') {
          json(res, 200, service.runTranscript(slug, rest[2], Number(url.searchParams.get('limit') ?? 400)));
          return true;
        }
        // Why a phase is not done, in one payload: the command output, the
        // session's closing words, the lint summary, the board-vs-handoff
        // disagreement, and what can still be done about it. All of it was
        // already on disk; none of it was reachable from the page.
        if (verb === 'diagnosis') {
          const phase = Number(rest[2] ?? url.searchParams.get('phase'));
          if (!Number.isFinite(phase)) { json(res, 400, { error: 'a phase number is required' }); return true; }
          const diagnosis = await service.phaseDiagnosis(slug, phase);
          json(res, diagnosis ? 200 : 404, diagnosis ?? { error: `no record of phase ${phase} in any run of ${slug}` });
          return true;
        }
        // What each phase of this plan touches, and what that collides with
        // right now. Read from the same Repos column and the same live locks
        // admission uses, so the page cannot show one answer while the
        // scheduler acts on another.
        if (verb === 'scopes') {
          json(res, 200, { scopes: service.phaseScopes(slug) });
          return true;
        }
        // `eta` rides along rather than getting an endpoint of its own: it is
        // derived from exactly this run plus the plan's board, and a second
        // request could be answered against a board that had moved on.
        json(res, 200, {
          run: await service.runFor(slug),
          history: await service.runsFor(slug),
          eta: await service.runEta(slug),
        });
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
              // Flipped with the run defaults (see `runner/state.ts` newRun).
              autonomy: body.autonomy === 'halt-on-everything' ? 'halt-on-everything' : 'keep-going',
              phaseBudgetUsd: numberOrNull(body.phaseBudgetUsd),
              runBudgetUsd: numberOrNull(body.runBudgetUsd),
              resumeRunId: typeof body.resumeRunId === 'string' ? body.resumeRunId : undefined,
              onlyPhases: phaseList(body.onlyPhases),
              phaseOptions: phaseOptions(body.phaseOptions),
              skills: skillList(body.skills),
              // Anything unrecognised is `guarded`. A typo must not be the
              // reason a run takes the guard rails off.
              permissionProfile: isPermissionProfile(body.permissionProfile)
                ? body.permissionProfile : 'guarded',
            });
            json(res, 200, { run: state });
            return true;
          }
          // Every one of these goes through the service, not the runner: after a
          // console restart there is no in-memory run to act on, and the
          // runner's own methods return silently — a button that answers 200
          // and does nothing. The service edits the checkpoint on disk instead.
          case 'ask':
          case 'steer': {
            // 409 rather than 400: the request is well formed, there is simply
            // nothing listening — and the difference is what tells the console
            // to say "no session is running" instead of "bad request".
            const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
            const key = idempotencyKey(req, body);
            const sent = verb === 'ask'
              ? service.askRun(slug, String(body.question ?? ''), by, key, targetPhase(body))
              : service.steerRun(
                slug, String(body.instruction ?? body.question ?? ''), by, key, targetPhase(body),
              );
            json(res, sent.ok ? 200 : 409, sent);
            return true;
          }
          case 'pause': json(res, 200, { run: service.pauseRun(slug) }); return true;
          case 'resume': json(res, 200, { run: service.resumePause(slug) }); return true;
          // Freeze/thaw act on a live child, so unlike pause they have no
          // on-disk fallback: a null run here means this console is not the one
          // driving, which the client reports rather than papering over.
          case 'freeze': {
            const done = service.freezeRun(
              slug,
              typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              targetPhase(body),
            );
            // `?.ok === false` rather than `!done.ok`: a refusal now carries the
            // reason the operator needs, and the optional chain keeps a service
            // that answers nothing at all reading as "it happened" exactly as
            // it did before this returned a result object.
            json(res, done?.ok === false ? 409 : 200,
              done?.ok === false ? { error: done.reason } : { run: done?.run });
            return true;
          }
          case 'thaw': {
            const done = service.thawRun(slug, targetPhase(body));
            json(res, done?.ok === false ? 409 : 200,
              done?.ok === false ? { error: done.reason } : { run: done?.run });
            return true;
          }
          case 'stop': {
            // The one control that cannot be taken back, so a phase named in
            // the body is checked before anything is signalled — see
            // `Service.stopRun`. Same 409-with-a-reason shape the recovery
            // verbs use for a refusal.
            try {
              json(res, 200, { run: await service.stopRun(slug, targetPhase(body)) });
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the run could not be stopped' });
            }
            return true;
          }
          // Dismissing a stopped run's card, and taking that back. Addressed by
          // run id rather than "this plan's run": the card belongs to the run
          // that raised it, which on a plan that has run since is not the
          // latest one. Nothing is deleted — see `RunResolution`.
          case 'resolve':
          case 'unresolve': {
            const runId = typeof body.runId === 'string' ? body.runId.slice(0, 64) : '';
            if (!runId) { json(res, 400, { error: 'a runId is required' }); return true; }
            const run = verb === 'resolve'
              ? service.resolveRun(slug, runId, {
                note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
                by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              })
              : service.unresolveRun(slug, runId);
            json(res, run ? 200 : 404, run ? { run } : { error: `no run ${runId} of ${slug}` });
            return true;
          }
          case 'skip': json(res, 200, { run: service.skipPhase(slug, Number(body.phase)) }); return true;
          case 'retry': json(res, 200, { run: service.retryPhase(slug, Number(body.phase)) }); return true;
          // The middle ground between Retry and Skip: re-check what is on disk,
          // or ask the phase's own session to finish what it started. Every one
          // of these ends in the same three checks, so none of them can mark a
          // phase done that the board does not agree about.
          case 'recheck':
          case 'closeout':
          case 'resume-phase': {
            const mode = verb === 'resume-phase' ? 'resume' : verb;
            try {
              const run = await service.recoverPhase(slug, Number(body.phase), mode, {
                instruction: typeof body.instruction === 'string' ? body.instruction.slice(0, 8_000) : undefined,
                by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              });
              json(res, 200, { run });
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the phase could not be recovered' });
            }
            return true;
          }
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
              ...(isPermissionProfile(body.permissionProfile)
                ? { permissionProfile: body.permissionProfile } : {}),
            }, typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console');
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
