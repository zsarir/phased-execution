import { useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useBottomBar } from '@/lib/viewport';
import { useNavigate } from '@/app/router';
import { destinationFor } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { tabItems } from './nav';
import { NavBadge } from './brand';

/**
 * The tab bar is a **grid row of the shell**, never `position: fixed`.
 *
 * A fixed bar is positioned against the visual viewport, and on iOS the URL
 * chrome grows and shrinks as you scroll — so a fixed bar drifts under it,
 * re-anchors a beat late, and on a rubber-band scroll floats in the middle of
 * the page. As a grid row of an `--app-height` shell it is simply the last row,
 * and the row above it is the only thing that scrolls.
 */
export function TabBar({
  state,
  counts,
  head,
  moreOpen,
  onMore,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const navigate = useNavigate();
  const current = destinationFor(head);
  // A bottom bar: toasts stack above it rather than over it.
  const bar = useRef<HTMLElement>(null);
  useBottomBar(bar);

  return (
    <nav
      ref={bar}
      aria-label="Main"
      className="grid auto-cols-fr grid-flow-col border-t border-rule bg-ground-deep pb-safe px-safe"
    >
      {tabItems(state).map((item) => {
        const active = current === item.id && !moreOpen;
        const count = item.badge ? counts[item.badge] : 0;
        const hot = item.badge === 'needsYou' || item.badge === 'approvals';
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(item.id)}
            className={cn(
              'flex min-h-(--tap-min) flex-col items-center justify-center gap-0.5 px-1 py-1.5',
              active ? 'text-action' : 'text-ink-muted',
            )}
          >
            {/* A tab is ~78px wide with a 19px glyph in the middle of it, so the
                corner badge stays — but ringed in the bar's own ground so the
                glyph reads out from under it, capped at 9+ so it stays a circle
                rather than growing into its neighbour, and deaf to pointers so
                it can never eat the tap meant for the tab. */}
            <span className="relative">
              <item.icon size={19} aria-hidden />
              {count > 0 && (
                <span className="pointer-events-none absolute -top-2 -right-3">
                  <NavBadge count={count} hot={hot} cap={9} className="ring-2 ring-ground-deep" />
                </span>
              )}
            </span>
            <span className="text-2xs leading-none">{item.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-current={moreOpen ? 'page' : undefined}
        onClick={onMore}
        className={cn(
          'flex min-h-(--tap-min) flex-col items-center justify-center gap-0.5 px-1 py-1.5',
          moreOpen ? 'text-action' : 'text-ink-muted',
        )}
      >
        <MoreHorizontal size={19} aria-hidden />
        <span className="text-2xs leading-none">More</span>
      </button>
    </nav>
  );
}
