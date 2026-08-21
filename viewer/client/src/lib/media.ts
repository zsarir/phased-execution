/**
 * Viewport questions, asked once and shared.
 *
 * The two numbers here are the two the design actually branches on, and both
 * are canonical breakpoints from `theme.css`:
 *
 *   `--bp-shell` (900px)  the rail stops fitting beside the page, so the shell
 *                         becomes a different component — top bar, tab bar,
 *                         sheet. This is what `.is-phone` marks.
 *   `--bp-phone` (640px)  one thumb, one column. Layout inside a view collapses
 *                         to a single column; marked `.is-narrow`.
 *
 * They are separate on purpose. A 768px tablet wants the phone *shell* (a 236px
 * rail beside a 530px page is not a layout) but not the one-column *content*.
 * Collapsing them into one number is what made the old client either waste a
 * tablet's width or squeeze the rail onto it.
 *
 * A media query cannot read a custom property, so the literals below are the
 * live copy and the Vitest theme guard asserts they still match `theme.css`.
 */

import { useSyncExternalStore } from 'react';

export const BP_PHONE = 640;
export const BP_SHELL = 900;
export const BP_WIDE = 1200;

const cache = new Map<string, { list: MediaQueryList; subscribe: (fn: () => void) => () => void }>();

function entry(query: string) {
  let found = cache.get(query);
  if (!found) {
    const list = window.matchMedia(query);
    found = {
      list,
      subscribe: (fn: () => void) => {
        list.addEventListener('change', fn);
        return () => list.removeEventListener('change', fn);
      },
    };
    cache.set(query, found);
  }
  return found;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) =>
      typeof window === 'undefined' || !window.matchMedia ? () => {} : entry(query).subscribe(notify),
    () => (typeof window === 'undefined' || !window.matchMedia ? false : entry(query).list.matches),
    () => false,
  );
}

/** True when the rail no longer fits — the shell swaps to top bar + tab bar. */
export const usePhone = (): boolean => useMediaQuery(`(max-width: ${BP_SHELL - 1}px)`);

/** The same answer for code that runs outside React — a mint from a plain function. */
export const isPhone = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.matchMedia)
    ? window.matchMedia(`(max-width: ${BP_SHELL - 1}px)`).matches
    : false;

/** True when there is room for one column only. */
export const useNarrow = (): boolean => useMediaQuery(`(max-width: ${BP_PHONE - 1}px)`);

/** A device that has no hover — used to turn `title` tooltips into taps. */
export const useTouch = (): boolean => useMediaQuery('(hover: none)');
