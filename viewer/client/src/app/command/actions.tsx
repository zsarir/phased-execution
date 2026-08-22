import {
  Bot,
  FolderOpen,
  LifeBuoy,
  Moon,
  Plus,
  Power,
  Sun,
  SunMoon,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { NAV } from '@/app/shell/nav';
import { helpHref, insightsHref, phaseHref, planHref, runHref, type Route } from '@/app/routes';
import type { ConsoleState, PlanSummary, RunState } from '@/lib/api';
import { STATE_META, runUiState } from '@/lib/status-vocab';

/**
 * The palette's command registry.
 *
 * **The API, in one paragraph.** An action is a plain object with an `id`, a
 * `group`, a `label` and a `run(context)`. `keywords` widens what cmdk will
 * match it on (cmdk scores against the rendered text plus this string, so
 * "money" can find Insights). `hint` is the muted right-hand column, `shortcut`
 * the keycap one. A *builder* is a pure function from `CommandContext` to
 * `CommandAction[]`, and `paletteActions` is the ordered concatenation of them.
 * Adding a command means adding it to a builder; adding a KIND of command means
 * adding a builder to that list. Nothing here renders — `palette.tsx` does — so
 * a builder can be unit-tested by calling it.
 *
 * **Gating is a builder's job, not the palette's.** `verbActions` returns
 * nothing for a capability this console does not have, rather than returning a
 * disabled row: a palette is a list of things you can do, and a list padded with
 * things you cannot is a list people stop reading. The one exception is a verb
 * whose absence would be mystifying, which gets a `hint` saying which flag.
 */

export interface CommandContext {
  state: ConsoleState | undefined;
  /** Where the palette was opened from — context verbs read this. */
  route: Route;
  plans: PlanSummary[] | undefined;
  runs: RunState[] | undefined;
  /** Go somewhere. The palette closes itself around this. */
  go: (path: string) => void;
  setTheme: (theme: 'system' | 'dark' | 'light') => void;
}

export interface CommandAction {
  id: string;
  group: string;
  label: string;
  /** Muted, right of the label — a path, a status, a plan's slug. */
  hint?: string;
  icon?: LucideIcon;
  /** Extra terms cmdk may match on, beyond the rendered text. */
  keywords?: string;
  /** Keycaps, right-aligned. */
  shortcut?: string[];
  run: (context: CommandContext) => void;
}

const GROUPS = {
  go: 'Go to',
  plans: 'Plans',
  runs: 'Runs',
  do: 'Do',
} as const;

/** The six destinations, plus Help — everywhere the nav can send you. */
export function navigationActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  const items = NAV.filter(
    (item) => !item.requires || item.requires.some((flag) => state?.[flag] === true),
  ).map<CommandAction>((item) => ({
    id: `go:${item.id}`,
    group: GROUPS.go,
    label: item.label,
    hint: item.note,
    icon: item.icon,
    keywords: item.note,
    run: (ctx) => ctx.go(item.id),
  }));

  items.push({
    id: 'go:help',
    group: GROUPS.go,
    label: 'Help',
    hint: 'The guide, over this page',
    icon: LifeBuoy,
    keywords: 'guide docs manual how',
    run: (ctx) => ctx.go(helpHref(undefined, undefined, ctx.route)),
  });

  return items;
}

/**
 * Every plan by name, and the phases that could start.
 *
 * A plan's own row goes to its route map — the page that answers "where is
 * this?" — and a ready phase gets its own row because "start the thing that can
 * start" is the single most common reason to open this palette at all.
 */
export function planActions(context: CommandContext): CommandAction[] {
  const out: CommandAction[] = [];
  for (const plan of context.plans ?? []) {
    if (plan.kind !== 'plan') continue;
    const title = typeof plan.title === 'string' && plan.title ? plan.title : plan.slug;
    const ready = (plan.ready ?? []).filter((n): n is number => typeof n === 'number');
    out.push({
      id: `plan:${plan.slug}`,
      group: GROUPS.plans,
      label: title,
      // A slug that IS the title says nothing twice.
      hint:
        title === plan.slug
          ? ready.length
            ? `${ready.length} ready`
            : undefined
          : ready.length
            ? `${plan.slug} · ${ready.length} ready`
            : plan.slug,
      keywords: plan.slug,
      run: (ctx) => ctx.go(planHref(plan.slug, 'route')),
    });
    // `/api/plans` sends the queue as bare NUMBERS — the titles live in the
    // plan detail, which the palette does not fetch. A row that says "phase 4"
    // under its plan's name is still the fastest way to reach the thing that
    // could start; the title arrives when Phase 9 puts the detail behind this.
    for (const phase of ready) {
      out.push({
        id: `phase:${plan.slug}:${phase}`,
        group: GROUPS.plans,
        label: `Phase ${phase}`,
        // The slug, not the title: these rows sit under their plan's own row,
        // and a slug is what stays readable at half a palette's width.
        hint: `${plan.slug} · ready`,
        keywords: `${plan.slug} ready next up`,
        run: (ctx) => ctx.go(phaseHref(plan.slug, phase)),
      });
    }
  }
  return out;
}

