import { cn } from '@/lib/cn';
import { Chip } from '@/components/ui';
import { useNavigate } from '@/app/router';
import { destinationFor } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { visibleNav } from './nav';
import { NavBadge, RouteGlyph, Wordmark } from './brand';

/**
 * The desktop navigation: six destinations and nothing else.
 *
 * Everything the 2.x rail carried below its list — the usage meters, the source
 * button, the theme group, a second block of "secondary" links — has moved to
 * the header, which is where a fact that is true on every page belongs. What is
 * left is a list you can read in one glance, which is the only thing a rail is
 * better at than a header.
 *
 * Below `--bp-shell` the shell swaps this out for the tab bar entirely.
 */
export function Rail({
  state,
  counts,
  head,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
}) {
  const navigate = useNavigate();
  const current = destinationFor(head);
  const nav = visibleNav(state);

  return (
    <nav
      className="flex h-(--app-height) min-h-0 w-(--rail-width) flex-col gap-3 overflow-y-auto border-r border-rule bg-ground-deep px-3 py-4"
      aria-label="Main"
    >
      <a href="#/now" className="flex items-center gap-2 rounded px-1" aria-label="Phase Console — Now">
        <RouteGlyph />
        <Wordmark />
      </a>

      <div className="flex flex-col gap-0.5">
        {nav.map((item) => {
          const count = item.badge ? counts[item.badge] : 0;
          // Only the accent count is "hot". A live session or a plan census is
          // information; something waiting on a person is a call to action, and
          // if everything is amber then nothing is.
          const hot = item.badge === 'needsYou' || item.badge === 'approvals';
          const active = current === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(item.id)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm',
                'transition-colors duration-fast ease-transit',
                active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <item.icon size={15} className="shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </span>
              {count > 0 && <NavBadge count={count} hot={hot} />}
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Chip mono>{counts.plans} plans</Chip>
          <Chip mono>{counts.phases} phases</Chip>
        </div>
        {state?.allowWrites ? (
          <Chip tone="warn">writes enabled</Chip>
        ) : (
          <Chip title="Start with --allow-writes to enable scaffolding, QA records and locks">read-only</Chip>
        )}
      </div>
    </nav>
  );
}
