/**
 * The guide's content, one markdown file per section.
 *
 * The legacy guide was 504 lines of JS with the prose embedded in `html`
 * template literals, which meant editing a sentence was editing a component and
 * nobody could read the page's text without reading its markup. Here the text is
 * markdown on disk, imported with Vite's `?raw` and rendered through the same
 * sanitized `<Markdown>` every other surface uses — so the guide cannot render
 * anything a handoff could not.
 *
 * `GUIDE_SECTIONS` in `shared/route-meta.js` is the frozen vocabulary; this
 * module supplies a title, a one-line lede and the body for each id. A client
 * test asserts the two agree in **both** directions, so a section added to the
 * shared list without content — or content with no route — fails rather than
 * rendering an empty tab.
 */

import { GUIDE_SECTIONS } from '@shared/route-meta.js';
import concepts from '@/content/guide/concepts.md?raw';
import running from '@/content/guide/running.md?raw';
import autopilot from '@/content/guide/autopilot.md?raw';
import sessions from '@/content/guide/sessions.md?raw';
import notifications from '@/content/guide/notifications.md?raw';
import permissions from '@/content/guide/permissions.md?raw';
import mobile from '@/content/guide/mobile.md?raw';
import troubleshooting from '@/content/guide/troubleshooting.md?raw';
import reference from '@/content/guide/reference.md?raw';

export interface GuideSection {
  id: string;
  /** The tab's word. Short — it has to survive a 390px tab strip. */
  label: string;
  /** One line, under the heading. */
  lede: string;
  body: string;
}

export const SECTIONS: readonly GuideSection[] = [
  {
    id: 'concepts',
    label: 'Concepts',
    lede: 'What a plan is, and the two parts of it a machine reads.',
    body: concepts,
  },
  {
    id: 'running',
    label: 'Running',
    lede: 'Opening the console, starting a run, and what one phase actually does.',
    body: running,
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    lede: 'Answering what needs you, what “verified” means, and the verbs for a phase that stalled.',
    body: autopilot,
  },
  {
    id: 'sessions',
    label: 'Sessions',
    lede: 'Work that outlives the browser — plus the recovery and QA sessions the console starts for you, and the shutdown button.',
    body: sessions,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    lede: 'One switch per category, governing every way a message could reach you — and how the inbox gets back to zero.',
    body: notifications,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    lede: 'Which layer actually stops an unattended run — and which one fails open.',
    body: permissions,
  },
  {
    id: 'mobile',
    label: 'Mobile setup',
    lede: 'Reaching the console from a phone, end to end, with nothing on the public internet.',
    body: mobile,
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    lede: 'The four ways a run comes to rest, and the things that look broken and are not.',
    body: troubleshooting,
  },
  {
    id: 'reference',
    label: 'Reference',
    lede: 'Gate syntax, console flags, where files live, and the scripts behind all of it.',
    body: reference,
  },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/** The default section, and the fallback for an unknown one. */
export const DEFAULT_SECTION = GUIDE_SECTIONS[0];

export function resolveSection(id: string | undefined): GuideSection {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_SECTION)!;
}

export const sectionIds: readonly string[] = SECTIONS.map((s) => s.id);
