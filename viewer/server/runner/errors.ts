/**
 * What stopped the session, and when it is worth trying again.
 *
 * An unattended run fails for a dozen different reasons and they want opposite
 * responses. Sleeping through an Opus-only limit wastes hours when switching
 * model would have carried on; retrying an expired login hammers a wall
 * forever. So every stop is classified into one disposition, and the runner
 * only ever acts on the disposition.
 *
 * The division of labour matters: Claude Code already retries 429/529,
 * timeouts and dropped connections up to `CLAUDE_CODE_MAX_RETRIES` (10) with
 * exponential backoff, and `CLAUDE_CODE_RETRY_WATCHDOG=1` — documented for
 * exactly this case, "CI/unattended sessions" — makes it retry 429/529
 * indefinitely and raises other transient retries to ~3 hours. We set that on
 * the child and do NOT reimplement backoff here. What reaches this module is
 * what the CLI gave up on, plus the things it cannot decide: whether to wait
 * out a plan limit, drop to a cheaper model, resume with a bigger budget, or
 * stop and fetch a human.
 */

export type Disposition =
  /** Transient; try the same phase again shortly. */
  | { kind: 'retry'; afterMs: number; reason: string }
  /** A plan window is exhausted. Sleep until it reopens, then retry. */
  | { kind: 'wait-until'; at: Date; reason: string }
  /** Only this model is exhausted or at capacity — the run continues on another. */
  | { kind: 'switch-model'; reason: string }
  /** The work is unfinished but intact: resume that session with a bigger cap. */
  | { kind: 'resume'; raise: 'budget' | 'turns'; reason: string }
  /** Nothing automatic will fix this. Park, notify, wait for a person. */
  | { kind: 'needs-human'; reason: string }
  /** The phase itself failed. Runner decides retry-vs-halt by its own counters. */
  | { kind: 'phase-failed'; reason: string }
  /** Finished normally. */
  | { kind: 'ok' };

export type StopSignal = {
  /** `subtype` from the result message, when one arrived. */
  subtype?: string;
  /** Process exit code. */
  code?: number | null;
  /** `stop_reason` from the final assistant turn. */
  stopReason?: string | null;
  /** Combined result text / stderr — where the limit messages actually appear. */
  text?: string;
  /** Error categories seen on `system/api_retry` events during the run. */
  retryCategories?: string[];
  /** The model the run used, so a switch can be proposed sensibly. */
  model?: string;
};

/** Past this, sitting and waiting is worse than telling someone. */
const MAX_AUTO_WAIT_MS = 12 * 60 * 60 * 1000;
/** Never come back the instant a window opens — clocks disagree. */
const RESET_MARGIN_MS = 90_000;

/* ------------------------------------------------------------------ *
 * Reset-time parsing
 * ------------------------------------------------------------------ */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Pull the reset moment out of a usage-limit message. Claude Code has emitted
 * several shapes over time and an unattended runner meets all of them:
 *
 *   You've hit your session limit · resets 3:45pm
 *   You've hit your weekly limit · resets Mon 12:00am
 *   Claude usage limit reached. Your limit will reset at 3pm (America/Santiago)
 *   Claude AI usage limit reached|1749924000
 *
 * Returns null when nothing parses — the caller then falls back to a
 * conservative fixed wait rather than guessing a time.
 */
