/**
 * The small formatters, in one place.
 *
 * Ported from `web/components/ui.js`, where they sat among the components and
 * were therefore unreachable from anything that did not want a rendering
 * runtime — including a test.
 */

import type { EtaBasis, EtaEstimate } from './api';

/** `310000` → `310K`. A weight is always tokens, and always rounded. */
export function weight(tokens: number | undefined): string {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** What is left of a lock's lease, at the precision a lease is worth. */
export function countdown(untilMs: number | undefined): string {
  if (!untilMs) return '';
  const delta = untilMs - Date.now();
  if (delta <= 0) return 'expired';
  const minutes = Math.round(delta / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h left` : `${minutes}m left`;
}

/** `1 phase` / `3 phases` — the plural nobody wants to write inline twice. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `03` — a phase number as a departures board writes it. */
export const pad2 = (n: number | string): string => String(n).padStart(2, '0');

/* ---------------- clocks ----------------
 * Three of these, deliberately, because they answer different questions. A
 * running phase wants a stopwatch (`elapsed`), a finished one wants a rounded
 * wall-clock (`duration`), and a tool call runs from milliseconds to minutes so
 * it needs its own (`toolTime`). One format cannot serve all three without
 * being wrong for two. */

/** `0:07` / `12:03` / `1:04:11` — a stopwatch, for something still running. */
export function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/** Wall-clock at the precision someone reading a phase table cares about. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A tool call: `840ms` / `2.4s` / `6m`. */
export function toolTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * `14:07:52` — a wall clock for a log line, in the reader's own zone.
 *
 * Deliberately not `relativeTime`: "4 minutes ago" is the right register for a
 * card that names one moment, and the wrong one for a column of five hundred
 * lines, where what a reader wants is to line two of them up and see the gap.
 */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const UNITS: [number, string][] = [
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
  [604_800_000, 'week'],
  [2_629_800_000, 'month'],
  [31_557_600_000, 'year'],
];

/** `just now` / `4 minutes ago`, falling back to a date once that stops helping. */
export function relativeTime(ms: number | undefined): string {
  if (!ms || Number.isNaN(ms)) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  for (let i = 0; i < UNITS.length; i++) {
    const [size, name] = UNITS[i];
    const next = UNITS[i + 1]?.[0] ?? Infinity;
    if (delta < next) {
      const value = Math.round(delta / size);
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** `$1.20`. Absent and zero are different things — only the caller knows which. */
export const money = (usd: number | null | undefined): string => `$${(usd ?? 0).toFixed(2)}`;

/* ---------------- estimates ----------------
 * An estimate is rendered in exactly one place, here, because the thing most
 * easily got wrong about one is not the arithmetic — the server did that — but
 * how much of a claim it sounds like. Five surfaces printing `eta.label` would
 * be five chances to drop the hedge, and a hedge dropped is a guess presented as
 * a measurement. */

/**
 * What each basis is worth, in the words a reader needs after the number.
 *
 * `plan` still says "(estimate)" rather than nothing: even the strongest reading
 * here is a model's throughput on work nobody has looked at yet.
 */
const BASIS_SUFFIX: Record<EtaBasis, string> = {
  plan: '(estimate)',
  portfolio: '(from other plans)',
  heuristic: '(rough guess)',
};

/** Longer than the bucket it came from deserves would be a lie about precision. */
function coarse(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const days = ms / 86_400_000;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} d`;
}

/**
 * `~40 min–1.5 h (estimate)` — a range and how much to believe it.
 *
 * The server has already snapped both ends to a bucket a person would say out
 * loud, so this only formats and hedges. A collapsed range (both ends in the
 * same bucket) prints once rather than as `~5 min–5 min`.
 */
export function etaLabel(lowMs: number, highMs: number, basis: EtaBasis): string {
  const range = lowMs === highMs ? `~${coarse(highMs)}` : `~${coarse(lowMs)}–${coarse(highMs)}`;
  return `${range} ${BASIS_SUFFIX[basis] ?? BASIS_SUFFIX.heuristic}`;
}

/** `~40 min` — one phase's own estimate, with no hedge and no "left". */
export function etaPoint(ms: number): string {
  return `~${coarse(ms)}`;
}

/** Where the number came from, in a sentence, for the `title` of any of them. */
export function etaTitle(eta: EtaEstimate): string {
  const evidence =
    eta.basis === 'plan'
      ? `${plural(eta.samples, 'finished phase')} of this plan`
      : eta.basis === 'portfolio'
        ? `${plural(eta.samples, 'finished phase')} across other plans — this one has none yet`
        : 'no finished phase anywhere yet, so this is the size tags alone';
  return (
    `From ${evidence}, against ${weight(eta.remainingWeight)} of remaining weight. ` +
    'Weight-normalised, recency-weighted, and deliberately coarse.'
  );
}
