import { PLAN_TABS } from '@shared/route-meta.js';

/**
 * The tab ids come from `shared/route-meta.js` — the server builds notification
 * deep links from the same list — and only the *words* live here.
 *
 * A label map keyed off the frozen array (rather than its own list of tabs) is
 * what stops a tab from existing in the URL vocabulary and nowhere in the
 * interface: an id with no entry falls back to the id itself, and a client test
 * asserts every id has a real label and a real panel.
 */
export const PLAN_TAB_LABELS: Record<string, string> = {
  route: 'Route',
  phases: 'Phases',
  run: 'Autopilot',
  handoffs: 'Handoffs',
  analysis: 'Analysis',
  overview: 'Overview',
  raw: 'Raw',
};

export const TAB_IDS = PLAN_TABS as readonly string[];

export const tabLabel = (id: string): string => PLAN_TAB_LABELS[id] ?? id;

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

/** The tab strip's current value for any second segment, valid or not. */
export function resolveTab(segment: string | undefined): string {
  if (!segment) return 'route';
  if (isDetailRoute(segment)) return DETAIL_TABS[segment];
  return TAB_IDS.includes(segment) ? segment : 'route';
}
