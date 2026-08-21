import { useRef } from 'react';
import { Bell, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useBottomBar } from '@/lib/viewport';
import { usePrefs, type Theme } from '@/lib/prefs';
import { Button, ButtonGroup, Chip, Sheet, SheetContent } from '@/components/ui';
import { navigate } from '@/router';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { TAB_ITEMS, activeNavId, visibleNav } from './nav';
import { Badge, RouteGlyph } from './brand';
import { LimitsWidget } from '@/components/limits-widget';

const THEMES: readonly [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

export function TopBar({
  state,
  counts,
  head,
  onPickSource,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
  onPickSource: () => void;
}) {
  const current = activeNavId(head);
  return (
    <header className="flex items-center gap-2 border-b border-rule bg-ground-deep px-2 pt-safe px-safe">
      <button
        type="button"
        onClick={() => navigate('dashboard')}
        aria-label="Phase Console — dashboard"
        className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-1"
      >
        <RouteGlyph size={22} />
        <span className="font-display text-lg">Phase</span>
      </button>

      <button
        type="button"
        onClick={onPickSource}
        className="min-h-(--tap-min) min-w-0 flex-1 truncate rounded px-2 text-left text-sm text-ink-muted"
      >
        {state?.root?.label ?? 'Choose a directory'}
      </button>

      {/* The same meters the rail shows, at phone size: a gauge and the 5-hour
          percent. The directory button beside it already truncates, so the row
          has the room. */}
      <LimitsWidget variant="phone" />

      {/* The count sits BESIDE the bell, not on it.
          Pinned to the corner it covered the glyph at every count — the badge
          is 20px wide and the bell is 18 — and at three digits it grew left
          across the whole icon and right off the edge of the screen. A row that
          widens with its number cannot overlap anything, and the header has the
          room: the directory button beside it already truncates. */}
      <button
        type="button"
        onClick={() => navigate('notifications')}
        aria-current={current === 'notifications' ? 'page' : undefined}
        aria-label={counts.unread ? `Notifications, ${counts.unread} unread` : 'Notifications'}
        className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-2"
      >
        <Bell size={18} className={current === 'notifications' ? 'text-ink' : 'text-ink-muted'} />
        <Badge count={counts.unread} hot />
      </button>
    </header>
  );
}

/**
 * The tab bar is a **grid row of the shell**, never `position: fixed`.
 *
 * A fixed bar is positioned against the visual viewport, and on iOS the URL
 * chrome grows and shrinks as you scroll — so a fixed bar drifts under it,
 * re-anchors a beat late, and on a rubber-band scroll floats in the middle of
 * the page. As a grid row of a `h-dvh` shell it is simply the last row, and the
 * row above it is the only thing that scrolls.
 */
export function TabBar({
  counts,
  head,
  moreOpen,
  onMore,
}: {
  counts: ShellCounts;
  head: string | undefined;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const current = activeNavId(head);
  // A bottom bar: toasts stack above it rather than over it.
  const bar = useRef<HTMLElement>(null);
  useBottomBar(bar);

  return (
    <nav
      ref={bar}
      aria-label="Main"
      className="grid grid-flow-col auto-cols-fr border-t border-rule bg-ground-deep pb-safe px-safe"
    >
      {TAB_ITEMS.map((item) => {
        const active = current === item.id && !moreOpen;
        const count = item.badge ? counts[item.badge] : 0;
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
            {/* A tab is 78px wide with a 19px glyph in the middle of it, so the
                corner badge stays — but ringed in the bar's own ground so the
                glyph reads out from under it, capped at 9+ so it stays a circle
                rather than growing into its neighbour, and deaf to pointers so
                it can never eat the tap meant for the tab. */}
            <span className="relative">
              <item.icon size={19} aria-hidden />
              {count > 0 && (
                <span className="pointer-events-none absolute -right-3 -top-2">
                  <Badge count={count} hot cap={9} className="ring-2 ring-ground-deep" />
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

/** Everything the four tabs do not show — so nothing is unreachable on a phone. */
export function MoreSheet({
  open,
  onOpenChange,
  state,
  counts,
  head,
  onPickSource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
  onPickSource: () => void;
}) {
  const [prefs, setPrefs] = usePrefs();
  const current = activeNavId(head);
  // Everything the four tabs do not show — minus anything this server cannot
  // actually do. The sheet is the phone's only route to Terminal, so it is the
  // one place the capability gate has to be applied.
  const sheetItems = visibleNav(state).filter((item) => !item.tab);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="More">
        <div className="flex flex-col gap-1">
          {sheetItems.map((item) => {
            const count = item.badge ? counts[item.badge] : 0;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={current === item.id ? 'page' : undefined}
                onClick={() => {
                  navigate(item.id);
                  onOpenChange(false);
                }}
                className={cn(
                  'flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-left',
                  current === item.id ? 'bg-surface-raised' : 'hover:bg-surface-raised',
                )}
              >
                <item.icon size={17} className="shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <strong className="truncate font-medium">{item.label}</strong>
                    {count > 0 && <Badge count={count} hot />}
                  </span>
                  <span className="block truncate text-2xs text-ink-faint">{item.note}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-col gap-3 border-t border-rule pt-3">
          <LimitsWidget variant="sheet" />

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs tracking-widest text-ink-faint uppercase">Source</span>
            <Button
              size="sm"
              className="min-w-0 max-w-[60%]"
              onClick={() => {
                onPickSource();
                onOpenChange(false);
              }}
            >
              <span className="truncate">{state?.root?.label ?? 'Choose a directory'}</span>
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs tracking-widest text-ink-faint uppercase">Theme</span>
            <ButtonGroup aria-label="Theme">
              {THEMES.map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant="ghost"
                  aria-pressed={prefs.theme === value}
                  onClick={() => setPrefs({ theme: value })}
                >
                  {label}
                </Button>
              ))}
            </ButtonGroup>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs tracking-widest text-ink-faint uppercase">Writes</span>
            {state?.allowWrites ? (
              <Chip tone="warn">enabled</Chip>
            ) : (
              <Chip title="Start with --allow-writes to enable scaffolding, QA records and locks">
                read-only
              </Chip>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