/** Every run, by the plan it is driving, with what it is doing right now. */
export function runActions(context: CommandContext): CommandAction[] {
  return (context.runs ?? []).map<CommandAction>((run) => {
    const meta = STATE_META[runUiState(run.status)];
    return {
      id: `run:${run.slug}`,
      group: GROUPS.runs,
      label: run.slug,
      hint: run.activePhase ? `${meta.label} · phase ${run.activePhase}` : meta.label,
      keywords: `${run.status} ${run.model} run autopilot`,
      run: (ctx) => ctx.go(runHref(run.slug)),
    };
  });
}

/**
 * The verbs — what this console may actually do, from wherever you are.
 *
 * Every one is gated on the flag that governs it, so the list is a truthful
 * account of this console's capability rather than a menu of disappointments.
 */
export function verbActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  const out: CommandAction[] = [];

  if (state?.allowWrites) {
    out.push({
      id: 'do:new-plan',
      group: GROUPS.do,
      label: 'New plan…',
      hint: 'The scaffold card, on Now',
      icon: Plus,
      keywords: 'create scaffold add',
      run: (ctx) => ctx.go('now'),
    });
  }
  if (state?.allowAgent) {
    out.push({
      id: 'do:agent',
      group: GROUPS.do,
      label: 'Open an agent session',
      hint: 'Interactive Claude, in a terminal',
      icon: Bot,
      keywords: 'claude session interactive launch',
      run: (ctx) => ctx.go('sessions?new=agent'),
    });
  }
  if (state?.allowTerminal) {
    out.push({
      id: 'do:terminal',
      group: GROUPS.do,
      label: 'Open a terminal',
      hint: 'A shell on this machine',
      icon: TerminalSquare,
      keywords: 'shell console bash zsh',
      run: (ctx) => ctx.go('sessions?new=shell'),
    });
  }

  out.push(
    {
      id: 'do:insights',
      group: GROUPS.do,
      label: 'Spend and velocity',
      hint: 'Cost over time against the caps',
      keywords: 'money cost usd budget throughput eta',
      run: (ctx) => ctx.go(insightsHref()),
    },
    {
      id: 'do:source',
      group: GROUPS.do,
      label: 'Open a different project…',
      icon: FolderOpen,
      keywords: 'switch root directory repository',
      run: (ctx) => ctx.go('source'),
    },
    {
      id: 'do:theme-dark',
      group: GROUPS.do,
      label: 'Theme: Night',
      icon: Moon,
      keywords: 'dark appearance colour color',
      run: (ctx) => ctx.setTheme('dark'),
    },
    {
      id: 'do:theme-light',
      group: GROUPS.do,
      label: 'Theme: Paper',
      icon: Sun,
      keywords: 'light appearance colour color',
      run: (ctx) => ctx.setTheme('light'),
    },
    {
      id: 'do:theme-system',
      group: GROUPS.do,
      label: 'Theme: Auto',
      icon: SunMoon,
      keywords: 'system appearance colour color',
      run: (ctx) => ctx.setTheme('system'),
    },
  );

  // Shutting the console down is deliberately NOT behind a flag — but it is
  // also not something to hand someone who typed three letters, so it lives on
  // its own page and this only takes them there.
  out.push({
    id: 'do:shutdown',
    group: GROUPS.do,
    label: 'Shut this console down…',
    hint: 'Settings',
    icon: Power,
    keywords: 'stop quit exit kill',
    run: (ctx) => ctx.go('settings'),
  });

  return out;
}

/** Everything, in the order the groups are meant to be read. */
export function paletteActions(context: CommandContext): CommandAction[] {
  return [
    ...navigationActions(context),
    ...planActions(context),
    ...runActions(context),
    ...verbActions(context),
  ];
}

/** Grouped for rendering, preserving both the group order and the item order. */
export function byGroup(actions: CommandAction[]): [string, CommandAction[]][] {
  const out = new Map<string, CommandAction[]>();
  for (const action of actions) {
    const bucket = out.get(action.group);
    if (bucket) bucket.push(action);
    else out.set(action.group, [action]);
  }
  return [...out.entries()];
}
