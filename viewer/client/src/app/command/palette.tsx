import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  KbdChord,
} from '@/components/ui';
import { usePlans, useRuns, type ShellCounts } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { useNavigate } from '@/app/router';
import { OVERLAY_KEYS, closeOverlaysHref, paletteHref, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import { byGroup, paletteActions, type CommandContext } from './actions';
import { SearchResults } from './search-results';

/** How long to sit still before asking the server. Long enough not to search every letter. */
const DEBOUNCE_MS = 180;

/**
 * The ⌘K palette — go anywhere, find anything, do the verb.
 *
 * It replaces two 2.x surfaces at once: the Search *page* (a whole destination
 * for something you always want from somewhere else) and the keyboard-shortcut
 * card in Settings, which listed seven single-letter jumps that had to be
 * memorised from a page you had to remember to visit.
 *
 * **Open state is the URL** (`?k=`), like the help sheet and the bell drawer.
 * That is what lets `#/search?q=cart` become `#/now?k=cart` with no redirect
 * table of its own, and what makes ⌘K on the Runs page keep the Runs page
 * underneath. What is *typed* afterwards is deliberately NOT written back: a
 * palette is transient, and a history entry per keystroke buys nothing anyone
 * has ever wanted.
 */
export function Palette({
  route,
  state,
  counts,
}: {
  route: Route;
  state: ConsoleState | undefined;
  counts: ShellCounts;
}) {
  const navigate = useNavigate();
  const [, setPrefs] = usePrefs();
  const initial = route.query[OVERLAY_KEYS.palette];
  const open = initial != null;

  const [value, setValue] = useState(initial ?? '');
  const [debounced, setDebounced] = useState(initial ?? '');

  // A deep link (or a second ⌘K) re-seeds the box; closing clears it, so the
  // next open is not haunted by the last one's term.
  useEffect(() => {
    setValue(initial ?? '');
    setDebounced(initial ?? '');
  }, [initial]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  const close = useCallback(() => navigate(closeOverlaysHref(route)), [navigate, route]);

  // ⌘K anywhere; `/` only when nothing is being typed into. Both are captured
  // here rather than in the shell so the palette owns its own way in — the 2.x
  // shortcut table lived in `App.tsx` and drifted from the card that documented
  // it within one release.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;
      const chord = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (!chord && (event.key !== '/' || typing || event.metaKey || event.ctrlKey || event.altKey)) {
        return;
      }
      event.preventDefault();
      // A second ⌘K while it is up closes it, the way every palette does.
      navigate(open ? closeOverlaysHref(route) : paletteHref('', route));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, open, route]);

  const { data: plans } = usePlans(Boolean(state?.root?.ok));
  const { data: runs } = useRuns(Boolean(state?.autopilot));

  const context = useMemo<CommandContext>(
    () => ({
      state,
      route,
      plans,
      runs,
      // Going anywhere closes it by construction: the palette is open because
      // THIS route carries `?k=`, and the href being navigated to does not.
      // Nothing has to remember to close it, which is the point of putting the
      // open state in the URL in the first place.
      go: (path) => navigate(path),
      setTheme: (theme) => {
        setPrefs({ theme });
        close();
      },
    }),
    [state, route, plans, runs, navigate, setPrefs, close],
  );

  const actions = useMemo(() => paletteActions(context), [context]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Search and commands"
      description="Type to jump to a destination, a plan, a phase or a run — or to search every plan and handoff."
      label="Search and commands"
    >
      <CommandInput placeholder="Go to, find, or do…" value={value} onValueChange={setValue} autoFocus />
      <CommandList>
        <CommandEmpty>
          {debounced.trim().length < 2
            ? 'Two characters is enough to search the documents.'
            : `Nothing matches “${debounced.trim()}”.`}
        </CommandEmpty>

        {byGroup(actions).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((action) => (
              <CommandItem
                key={action.id}
                value={`${action.label} ${action.keywords ?? ''}`}
                onSelect={() => action.run(context)}
              >
                {action.icon && <action.icon size={15} className="shrink-0 text-ink-faint" aria-hidden />}
                {/* The label gets the row; the hint is capped at half of it.
                    Without the cap a long hint (a plan's full title) wins the
                    space fight and truncates the label to "Pha…", which is the
                    one part of the row you were reading. */}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint && (
                  <span className="min-w-0 max-w-[50%] shrink truncate pl-2 text-2xs text-ink-faint">
                    {action.hint}
                  </span>
                )}
                {action.shortcut && (
                  <CommandShortcut>
                    <KbdChord keys={action.shortcut} />
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <SearchResults query={debounced} onPick={(href) => navigate(href)} />
      </CommandList>

      {/* The count that used to be the Search page's subtitle. It is the only
          thing that tells you the search reaches file text at all. */}
      <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-1.5 text-2xs text-ink-faint">
        <span>
          {counts.plans} plans · {counts.phases} phases
          {state?.searchDocs ? ` · ${state.searchDocs} documents indexed` : ''}
        </span>
        <span className="flex items-center gap-1">
          <KbdChord keys={['↵']} /> open · <KbdChord keys={['esc']} /> close
        </span>
      </div>
    </CommandDialog>
  );
}
