import { cn } from '@/lib/cn';
import { usePrefs, type Theme } from '@/lib/prefs';
import { Button, ButtonGroup, Chip } from '@/components/ui';
import { navigate } from '@/router';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { visibleNav, activeNavId } from './nav';
import { Badge, RouteGlyph } from './brand';
import { LimitsWidget } from '@/components/limits-widget';

const THEMES: readonly [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

/** The desktop navigation. Below `--bp-shell` the shell swaps this out entirely. */
export function Rail({
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
  const [prefs, setPrefs] = usePrefs();
  const current = activeNavId(head);
  const nav = visibleNav(state);

  const item = (id: string) => {
    const entry = nav.find((n) => n.id === id);
    if (!entry) return null;
    const count = entry.badge ? counts[entry.badge] : 0;
    const hot = entry.badge === 'ready' || entry.badge === 'approvals' || entry.badge === 'unread';
    return (
      <button
        key={id}
        type="button"
        aria-current={current === id ? 'page' : undefined}
        onClick={() => navigate(id)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm',
          'transition-colors duration-fast ease-transit',
          current === id ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <entry.icon size={15} className="shrink-0" aria-hidden />
          <span className="truncate">{entry.label}</span>
        </span>
        {count > 0 && <Badge count={count} hot={hot} />}
      </button>
    );
  };

  return (
    <nav
      className="flex h-dvh min-h-0 w-(--rail-width) flex-col gap-3 overflow-y-auto border-r border-rule bg-ground-deep px-3 py-4"
      aria-label="Main"
    >
      <div className="flex items-center gap-2">
        <RouteGlyph />
        <div className="leading-none">
          <div className="font-display text-xl">Phase</div>
          <div className="text-2xs tracking-widest text-ink-faint uppercase">console</div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">{nav.filter((n) => n.primary).map((n) => item(n.id))}</div>

      <div className="mt-auto flex flex-col gap-2">
        {/* The usage meters live in the chrome, not on a page: "am I about to
            hit a wall?" is a question every page has. */}
        <LimitsWidget variant="rail" />

        <div className="text-2xs tracking-widest text-ink-faint uppercase">Source</div>
        <button
          type="button"
          onClick={onPickSource}
          title={`${state?.root?.path ?? ''}\nClick to open a different directory`}
          className="rounded border border-rule bg-surface px-2 py-2 text-left hover:border-rule-strong"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm">{state?.root?.label ?? 'Choose a directory'}</span>
            <span className="shrink-0 text-2xs text-ink-faint">Change</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-2xs text-ink-faint">
            {state?.root?.path ?? 'no source open'}
          </span>
          <span className="mt-1.5 flex gap-1.5">
            <Chip mono>{counts.plans} plans</Chip>
            <Chip mono>{counts.phases} phases</Chip>
          </span>
        </button>

        {state?.allowWrites ? (
          <Chip tone="warn">writes enabled</Chip>
        ) : (
          <Chip title="Start with --allow-writes to enable scaffolding, QA records and locks">read-only</Chip>
        )}

        <ButtonGroup aria-label="Theme" className="w-full [&>button]:flex-1">
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

        <div className="flex flex-col gap-0.5">{nav.filter((n) => !n.primary).map((n) => item(n.id))}</div>
      </div>
    </nav>
  );
}
