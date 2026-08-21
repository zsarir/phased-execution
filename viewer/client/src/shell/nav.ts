import {
  Activity,
  Bell,
  Bot,
  Compass,
  LayoutGrid,
  LineChart,
  ListChecks,
  Plug,
  Search,
  Settings,
  FileText,
  TerminalSquare,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ConsoleState } from '@/lib/api';

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
  /** Which count decorates it, if any. Must be a `ShellCounts` key. */
  badge?: 'ready' | 'approvals' | 'unread' | 'agentSessions' | 'terminalSessions' | 'mcpAttention';
  /** In the phone tab bar. */
  tab?: boolean;
  /** In the rail's main block (vs its footer). */
  primary?: boolean;
  /**
   * A server capability this destination needs before it is worth offering.
   *
   * The route always exists and always explains itself — what this hides is the
   * *nav entry*, because a permanent dead link in a nine-item list is noise on
   * every machine that never turns the feature on.
   */
  requires?: 'allowTerminal' | 'allowAgent';
}

export const NAV: readonly NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutGrid,
    note: 'The board at a glance',
    tab: true,
    primary: true,
  },
  {
    id: 'ready',
    label: 'Ready now',
    icon: Zap,
    note: 'Every phase that could start',
    badge: 'ready',
    tab: true,
    primary: true,
  },
  {
    id: 'plans',
    label: 'Plans',
    icon: FileText,
    note: 'Every plan in this source',
    tab: true,
    primary: true,
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: LineChart,
    note: 'Autopilot — what is running now',
    badge: 'approvals',
    tab: true,
    primary: true,
  },
  {
    id: 'pulse',
    label: 'Pulse',
    icon: Activity,
    note: "Every plan's live lanes, queues and waits, on one page",
    primary: true,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    note: 'Everything the console has announced',
    badge: 'unread',
    primary: true,
  },
  {
    id: 'stats',
    label: 'Statistics',
    icon: ListChecks,
    note: 'Throughput, cost and the shape of the portfolio',
    primary: true,
  },
  {
    id: 'search',
    label: 'Search',
    icon: Search,
    note: 'Every plan, handoff and phase at once',
    primary: true,
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: Bot,
    note: 'Interactive Claude sessions, in a terminal',
    // Sessions outlive the tab that opened them, so "is one still running?" is
    // no longer answerable by remembering. The badge is the answer, on every
    // page — and it is not `hot`, because a session working away is not an alarm.
    badge: 'agentSessions',
    requires: 'allowAgent',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: TerminalSquare,
    note: 'A shell on this machine, from here or from a phone',
    badge: 'terminalSessions',
    requires: 'allowTerminal',
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: Plug,
    note: 'Tools your sessions may connect to',
    badge: 'mcpAttention',
  },
  { id: 'guide', label: 'Guide', icon: Compass, note: 'How the runner works, and the phone setup' },
  { id: 'settings', label: 'Settings', icon: Settings, note: 'Notifications, permission rules, devices' },
];

/**
 * The destinations this console can actually offer.
 *
 * Filtered at render rather than at module scope: `NAV` is a constant, but
 * whether the server has a terminal is a fact that arrives with `/api/state`
 * and can change on a restart.
 */
export function visibleNav(state: ConsoleState | undefined): NavItem[] {
  return NAV.filter((item) => !item.requires || state?.[item.requires] === true);
}

/**
 * The phone tab bar: the four, plus More. Never capability-gated — the four
 * are the ones every console has, and a tab bar that changes width between
 * machines is worse than a rule.
 *
 * The sheet is `visibleNav(state).filter(i => !i.tab)`, computed at render
 * because the gate depends on the server.
 */
export const TAB_ITEMS = NAV.filter((item) => item.tab);

/**
 * A plan page is somewhere you arrived from Plans, so Plans stays lit while you
 * are on one — a nav that goes dark whenever you go deeper reads as though you
 * have left the app.
 */
export function activeNavId(head: string | undefined): string {
  if (!head) return 'dashboard';
  return head === 'plan' ? 'plans' : head;
}
