import { LifeBuoy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePrefs, type Theme } from '@/lib/prefs';
import { Button, ButtonGroup, Chip, Sheet, SheetContent } from '@/components/ui';
import { LimitsWidget } from '@/components/limits-widget';
import { useNavigate } from '@/app/router';
import { destinationFor, helpHref, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { sheetItems } from './nav';
import { NavBadge } from './brand';

const THEMES: readonly [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

/**
 * Everything the four tabs do not show — so nothing is unreachable on a phone.
 *
 * The 2.x rail put Guide, Settings and the theme switcher in a footer the phone
 * layout set to `display: none`; nothing announced it, the links simply were not
 * there. This sheet is the phone's route to the last two destinations and to
 * Help, and the gate on Sessions is applied to the TAB BAR rather than here, so
 * a console without either flag loses a tab and gains nothing hidden.
 */
export function MoreSheet({
  open,
  onOpenChange,
  state,
  counts,
  route,
  head,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  head: string | undefined;
}) {
  const navigate = useNavigate();
  const [prefs, setPrefs] = usePrefs();
  const current = destinationFor(head);

  const go = (target: string) => {
    navigate(target);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="More">
        <div className="flex flex-col gap-1">
          {sheetItems(state).map((item) => {
            const count = item.badge ? counts[item.badge] : 0;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={current === item.id ? 'page' : undefined}
                onClick={() => go(item.id)}
                className={cn(
                  'flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-left',
                  current === item.id ? 'bg-surface-raised' : 'hover:bg-surface-raised',
                )}
              >
                <item.icon size={17} className="shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <strong className="truncate font-medium">{item.label}</strong>
                    {count > 0 && <NavBadge count={count} hot />}
                  </span>
                  <span className="block truncate text-2xs text-ink-faint">{item.note}</span>
                </span>
              </button>
            );
          })}

          {/* Help is an overlay, not a destination — but it is the third thing a
              phone reaches for, and the sheet is the only place it can live. */}
          <button
            type="button"
            onClick={() => go(helpHref(undefined, undefined, route))}
            className="flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-left hover:bg-surface-raised"
          >
            <LifeBuoy size={17} className="shrink-0 text-ink-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <strong className="block truncate font-medium">Help</strong>
              <span className="block truncate text-2xs text-ink-faint">
                The guide, over whatever page you are on
              </span>
            </span>
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-3 border-t border-rule pt-3">
          <LimitsWidget variant="sheet" />

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
