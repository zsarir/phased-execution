/**
 * What this console has spent — the day's money, each run against its budget,
 * and a week of history. Pure: files in, numbers out, and the clock is an
 * argument.
 *
 * Read by `server/service.ts` (`spendSummary`, behind `GET /api/spend`, whose
 * answer the client's `client/src/lib/api/spend.ts` `SpendView` already names
 * field for field) and by the two callers of `runner/ladder.ts` `nextRung` —
 * `server/runner/runner.ts` (`Runner.climb`) and `server/service.ts`
 * (`maybeAutoRecover`) — which need `rungsToday` for the `dayHistory` the
 * per-day cap counts. Pinned by `test/spend.test.ts`.
 *
 * It takes a STRUCTURAL slice of a run file rather than importing the runner's
 * own `RunState`, the same way `analysis/stats.ts` takes `RunView`: this module
 * reads records that have already landed on disk, never the loop that is
 * writing them. Nothing here opens a file, nothing here reads a clock — a
 * summary you can only produce by being the live console is a summary nobody
 * can test.
 *
 * ## Days are LOCAL days here, and that is a deliberate break
 *
 * Every other day key in this tree is `toISOString().slice(0, 10)` — a UTC day
 * (`analysis/stats.ts`, `client/src/lib/format.ts`, `client/src/components/
 * charts.tsx`). That is fine for a heat-map of activity and wrong for money:
 * "today's ladder budget is spent" is a sentence about the operator's day, and
 * an operator seven hours west of UTC watches their cap reset in the middle of
 * the afternoon and their evening's spend land on tomorrow. So `dayKey` here
 * formats in a real time zone (the host's, unless one is named) and everything
 * downstream — `rungsToday`, the seven buckets, the cap comparison — agrees
 * with it. A client rendering `series[].day` must print the key it was GIVEN
 * rather than re-deriving one from a timestamp, or the chart and the header
 * will disagree about which day it is.
 *
 * ## What is real, and what is honestly zero
 *
 * `runs[].spentUsd` / `budgetUsd` are exact: the runner adds every session's
 * `total_cost_usd` to `RunState.spentUsd` the moment the spawn resolves, and
 * `runBudgetUsd` already reflects the one auto-raise.
 *
 * `settledUsd` is an approximation with a name: it sums `PhaseRecord.costUsd`
 * on the day the phase ENDED. That figure is cumulative over every attempt and
 * every session kind on the phase, so a phase begun Monday and finished
 * Wednesday books all of its money on Wednesday, and a phase retried on Friday
 * re-books its whole history on Friday (`resetForRetry` clears `endedAt` and
 * deliberately keeps `costUsd`). The exact alternative is replaying each run's
 * journal by entry `time`, which is one `Journal.read()` per run — the very
 * per-plan read `etaPool` grew a cache to avoid. A live phase contributes
 * nothing until it lands, which is why the contract's field is `settledUsd`
 * and not `spentUsd`.
 *
 * `ladderUsd` will read $0.00 until the ladder learns to price its own rungs.
 * `accountRung` writes a rung with no cost, `Runner.climb` never settles the
 * rungs it climbs at all, and the service settles with `undefined` at six of
 * its seven call sites. The one that passes money passes the phase record's
 * CUMULATIVE cost, which is a different quantity and would over-count if it
 * were summed. So the number this module returns is the true sum of what is
 * recorded, and what is recorded is nothing. That is the honest answer and it
 * is reported as such — a fabricated ladder cost would silently arm the one
 * cap in the system that has never refused anything.
 *
 * And a day figure built from run files is RUNNER spend only. QA sessions, the
 * plan wizard, the agent-vehicle rungs and operator terminals all run through
 * `server/agent.ts` / `server/terminal.ts` as ptys, which never see a
 * `total_cost_usd`. Money the console spends that way is recorded nowhere and
 * therefore appears nowhere here.
 */

/** A `YYYY-MM-DD` local-day key, as produced by `dayKey`. */
export type DayKey = string;

/**
 * One rung as it sits in a run file (`runner/state.ts` `RungRecord`), spelled
 * out structurally so this module imports nothing from the loop. The shape is
 * an exact mirror, so what `rungsToday` returns is assignable straight into
 * `nextRung`'s `dayHistory`.
 */
