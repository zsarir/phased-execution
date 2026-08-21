import { FileText, Gauge, LineChart, Play, Settings, TerminalSquare, type LucideIcon } from 'lucide-react';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { ConsoleState } from '@/lib/api';

/**
 * Where you can go, defined once — and in 3.0 that is **six places**.
 *
 * The 2.x nav had thirteen entries and still could not answer "does anything
 * need me?" without visiting three of them. The six below are the questions an
 * operator actually has, in the order they have them; everything else in the
 * URL space is either a page one of these will absorb (`#/ready`, `#/pulse`,
 * `#/mcp`) or an overlay that rides on top of whatever is on screen (the
 * palette, the help sheet, the announcements drawer). `app/routes.ts`
 * `destinationFor` is what keeps those older heads lighting the right entry.
 *
 * `tab: true` marks the four that get a bottom-bar slot on a phone; Insights,
 * Settings and Help live in the More sheet, so every destination is one or two
 * taps away from anywhere.
 */

export interface NavItem {
  /** A `DESTINATIONS` member — the router resolves it. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** What it is, shown in the More sheet. */
  note: string;
  /** Which count decorates it, if any. Must be a `ShellCounts` key. */
  badge?: 'needsYou' | 'ready' | 'approvals' | 'sessions';
  /** In the phone tab bar. */
  tab?: boolean;
  /**
   * A server capability this destination needs before it is worth offering.
   *
   * The route always exists and always explains itself — what this hides is the
   * *nav entry*, because a permanent dead link is noise on every machine that
   * never turns the feature on. `requires` is a list because Sessions covers
   * both kinds of process: either flag is enough to make it worth a slot.
   */
  requires?: readonly ('allowTerminal' | 'allowAgent')[];
}

export const NAV: readonly NavItem[] = [
  {
    id: 'now',
    label: 'Now',
    icon: Gauge,
    note: 'What needs you, what is running, what is next',
    // The one count that is a call to action rather than a census. It is the
    // accent hue everywhere else in the app, for the same reason.
    badge: 'needsYou',
    tab: true,
  },
  {
    id: 'plans',
    label: 'Plans',
    icon: FileText,
    note: 'Every plan in this source, and where each one is',
    badge: 'ready',
    tab: true,
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: Play,
    note: 'The fleet and the money — every run, its status and its cost',
    // Deliberately unbadged. The approvals count is exactly what `needsYou`
    // counts, and painting one number on two entries is the "same state on
    // four surfaces" this redesign exists to end. Runs answers *what is
    // running and what did it cost*; *does anything need me* is Now's.
    tab: true,
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: TerminalSquare,
    note: 'Every process the console owns or sees, with its terminal',
    // Sessions outlive the tab that opened them, so "is one still running?" is
    // no longer answerable by remembering. It is not the accent hue — a session
    // working away is not an alarm.
    badge: 'sessions',
    tab: true,
    requires: ['allowTerminal', 'allowAgent'],
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: LineChart,
    note: 'Velocity, cost over time against the caps, ETA, the shape of the portfolio',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    note: 'Automation, accounts, MCP servers, alerts, permissions, appearance',
  },
];

// The nav and the shared vocabulary are one list stated twice; this is where a
// third statement would go wrong first. Cheap enough to assert at module load.
if (NAV.map((item) => item.id).join() !== (DESTINATIONS as readonly string[]).join()) {
  throw new Error('app/shell/nav.ts and shared/route-meta.js DESTINATIONS disagree');
}

/**
 * The destinations this console can actually offer.
 *
 * Filtered at render rather than at module scope: `NAV` is a constant, but
 * whether the server has a terminal is a fact that arrives with `/api/state`
 * and can change on a restart.
 */
export function visibleNav(state: ConsoleState | undefined): NavItem[] {
  return NAV.filter((item) => !item.requires || item.requires.some((flag) => state?.[flag] === true));
}

/**
 * The phone tab bar: whichever of the four this console offers, plus More.
 *
 * Sessions is the only gated one, and it is gated here too — a tab that opens a
 * page saying "this console has no terminal and no agent" is a slot spent on
 * nothing, and the bar has four of them.
 */
export function tabItems(state: ConsoleState | undefined): NavItem[] {
  return visibleNav(state).filter((item) => item.tab);
}

/** Everything the tab bar does not show — the More sheet's list. */
export function sheetItems(state: ConsoleState | undefined): NavItem[] {
  return visibleNav(state).filter((item) => !item.tab);
}
