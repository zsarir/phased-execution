/**
 * The small formatters, in one place.
 *
 * Ported from `web/components/ui.js`, where they sat among the components and
 * were therefore unreachable from anything that did not want a rendering
 * runtime — including a test.
 */

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
