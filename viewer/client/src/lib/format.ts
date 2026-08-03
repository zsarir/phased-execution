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