export type RungView = {
  situation: string;
  rung: string;
  at: string;
  params?: Record<string, string | number | boolean>;
  costUsd?: number;
  outcome?: 'running' | 'fixed' | 'no-defect' | 'superseded' | 'failed';
  note?: string;
};

/** The slice of a run file this module reads. Everything optional: old run files predate most of it. */
export type SpendRunView = {
  id: string;
  slug: string;
  spentUsd?: number;
  runBudgetUsd?: number | null;
  updatedAt?: string;
  phases?: Record<string, { costUsd?: number; endedAt?: string } | undefined>;
  recoveries?: Record<string, { rungs?: readonly RungView[] } | undefined>;
};

export type SpendFacts = {
  /** Every run under this instance the caller is willing to account for — `listRuns` across every slug. */
  runs: readonly SpendRunView[];
  /**
   * `ladderCaps(prefs).perDayUsd`. Absent or unusable means no cap is set and
   * the view says `null`. Zero is NOT null: a per-day cap of zero is what an
   * operator who wants the ladder to spend nothing sets, and `nextRung` refuses
   * at `>= 0` accordingly, so it is passed through as the number it is.
   */
  capUsd?: number | null;
  /** IANA zone for the day boundary. Absent = this host's zone. */
  tz?: string;
  /** How many buckets the series carries, today last. Default 7. */
  days?: number;
};

/** Exactly `client/src/lib/api/spend.ts` `SpendView`. Do not add a field here without changing that file. */
export type SpendView = {
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null };
  runs: { runId: string; slug: string; spentUsd: number; budgetUsd: number | null }[];
  series: { day: DayKey; settledUsd: number; ladderUsd: number }[];
};

const DAY = 86_400_000;

/** The default width of the history: a week, because a week is what a cap is felt over. */
export const SERIES_DAYS = 7;

/**
 * Money, the way `ladder.ts` `usd` counts it: a missing or unreadable figure is
 * zero, never a refusal. A cap must never trip on a number nobody wrote.
 */
