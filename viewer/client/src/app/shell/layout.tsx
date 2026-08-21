import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useKeyboardOpen } from '@/lib/viewport';
import { FULL_HEIGHT_HEADS, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { Header } from './header';
import { MoreSheet } from './more-sheet';
import { Rail } from './rail';
import { TabBar } from './tab-bar';

/* ---------------- the slots a page may use ---------------- */

interface ShellSlots {
  headerActions: HTMLElement | null;
  banner: HTMLElement | null;
}

const SlotContext = createContext<ShellSlots>({ headerActions: null, banner: null });

/**
 * A page's own actions, rendered into the shell header.
 *
 * A portal rather than a prop because the alternative is threading a
 * `headerActions` prop from the shell through the router into every page — and
 * the page that wants a button is three components deep inside itself. Mount it
 * anywhere in the tree and it appears in the header; unmount and it goes.
 *
 * Hosts are held as STATE, not refs: a ref is null on the render that would
 * portal into it, so a ref-based slot renders one frame late and, in a test that
 * asserts synchronously, never at all.
 */
export function HeaderActions({ children }: { children: ReactNode }) {
  const { headerActions } = useContext(SlotContext);
  return headerActions ? createPortal(children, headerActions) : null;
}

/**
 * A page-level banner, above the scroller and below the shell's own.
 *
 * The shell's banners (stale server, offline, console stopped) are about the
 * CONSOLE and always outrank a page's, which is why they are painted first and
 * this slot sits under them.
 */
export function ShellBanner({ children }: { children: ReactNode }) {
  const { banner } = useContext(SlotContext);
  return banner ? createPortal(children, banner) : null;
}

/* ---------------- the grid ---------------- */

/**
 * The shell: a rail or a tab bar, one header, and exactly one scroller.
 *
 * Moved out of `App.tsx` in 3.0 so that file can go back to being a composition
 * root. The rules it enforces are the ones a phone breaks first:
 *
 * - **`h-(--app-height)`, never `h-dvh`.** `dvh` ignores the software keyboard
 *   on iOS; the token follows `visualViewport` and falls back to `100dvh`.
 * - **One scroller.** `<main>` is the only scrolling region, and it is a
 *   PERSISTENT node — React swaps its children, so its `scrollTop` survives a
 *   route change unless something resets it. Reset on the PATH, never the query
 *   (typing into `?k=` must not jump), and never on a full-height head, which
 *   has no `scrollTop` to reset.
 * - **`overscroll-none`, not `contain`.** `contain` stops the scroll *chaining*
 *   to the document but leaves the rubber band, so a flick past the last card
 *   still bounces a strip of empty ground above the tab bar.
 * - **The tab bar is a grid ROW**, hidden only while a software keyboard is up.
 */
export function ShellLayout({
  state,
  counts,
  route,
  phone,
  banners,
  children,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  phone: boolean;
  /** The console's own banners — stale server, offline, stopped. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const head = route.segments[0];
  const fullHeight = FULL_HEIGHT_HEADS.has(head ?? '');
  const keyboardOpen = useKeyboardOpen();
  const [moreOpen, setMoreOpen] = useState(false);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const [banner, setBanner] = useState<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!fullHeight) main.current?.scrollTo(0, 0);
  }, [route.path, fullHeight]);

  // Going anywhere closes the sheet — including "back", which is the gesture a
  // sheet is most often dismissed with.
  useEffect(() => {
    setMoreOpen(false);
  }, [route.path]);
  useEffect(() => {
    if (!phone) setMoreOpen(false);
  }, [phone]);

  const header = (
    <Header state={state} counts={counts} route={route} phone={phone} slotRef={setHeaderActions} />
  );

  const content = (
    <main
      ref={main}
      className={
        fullHeight
          ? // Terminal/agent own their height: banners stay in flow and the
            // frame gets the definite remainder — never a second scroller.
            'flex min-w-0 flex-col overflow-hidden'
          : 'min-w-0 overflow-y-auto overscroll-none'
      }
    >
      {(banners != null || banner != null) && (
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 empty:hidden md:px-5">
          {banners}
          <div ref={setBanner} className="flex flex-col gap-2 empty:hidden" />
        </div>
      )}
      {children}
    </main>
  );

  return (
    <SlotContext.Provider value={{ headerActions, banner }}>
      <div
        // `.is-phone` is the shell contract: the class the layout, the tests and
        // the browser checks all agree means "header + tab bar, no rail".
        className={cn(
          'grid h-(--app-height) overflow-hidden bg-ground',
          phone
            ? // rows: header · the only scrolling region · tab bar
              'is-phone grid-rows-[auto_minmax(0,1fr)_auto]'
            : 'grid-cols-[auto_minmax(0,1fr)]',
        )}
      >
        {phone ? (
          <>
            {header}
            {content}
            {/* Hidden while a SOFTWARE keyboard is up: typing is never a
                navigation moment, and those 60px keep the terminal's prompt and
                key bar visible. Focus alone is a hardware keyboard and does not
                count — that distinction is `useKeyboardOpen`'s whole job. */}
            {!keyboardOpen && (
              <TabBar
                state={state}
                counts={counts}
                head={head}
                moreOpen={moreOpen}
                onMore={() => setMoreOpen((open) => !open)}
              />
            )}
          </>
        ) : (
          <>
            <Rail state={state} counts={counts} head={head} />
            <div className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
              {header}
              {content}
            </div>
          </>
        )}
      </div>

      {phone && (
        <MoreSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          state={state}
          counts={counts}
          route={route}
          head={head}
        />
      )}
    </SlotContext.Provider>
  );
}
