/**
 * Three stations and a junction: two behind you, one ahead and still amber. The
 * whole identity of the console in 32 pixels.
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
      <circle cx="5" cy="22" r="3.2" fill="var(--line-done)" />
      <circle cx="13" cy="22" r="3.2" fill="var(--line-done)" />
      <circle cx="27" cy="10" r="3.2" fill="none" stroke="var(--action)" strokeWidth="2.5" />
    </svg>
  );
}

/**
 * The count that rides a nav item. Capped, because 1,284 is not a badge.
 *
 * `cap` is lower where the badge is pinned to the corner of an icon: the number
 * is what makes it wide, and a wide badge over a 19px glyph stops being a badge
 * and becomes a label covering the thing it is counting. Nine is as much as a
 * corner can say; the exact figure is one tap away on the page itself.
 */
export function Badge({
  count,
  hot = false,
  cap = 99,
  className = '',
}: {
  count: number;
  hot?: boolean;
  cap?: number;
  className?: string;
}) {
  if (!count) return null;
  return (
    <span
      className={
        'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 py-px ' +
        'text-2xs font-semibold leading-tight ' +
        (hot ? 'bg-action/20 text-action' : 'bg-rule text-ink-muted') +
        (className ? ` ${className}` : '')
      }
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
