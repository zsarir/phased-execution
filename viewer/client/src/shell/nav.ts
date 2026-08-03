import {
  Bell, Compass, LayoutGrid, LineChart, ListChecks, Search, Settings, FileText, Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Where you can go, defined once.
 *
 * The rail, the tab bar and the More sheet all read this. In the old client each
 * kept its own list, which is how the phone ended up unable to reach Settings —
 * the rail's footer held Guide, Settings and the theme switcher, and the phone
 * layout set that footer to `display: none`. Nothing announced it; the links
 * simply were not there.
 *
 * `tab: true` marks the four that get a bottom-bar slot on a phone. Everything
 * else is reachable from the sheet, so every destination is one or two taps away
 * from anywhere — the invariant the old shell broke.
 */

export interface NavItem {
  /** A `ROUTE_HEADS` member — the router resolves it. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** What it is, shown in the More sheet. */
  note: string;
  /** Which count decorates it, if any. */
  badge?: 'ready' | 'approvals' | 'unread';
  /** In the phone tab bar. */
  tab?: boolean;
  /** In the rail's main block (vs its footer). */
  primary?: boolean;
}

export const NAV: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid, note: 'The board at a glance', tab: true, primary: true },
  { id: 'ready', label: 'Ready now', icon: Zap, note: 'Every phase that could start', badge: 'ready', tab: true, primary: true },
  { id: 'plans', label: 'Plans', icon: FileText, note: 'Every plan in this source', tab: true, primary: true },
  { id: 'runs', label: 'Runs', icon: LineChart, note: 'Autopilot — what is running now', badge: 'approvals', tab: true, primary: true },
  { id: 'notifications', label: 'Notifications', icon: Bell, note: 'Everything the console has announced', badge: 'unread', primary: true },
  { id: 'stats', label: 'Statistics', icon: ListChecks, note: 'Throughput, cost and the shape of the portfolio', primary: true },
  { id: 'search', label: 'Search', icon: Search, note: 'Every plan, handoff and phase at once', primary: true },
  { id: 'guide', label: 'Guide', icon: Compass, note: 'How the runner works, and the phone setup' },
  { id: 'settings', label: 'Settings', icon: Settings, note: 'Notifications, permission rules, devices' },
];

/** The phone tab bar: the four, plus More. */
export const TAB_ITEMS = NAV.filter((item) => item.tab);
/** The sheet: everything the tab bar does not already show. */
export const SHEET_ITEMS = NAV.filter((item) => !item.tab);

/**
 * A plan page is somewhere you arrived from Plans, so Plans stays lit while you
 * are on one — a nav that goes dark whenever you go deeper reads as though you
 * have left the app.
 */
export function activeNavId(head: string | undefined): string {
  if (!head) return 'dashboard';
  return head === 'plan' ? 'plans' : head;
}
