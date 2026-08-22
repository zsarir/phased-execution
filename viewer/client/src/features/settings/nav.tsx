/**
 * The Settings vocabulary: which sections exist, and the nav that lists them.
 *
 * 2.x Settings was ONE page of fifteen cards — the console's whole
 * configuration surface in a single scroll, with no address for any part of it.
 * "Turn the repository guard off" could only be given as *scroll down Settings
 * until you find Automation*, and a deep link from an errand, a guide page or a
 * push notification had nowhere to point.
 *
 * Three rules hold the split together:
 *
 * 1. **A section is a QUESTION, not a card.** `#/settings/process` answers "what
 *    is this server doing and how do I replace it" — which needs the process
 *    facts, the start command that Restart refuses without, the launcher and
 *    how the console is reached. Splitting those into four sections would put
 *    one answer behind four addresses; merging them into General would put four
 *    answers behind one.
 * 2. **The id is the address.** `SECTION_IDS` is what `#/settings/:section`
 *    accepts, so an unknown section is a redirect to the index rather than a
 *    blank frame — the `ROUTE_HEADS` discipline, one level down.
 * 3. **The index is a real page, not a redirect to the first section.** On a
 *    phone the list IS the screen; on a desktop it is the rail. An index that
 *    bounced to General would make the back button unusable on the surface
 *    where the list matters most.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SettingsSection {
  id: string;
  title: string;
  /** The question this section answers — shown on the index, read aloud by the nav. */
  blurb: string;
}

/**
 * The eight sections, in the order an operator meets them: what this console
 * is reading, how it looks, what it may do by itself, who it does it as, what
 * it says and to what, what it may run, and the process itself.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  {
    id: 'general',
    title: 'General',
    blurb: 'The directory being read, the engine behind every status, and the keys.',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    blurb: 'Theme, density, what the plan list shows, and how the terminal paints.',
  },
  {
    id: 'automation',
    title: 'Automation',
    blurb: 'The opening values for every launch, the ladder’s caps, and when a session counts as stalled.',
  },
  {
    id: 'accounts',
    title: 'Accounts',
    blurb: 'Which account a session runs as, its usage, and what happens at a wall.',
  },
  {
    id: 'alerts',
    title: 'Alerts',
    blurb: 'What the console announces at all, and the devices a push reaches.',
  },
  { id: 'mcp', title: 'MCP servers', blurb: 'The servers a session may reach, and the catalog to add from.' },
  {
    id: 'permissions',
    title: 'Permissions',
    blurb: 'What a session may run without being asked — one vocabulary, per profile.',
  },
  {
    id: 'process',
    title: 'This process',
    blurb: 'What is running, how it was started, how it is reached, and how to replace it.',
  },
] as const);

/** Every valid `#/settings/:section` — the accepted set, not a suggestion. */
export const SECTION_IDS: readonly string[] = SETTINGS_SECTIONS.map((section) => section.id);

/** The section for an id, or `undefined` — the caller decides what an unknown one means. */
export function sectionFor(id: string | undefined): SettingsSection | undefined {
  return id ? SETTINGS_SECTIONS.find((section) => section.id === id) : undefined;
}

/** The address of a section, ready for an `href`. */
export function sectionHref(id: string): string {
  return `#/settings/${id}`;
}

/**
 * The section list.
 *
 * One component for both layouts: a rail on a desktop (`aside`), a list of
 * cards on a phone. `current` lights the one you are on and marks it
 * `aria-current="page"` — the nav is a real `<nav>` with real links, so
 * cmd-click, middle-click and "copy link address" all work, which is the whole
 * point of giving each section an address.
 */
export function SettingsNav({
  current,
  className,
  variant = 'rail',
}: {
  current?: string;
  className?: string;
  variant?: 'rail' | 'index';
}) {
  return (
    <nav aria-label="Settings sections" className={cn('min-w-0', className)}>
      <ul
        className={cn('min-w-0', variant === 'rail' ? 'flex flex-col gap-0.5' : 'grid gap-2 sm:grid-cols-2')}
      >
        {SETTINGS_SECTIONS.map((section) => (
          <li key={section.id} className="min-w-0">
            <a
              href={sectionHref(section.id)}
              aria-current={current === section.id ? 'page' : undefined}
              className={cn(
                'flex min-h-(--tap-min) min-w-0 flex-col justify-center rounded px-3 py-2',
                'text-sm text-ink-muted hover:bg-raised hover:text-ink',
                'aria-[current=page]:bg-raised aria-[current=page]:text-ink',
                variant === 'index' && 'border border-rule',
              )}
            >
              <span className="truncate font-medium text-ink">{section.title}</span>
              {variant === 'index' && <span className="mt-0.5 text-2xs text-ink-muted">{section.blurb}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The frame one section renders inside — heading, blurb, and the cards.
 *
 * `<h2>` rather than `<h1>`: the page's `<h1>` is *Settings*, and a section is
 * a part of it. A screen reader walking headings then hears the whole shape.
 */
export function SettingsSectionFrame({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`settings-${section.id}`} className="min-w-0">
      <header className="mb-3 min-w-0">
        <h2 id={`settings-${section.id}`} className="font-display text-xl leading-none text-ink">
          {section.title}
        </h2>
        <p className="mt-1.5 text-sm text-ink-muted">{section.blurb}</p>
      </header>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}