export function parseResetTime(text: string, now = new Date()): Date | null {
  if (!text) return null;

  // Epoch form first: unambiguous, no timezone reasoning needed.
  const epoch = /usage limit reached\s*\|\s*(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n > 1e11 ? n : n * 1000;
    const at = new Date(ms);
    if (!Number.isNaN(at.getTime())) return at;
  }

  // "… (America/Santiago)" — an explicit zone, so resolve the clock time there.
  const zoned = /reset at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+\/[A-Za-z_+-]+)\)/i.exec(text);
  if (zoned) {
    const at = nextClockTime({
      hour: Number(zoned[1]),
      minute: Number(zoned[2] ?? 0),
      meridiem: zoned[3]?.toLowerCase() as 'am' | 'pm' | undefined,
      timeZone: zoned[4],
      now,
    });
    if (at) return at;
  }

  // "resets Mon 12:00am" — a weekday, so it may be days out (weekly window).
  const weekly = /resets?\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (weekly) {
    const target = WEEKDAYS.indexOf(weekly[1].toLowerCase().slice(0, 3));
    const at = nextClockTime({
      hour: Number(weekly[2]),
      minute: Number(weekly[3] ?? 0),
      meridiem: weekly[4]?.toLowerCase() as 'am' | 'pm' | undefined,
      now,
    });
    if (at && target >= 0) {
      // Roll forward to that weekday.
      while (at.getDay() !== target) at.setDate(at.getDate() + 1);
      return at;
    }
    if (at) return at;
  }

  // "resets 3:45pm" / "reset at 3pm" — plain local clock time.
  const local = /(?:resets?|reset at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (local) {
    return nextClockTime({
      hour: Number(local[1]),
      minute: Number(local[2] ?? 0),
      meridiem: local[3].toLowerCase() as 'am' | 'pm',
      now,
    });
  }

  return null;
}

/**
 * The next moment the clock reads this time — today if it is still ahead,
 * otherwise tomorrow. With a `timeZone`, the wall-clock time is interpreted
 * there and converted back, which is what makes a message like
 * "3pm (America/Santiago)" usable from a machine in another zone.
 */
function nextClockTime(opts: {
  hour: number; minute: number; meridiem?: 'am' | 'pm'; timeZone?: string; now: Date;
}): Date | null {
  let hour = opts.hour;
  if (opts.meridiem === 'pm' && hour < 12) hour += 12;
  if (opts.meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || opts.minute < 0 || opts.minute > 59) return null;

  if (opts.timeZone) {
    // The day must come from the clock in THAT zone, not from UTC. Using the
    // UTC date lands on the wrong calendar day whenever the two disagree —
    // 11pm Los Angeles asked at 01:00 UTC used to resolve 24h late, which for a
    // runner means sleeping through a whole working day it could have used.
    const today = zoneParts(opts.now, opts.timeZone);
    if (!today) return null;
    let candidate = zonedInstant(today.year, today.month, today.day, hour, opts.minute, opts.timeZone);
    if (!candidate || candidate.getTime() <= opts.now.getTime()) {
      // Date.UTC normalises a day past the end of the month for us.
      candidate = zonedInstant(today.year, today.month, today.day + 1, hour, opts.minute, opts.timeZone);
    }
    return candidate;
  }

  const at = new Date(opts.now);
  at.setSeconds(0, 0);
  at.setHours(hour, opts.minute, 0, 0);
  if (at.getTime() <= opts.now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** The calendar date and clock this instant shows in `timeZone`. */
function zoneParts(at: Date, timeZone: string): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const year = get('year');
    if (!Number.isFinite(year)) return null;
    return { year, month: get('month'), day: get('day') };
  } catch {
    return null; // an unknown zone id
  }
}

/**
 * The instant at which `timeZone` reads this wall-clock date and time.
 *
 * Two passes: guess with the offset at the naive instant, then correct with the
 * offset actually in force there — they differ across a DST boundary, and a
 * usage window reopening at 3am on a spring-forward Sunday is exactly the kind
 * of edge an unattended runner meets at 3am with nobody watching.
 */
function zonedInstant(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const first = zoneOffsetMs(new Date(naive), timeZone);
  if (first === null) return null;
  const corrected = zoneOffsetMs(new Date(naive - first), timeZone);
  return new Date(naive - (corrected ?? first));
}

