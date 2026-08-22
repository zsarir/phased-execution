import { LEGACY_PLAN_TABS, PLAN_TABS } from '@shared/route-meta.js';

/**
 * The tab ids come from `shared/route-meta.js` — the server builds notification
 * deep links from the same list — and only the *words* live here.
 *
 * A label map keyed off the frozen array (rather than its own list of tabs) is
 * what stops a tab from existing in the URL vocabulary and nowhere in the
 * interface: an id with no entry falls back to the id itself, and a client test
 * asserts every id has a real label and a real panel.
 *
 * The retired ids keep their labels. `resolveTab` still has to answer for one —
 * a bookmarked `#/plan/x/raw` renders for the instant before the redirect lands
 * — and a strip that flashed "raw" as its own missing tab would be a worse
 * answer than the tab it is about to become.
 */
export const PLAN_TAB_LABELS: Record<string, string> = {
  route: 'Route',
  phases: 'Phases',
  run: 'Autopilot',
  handoffs: 'Handoffs',
  source: 'Source',
  // retired — see LEGACY_PLAN_TABS
  analysis: 'Analysis',
  overview: 'Overview',
  raw: 'Raw',
};

export const TAB_IDS = PLAN_TABS as readonly string[];

export const tabLabel = (id: string): string => PLAN_TAB_LABELS[id] ?? id;

/** A retired tab id → the tab of THIS page it became, if it is one. */
export const legacyTabTarget = (id: string): string | undefined =>
  (LEGACY_PLAN_TABS as Record<string, { tab?: string; head?: string } | undefined>)[id]?.tab;

/** True for an id this page used to register and no longer does. */
export const isLegacyTab = (id: string): boolean => id in LEGACY_PLAN_TABS;

/**
 * The two detail sub-routes are not tabs — `#/plan/:slug/phase/3` is a page of
 * its own — but the tab strip still has to show *something* as current, and the
 * honest answer is the list the detail was reached from.
 */
export const DETAIL_TABS: Record<string, string> = {
  phase: 'phases',
  handoff: 'handoffs',
};

export const isDetailRoute = (tab: string | undefined): tab is 'phase' | 'handoff' =>
  tab === 'phase' || tab === 'handoff';

/**
 * The tab strip's current value for any second segment, valid or not.
 *
 * A retired id resolves to what it became rather than falling back to `route`:
 * the redirect is what actually moves the address, and for the render before it
 * lands this is the tab the reader asked for.
 */
export function resolveTab(segment: string | undefined): string {
  if (!segment) return 'route';
  if (isDetailRoute(segment)) return DETAIL_TABS[segment];
  if (TAB_IDS.includes(segment)) return segment;
  return legacyTabTarget(segment) ?? 'route';
}
