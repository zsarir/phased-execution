import { Bell, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePrefs, type Theme } from '@/lib/prefs';
import { Button, ButtonGroup, KbdChord, Tooltip } from '@/components/ui';
import { LimitsWidget } from '@/components/limits-widget';
import { ProjectSwitcher } from '@/app/switcher/project-switcher';
import { bellHref, paletteHref, type Route } from '@/app/routes';
import { useNavigate } from '@/app/router';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { NavBadge, RouteGlyph, Wordmark } from './brand';

const THEMES: readonly [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

/**
 * The header: the four things that are true on every page.
 *
 * *Which project*, *what it is costing*, *what the console has said*, and *the
 * way to anything at all*. Everything else on screen belongs to a destination;
 * these four do not, which is why they are chrome rather than a card on Now.
 *
 * The same component serves both layouts. On a phone it carries the wordmark
 * (there is no rail to carry it) and drops the theme group into the More sheet;
 * on a desktop the rail has the mark and the header has the room. Two
 * components would be two places to forget the bell.
 *
 * The spend figure lands here in Phase 4, beside the usage meter — `/api/spend`
 * does not exist yet, and a header that showed `$0.00` would be lying rather
 * than waiting.
 */
export function Header({
  state,
  counts,
  route,
  phone,
  slotRef,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  phone: boolean;
  /** Where a page's own header actions are portalled. See `layout.tsx`. */
  slotRef: (node: HTMLDivElement | null) => void;
}) {
  const navigate = useNavigate();
  const [prefs, setPrefs] = usePrefs();

  return (
    <header
      className={cn(
        'flex items-center gap-2 border-b border-rule bg-ground-deep px-2 px-safe',
        phone ? 'pt-safe' : 'h-(--header-height) md:px-4',
      )}
    >
      {phone && (
        <a
          href="#/now"
          aria-label="Phase Console — Now"
          className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-1"
        >
          <RouteGlyph size={22} />
          <Wordmark compact />
        </a>
      )}

      <ProjectSwitcher state={state} counts={counts} phone={phone} />

      {/* A page's own actions, portalled in. Between the switcher and the
          utilities so they read as belonging to the page, not to the console. */}
      <div ref={slotRef} className="flex min-w-0 shrink items-center gap-2 empty:hidden" />

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* The meters live in the chrome, not on a page: "am I about to hit a
            wall?" is a question every page has. */}
        <LimitsWidget variant={phone ? 'phone' : 'header'} />

        <PaletteButton phone={phone} route={route} onOpen={(href) => navigate(href)} />

        {/* The count sits BESIDE the bell, not on it. Pinned to the corner it
            covered the glyph at every count — the badge is 20px wide and the
            bell is 18 — and at three digits it grew left across the whole icon
            and right off the edge of the screen. A row that widens with its
            number cannot overlap anything, and the header has the room: the
            switcher beside it already truncates. */}
        <button
          type="button"
          onClick={() => navigate(bellHref(route))}
          aria-label={counts.unread ? `Announcements, ${counts.unread} unread` : 'Announcements'}
          className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-2 text-ink-muted hover:text-ink"
        >
          <Bell size={18} aria-hidden />
          <NavBadge count={counts.unread} hot />
        </button>

        {!phone && (
          <ButtonGroup aria-label="Theme" className="ml-1">
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
        )}
      </div>
    </header>
  );
}

/**
 * The way to anything.
 *
 * A wide affordance on a desktop, because a palette nobody knows about is a
 * palette nobody opens — the chord is printed on it. On a phone it is a
 * magnifier: there is no chord to print, and the row has no width to spare.
 */
function PaletteButton({
  phone,
  route,
  onOpen,
}: {
  phone: boolean;
  route: Route;
  onOpen: (href: string) => void;
}) {
  const open = () => onOpen(paletteHref('', route));

  if (phone) {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Search and commands"
        className="flex min-h-(--tap-min) shrink-0 items-center rounded px-2 text-ink-muted hover:text-ink"
      >
        <Search size={18} aria-hidden />
      </button>
    );
  }

  return (
    <Tooltip content="Go anywhere, find anything, run a verb">
      <button
        type="button"
        onClick={open}
        className={
          'flex h-8 w-56 items-center gap-2 rounded-md border border-rule bg-surface px-2 ' +
          'text-sm text-ink-faint transition-colors duration-fast ease-transit hover:border-rule-strong hover:text-ink-muted'
        }
      >
        <Search size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Search or jump to…</span>
        <KbdChord keys={['⌘', 'K']} />
      </button>
    </Tooltip>
  );
}
