/**
 * UI preferences that outlive a reload: theme, list density, sort, filters.
 *
 * A module-level store rather than context, because the theme has to be applied
 * before React renders (see `main.tsx`) and a context cannot reach that far up.
 * The shape and the storage key are unchanged from `web/store.js`, so a browser
 * that has been using the old client keeps its settings across the cutover.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'phase-console.ui';

export type Theme = 'system' | 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  density: 'comfortable' | 'compact';
  sort: string;
  showDocuments: boolean;
  showComplete: boolean;
  model: string;
  /** How the ready board is ordered — see `views/ready/model.ts` `RANKS`. */
  readyRank: string;
  /** Ready board: one flat queue, or grouped under each plan. */
  readyGroup: boolean;
}

// A key added here is safe for a browser carrying the old client's settings:
// `load()` spreads these under whatever was stored, so an absent key takes the
// default rather than reading `undefined`.
const DEFAULTS: Prefs = {
  theme: 'system',
  density: 'comfortable',
  sort: 'activity',
  showDocuments: false,
  showComplete: true,
  model: '',
  readyRank: 'leverage',
  readyGroup: false,
};

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as Prefs;
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return state;
}

export function setPrefs(patch: Partial<Prefs>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  if (patch.theme) applyTheme(state.theme);
  for (const notify of listeners) notify();
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const value = useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => state,
    () => state,
  );
  return [value, setPrefs];
}

/**
 * The whole theme switch. `theme.css` declares every colour once with
 * `light-dark(paper, night)`, so flipping `color-scheme` — which is what these
 * three attribute states do — repaints the app. `system` is the absence of the
 * attribute.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