/** How far `timeZone` is ahead of UTC at this instant, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number | null {
  const parts = zoneShown(at, timeZone);
  if (!parts) return null;
  return parts - Math.floor(at.getTime() / 1000) * 1000;
}

/** This instant's zone-local wall clock, expressed as if it were UTC. */
function zoneShown(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const year = get('year');
    if (!Number.isFinite(year)) return null;
    return Date.UTC(year, get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/**
 * Every pattern here is matched against `text`, which is the session's own
 * output as well as its stderr. That makes loose tokens actively dangerous: a
 * phase that refactors a rate limiter, counts 401 lines, or touches a billing
 * module would otherwise be read as an auth failure and park the whole run for
 * a human who has nothing to fix. So each pattern demands the framing Claude
 * Code actually prints — `API Error:`, a full sentence — never a bare number or
 * a single common word.
 */
const RE = {
  // Shared across every model — switching model does NOT help, only time does.
  planLimit: /you'?ve hit your (session|weekly) limit|usage limit reached|claude ai usage limit/i,
  // Model-specific — the run continues immediately on another model.
  modelLimit: /you'?ve hit your (opus|sonnet|haiku|fable)[a-z0-9. -]* limit/i,
  overloaded: /api error:?\s*529|\b529\b[^\n]{0,24}overload|overloaded[_ ]error|overloaded errors|api is at capacity|is currently overloaded/i,
  rateLimit: /api error:?\s*429|request rejected \(429\)|rate[_ ]limit_error|rate.?limited|temporarily limiting requests|too many requests/i,
  // `login expired` is anchored to the start of a line or clause: the CLI leads
  // with the condition, prose embeds it ("tests for the login expired path").
  auth: /please run \/login|not logged in|invalid api key|invalid x-api-key|oauth (token|session) (expired|revoked|invalid)|failed to authenticate|could not be refreshed|(^|[·|\n]\s*)login expired|authentication_error|could not resolve authentication|api error:?\s*401|401 unauthorized/i,
  billing: /credit balance is too low|insufficient credits|usage credits required|billing (error|issue|problem)|spend limit (reached|exceeded)|payment (required|method)/i,
  orgPolicy: /organization has (been )?disabled|oauth_org_not_allowed|disabled api key authentication|disabled claude subscription/i,
  serverError: /api error:?\s*5\d\d|internal server error/i,
  timeout: /request timed out/i,
};

/**
 * Decide what a stopped session means. Order matters: the specific, expensive
 * mistakes are checked before the general ones — a model-only limit must never
 * be read as a plan limit, or the runner sleeps for hours it did not need to.
 */
export function classify(signal: StopSignal, now = new Date()): Disposition {
  const text = signal.text ?? '';
  const cats = signal.retryCategories ?? [];

  // Credentials are checked BEFORE `success` is believed. A session whose OAuth
  // token had expired was seen reporting `subtype: success` after one turn and
  // $0.00, having done nothing at all — and a runner that takes that at face
  // value goes on to verify work that was never attempted, on every remaining
  // phase, until something else stops it. What the output says outranks what
  // the exit status claims.
  const brokenCredentials = RE.orgPolicy.test(text) || cats.includes('oauth_org_not_allowed')
    ? 'organization policy blocks this credential'
    : RE.auth.test(text) || cats.includes('authentication_failed')
      ? 'authentication failed — run /login in this workspace, then start the run again'
      : RE.billing.test(text) || cats.includes('billing_error')
        ? 'billing or credit balance needs attention'
        : null;
  if (brokenCredentials) return { kind: 'needs-human', reason: brokenCredentials };

  if (signal.subtype === 'success') return { kind: 'ok' };

  // Killed by a supervisor or the OS — not the model's doing.
  if (signal.code === 143) return { kind: 'needs-human', reason: 'session was terminated (SIGTERM)' };
  if (signal.code === 137) return { kind: 'retry', afterMs: 30_000, reason: 'session was killed (SIGKILL/OOM) — retrying once' };

  // The work is intact, just capped. `subtype` is a structured field the CLI
  // sets deliberately, so it outranks every text heuristic below — a phase that
  // spent its budget while *discussing* rate limits must still resume, not be
  // read as rate-limited. Resuming the SAME session keeps what it already did.
  if (signal.subtype === 'error_max_budget_usd') {
    return { kind: 'resume', raise: 'budget', reason: 'phase hit its cost cap mid-work' };
  }
  if (signal.subtype === 'error_max_turns') {
    return { kind: 'resume', raise: 'turns', reason: 'phase hit its turn cap mid-work' };
  }

  // Model-specific exhaustion. Checked BEFORE the plan limit: the message
  // "You've hit your Opus limit" also contains the word "limit", and reading it
  // as a plan limit would idle the run for hours when another model is free.
  if (RE.modelLimit.test(text)) {
    return { kind: 'switch-model', reason: `${signal.model ?? 'this model'} is rate-limited; the window is per-model` };
  }

  // Plan window exhausted — shared across models, so only time fixes it.
  if (RE.planLimit.test(text)) {
    const at = parseResetTime(text, now);
    if (at) {
      const waitMs = at.getTime() - now.getTime() + RESET_MARGIN_MS;
      if (waitMs > MAX_AUTO_WAIT_MS) {
        return {
          kind: 'needs-human',
          reason: `usage limit resets ${at.toISOString()}, which is more than 12h away — parking rather than sleeping on it`,
        };
      }
      return {
        kind: 'wait-until',
        at: new Date(at.getTime() + RESET_MARGIN_MS),
        reason: `usage limit reached; resumes at ${at.toLocaleString()}`,
      };
    }
    // A limit we could not time. Wait a conservative hour rather than guess.
    return {
      kind: 'wait-until',
      at: new Date(now.getTime() + 60 * 60 * 1000),
      reason: 'usage limit reached with no parseable reset time — retrying in 1h',
    };
  }

  // Capacity, not quota. Per-model, so another model may be free right now.
  if (RE.overloaded.test(text) || cats.includes('overloaded')) {
    return { kind: 'switch-model', reason: 'the API is at capacity for this model (529)' };
  }
  if (RE.rateLimit.test(text) || cats.includes('rate_limit')) {
    return { kind: 'retry', afterMs: 5 * 60_000, reason: 'rate limited (429) after the CLI exhausted its own retries' };
  }
  if (RE.serverError.test(text) || RE.timeout.test(text) || cats.includes('server_error')) {
    return { kind: 'retry', afterMs: 2 * 60_000, reason: 'server error or timeout' };
  }

  // The model declined. A retry produces the same refusal; a person must look.
  if (signal.stopReason === 'refusal') {
    return { kind: 'needs-human', reason: 'the model declined the task' };
  }

  if (signal.subtype === 'error_during_execution') {
    return { kind: 'retry', afterMs: 60_000, reason: 'the loop was interrupted mid-execution' };
  }

  return {
    kind: 'phase-failed',
    reason: signal.subtype ? `session ended: ${signal.subtype}` : `session exited with code ${signal.code ?? '?'}`,
  };
}

/**
 * Environment for a child session.
 *
 * `CLAUDE_CODE_RETRY_WATCHDOG=1` is documented for "CI/unattended sessions":
 * it retries 429 and 529 indefinitely and raises other transient retries to
 * ~3 hours. That is strictly better than anything this runner could do from
 * outside the process, because the CLI can resume mid-turn where we would have
 * to restart the phase. So the child absorbs the transient failures and only
 * the decisions above reach us.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    // The watchdog governs 429/529; this covers everything else it does not.
    CLAUDE_CODE_MAX_RETRIES: base.CLAUDE_CODE_MAX_RETRIES ?? '15',
  };
}

/** Models to fall back through, in order, when one is limited or at capacity. */
export const MODEL_FALLBACK = ['opus', 'sonnet', 'haiku'];

export function nextModel(current?: string): string | null {
  if (!current) return MODEL_FALLBACK[1] ?? null;
  const short = MODEL_FALLBACK.find((m) => current.includes(m));
  const index = short ? MODEL_FALLBACK.indexOf(short) : -1;
  return index >= 0 && index + 1 < MODEL_FALLBACK.length ? MODEL_FALLBACK[index + 1] : null;
}