const money = (value: unknown): number =>
  (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Cents. Sub-cent float dust is not a spend figure, and `$0.30000000000000004` is not a number to show anyone. */
const cents = (value: number): number => Math.round(value * 100) / 100;

const millis = (value: Date | number | string): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The local-midnight day key — `2026-08-22` — for an instant, in `tz` or in
 * this host's own zone.
 *
 * `Intl` rather than arithmetic because the offset is not a constant: an hour
 * that does not exist and an hour that happens twice are both real days on the
 * calendar, and only the zone database knows where they are. An instant that
 * cannot be read at all returns the empty key, which matches no bucket and
 * sums into nothing — this module never throws at a bad timestamp in a file it
 * did not write.
 */
export function dayKey(date: Date | number | string, tz?: string): DayKey {
  const ms = millis(date);
  if (ms === null) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(tz ? { timeZone: tz } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) return '';
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/**
 * `days` day keys ending at `key`, oldest first.
 *
 * Calendar arithmetic on the key itself, anchored at noon UTC — the trick
 * `stats.ts` `weeklyBuckets` uses. Stepping by 86.4M milliseconds through a
 * zone would skip or repeat a day twice a year; stepping through midday of a
 * date has no such hour to fall into, and the zone has already done its work
 * by the time a key exists.
 */
export function dayKeysEndingAt(key: DayKey, days: number): DayKey[] {
  const anchor = Date.parse(`${key}T12:00:00Z`);
  const width = Number.isFinite(days) && days > 0 ? Math.floor(days) : SERIES_DAYS;
  if (!Number.isFinite(anchor)) return [];
  const keys: DayKey[] = [];
  for (let i = width - 1; i >= 0; i--) {
    keys.push(new Date(anchor - i * DAY).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Every rung this console climbed today, across every run — the `dayHistory`
 * the per-day cap counts, which neither `Runner.climb` nor `maybeAutoRecover`
 * passes today, which is why `ladderPerDayUsd` has never refused anything.
 *
 * Oldest first, and the records are handed back UNTOUCHED: `nextRung` does its
 * own exact summing, so nothing here rounds a number the cap will compare.
 * Rungs with no cost are still returned — the per-day cap is dollars, but a
 * reader counting attempts wants the whole day.
 */
export function rungsToday(
  runs: readonly SpendRunView[],
  now: Date | number,
  tz?: string,
): RungView[] {
  // One clock read for the whole pass. A key computed per record is a key that
  // can change halfway down a long list, at exactly the moment it matters.
  const today = dayKey(now, tz);
  if (!today) return [];
  const rungs: RungView[] = [];
  for (const run of runs ?? []) {
    for (const slot of Object.values(run?.recoveries ?? {})) {
      for (const rung of slot?.rungs ?? []) {
        if (!rung || typeof rung.at !== 'string') continue;
        if (dayKey(rung.at, tz) !== today) continue;
        rungs.push(rung);
      }
    }
  }
  return rungs.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Has today's ladder spend reached the cap?
 *
 * Spelled here so a caller asks the question the way `nextRung` answers it —
 * `>=`, not `>`, and no cap at all when `capUsd` is null. A cap of exactly zero
 * is reached the instant it is set, which is what setting it to zero means.
 */
export function overDayCap(today: SpendView['today']): boolean {
  return today.capUsd !== null && today.ladderUsd >= today.capUsd;
}

/** Sum a run's phase costs onto the day each phase ended. */
function settledByDay(runs: readonly SpendRunView[], tz: string | undefined, into: Map<DayKey, number>): void {
  for (const run of runs ?? []) {
    for (const record of Object.values(run?.phases ?? {})) {
      // No end time is no day: a phase still in flight has spent money that
      // belongs to no date yet, and guessing one is how a live run's cost
      // appears twice.
      if (!record?.endedAt) continue;
      const cost = money(record.costUsd);
      if (!cost) continue;
      const key = dayKey(record.endedAt, tz);
      if (!key) continue;
      into.set(key, (into.get(key) ?? 0) + cost);
    }
  }
}

/**
 * Today's money against the day cap, each run against its budget, and a week
 * of history — the whole `SpendView`, in one pass over the run files.
 *
 * `runs` carries a run when it has spent something or was touched today; a
 * finished run that cost nothing is not a fact about spending, and a console
 * that has driven two hundred runs should not answer with two hundred rows.
 * Ordered by what it cost, descending, because the question this table is
 * opened to answer is which run is eating the budget.
 */
export function spendSummary(facts: SpendFacts, now: Date | number): SpendView {
  const tz = facts?.tz;
  const runs = facts?.runs ?? [];
  const today = dayKey(now, tz);
  const keys = dayKeysEndingAt(today, facts?.days ?? SERIES_DAYS);

  const settled = new Map<DayKey, number>();
  settledByDay(runs, tz, settled);

  const ladder = new Map<DayKey, number>();
  for (const run of runs) {
    for (const slot of Object.values(run?.recoveries ?? {})) {
      for (const rung of slot?.rungs ?? []) {
        const cost = money(rung?.costUsd);
        if (!cost) continue;
        const key = dayKey(rung.at, tz);
        if (!key) continue;
        ladder.set(key, (ladder.get(key) ?? 0) + cost);
      }
    }
  }

  const capUsd =
    typeof facts?.capUsd === 'number' && Number.isFinite(facts.capUsd) && facts.capUsd >= 0
      ? facts.capUsd
      : null;

  const rows = runs
    .filter((run) => run && typeof run.id === 'string')
    .filter((run) => money(run.spentUsd) > 0 || (run.updatedAt ? dayKey(run.updatedAt, tz) === today : false))
    .map((run) => ({
      runId: run.id,
      slug: typeof run.slug === 'string' ? run.slug : '',
      spentUsd: cents(money(run.spentUsd)),
      budgetUsd:
        typeof run.runBudgetUsd === 'number' && Number.isFinite(run.runBudgetUsd) ? run.runBudgetUsd : null,
    }))
    .sort((a, b) => b.spentUsd - a.spentUsd || a.runId.localeCompare(b.runId));

  return {
    today: {
      settledUsd: cents(settled.get(today) ?? 0),
      ladderUsd: cents(ladder.get(today) ?? 0),
      capUsd,
    },
    runs: rows,
    // Every day present, empty ones as zeros: a gap in a bar chart reads as
    // missing data, and "nothing was spent on Sunday" is data.
    series: keys.map((day) => ({
      day,
      settledUsd: cents(settled.get(day) ?? 0),
      ladderUsd: cents(ladder.get(day) ?? 0),
    })),
  };
}
