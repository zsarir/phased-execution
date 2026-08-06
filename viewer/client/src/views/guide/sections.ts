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
import run from '@/content/guide/run.md?raw';
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
  /**
   * Whether the cards are a sequence or a set.
   *
   * `route` draws the section as a line — stations on a track, numbered, with a
   * solid station for work the machine does and a ringed one for work that
   * waits for a person. `topic` gets a plain index and a plain stack.
   *
   * The distinction is not decorative: a line over the Reference glossary would
   * claim an order that does not exist, and a reader who trusts it would look
   * for a first step that is not there.
   */
  kind: 'route' | 'topic';
  body: string;
}

export const SECTIONS: readonly GuideSection[] = [
  {
    id: 'concepts',
    label: 'Concepts',
    lede: 'What a plan is, the two lines a machine reads, and who does which part.',
    kind: 'route',
    body: concepts,
  },
  {
    id: 'running',
    label: 'Launch',
    lede: 'Every way to start the console — and the five switches that decide what it may do.',
    // A menu, not a journey: you pick ONE of these ways in, you do not walk
    // them in order.
    kind: 'topic',
    body: running,
  },
  {
    id: 'run',
    label: 'Runs',
    lede: 'Starting a run, what one phase actually does, and how to watch, ask, pause or stop it.',
    kind: 'route',
    body: run,
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    lede: 'Answering what needs you, what “verified” means, and the verbs for a phase that stalled.',
    kind: 'topic',
    body: autopilot,
  },
  {
    id: 'sessions',
    label: 'Sessions',
    lede: 'Work that outlives the browser — plus the recovery and QA sessions the console starts for you, and the shutdown button.',
    kind: 'topic',
    body: sessions,
  },
  {
    id: 'notifications',
    label: 'Alerts',
    lede: 'One switch per category, governing every way a message could reach you — and how the inbox gets back to zero.',
    kind: 'topic',
    body: notifications,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    lede: 'Which layer actually stops an unattended run — and which one fails open.',
    kind: 'topic',
    body: permissions,
  },
  {
    id: 'mobile',
    label: 'Mobile setup',
    lede: 'Reaching the console from a phone, end to end, with nothing on the public internet.',
    kind: 'route',
    body: mobile,
  },
  {
    id: 'troubleshooting',
    label: 'When stuck',
    lede: 'The four ways a run comes to rest, and the things that look broken and are not.',
    kind: 'topic',
    body: troubleshooting,
  },
  {
    id: 'reference',
    label: 'Reference',
    lede: 'Flags, environment, verbs, gates, paths, and every status word the console can show you.',
    kind: 'topic',
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
