import { cn } from '@/lib/cn';

/**
 * Three stations and a junction: two behind you, one ahead and still amber. The
 * whole identity of the console in 32 pixels.
 *
 * The hues are the status tokens themselves (`--status-done`, and the accent —
 * which IS `--status-needs-you`), so the mark is drawn in the same vocabulary
 * as every badge on the page rather than in a private pair of colours that
 * drift from it.
 */
export function RouteGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M5 22h8l6-12h8"
        fill="none"
        stroke="var(--track)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5" cy="22" r="3.2" fill="var(--status-done)" />
      <circle cx="13" cy="22" r="3.2" fill="var(--status-done)" />
      <circle cx="27" cy="10" r="3.2" fill="none" stroke="var(--action)" strokeWidth="2.5" />
    </svg>
  );
}

/** The wordmark, at the one size each place uses it. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  if (compact) return <span className="font-display text-lg leading-none">Phase</span>;
  return (
    <span className="leading-none">
      <span className="block font-display text-xl">Phase</span>
      <span className="block text-2xs tracking-widest text-ink-faint uppercase">console</span>
    </span>
  );
}

/**
 * The count that rides a nav item. Capped, because 1,284 is not a badge.
 *
 * `cap` is lower where the badge is pinned to the corner of an icon: the number
 * is what makes it wide, and a wide badge over a 19px glyph stops being a badge
 * and becomes a label covering the thing it is counting. Nine is as much as a
 * corner can say; the exact figure is one tap away on the page itself.
 *
 * Kept here rather than reached for from `components/ui` because the shell's
 * badge is a decoration on a glyph — it has no role, no label and no border —
 * where `CountBadge` is a labelled figure a screen reader reads out. Two
 * different jobs that happen to look alike.
 */
export function NavBadge({
  count,
  hot = false,
  cap = 99,
  className,
}: {
  count: number;
  hot?: boolean;
  cap?: number;
  className?: string;
}) {
  if (!count) return null;
  return (
    <span
      className={cn(
        'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 py-px',
        'text-2xs leading-tight font-semibold tnum',
        hot ? 'bg-action/20 text-action' : 'bg-rule text-ink-muted',
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
