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
 * module supplies a title, a one-line lede and a shape for each id, and
 * `bodies.ts` supplies the prose. A client test asserts all three agree, so a
 * section added to the shared list without content — or content with no route
 * — fails rather than rendering an empty tab.
 *
 * The split is a budget decision, not a tidiness one: the help sheet is mounted
 * in the composition root, so anything this module imports is in the ENTRY
 * chunk. The eleven `?raw` bodies are ~40 KB of string nobody reads until they
 * open the guide.
 */

import { GUIDE_SECTIONS } from '@shared/route-meta.js';

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
}

export const SECTIONS: readonly GuideSection[] = [
  {
    id: 'concepts',
    label: 'Concepts',
    lede: 'What a plan is, the two lines a machine reads, and who does which part.',
    kind: 'route',
  },
  {
    id: 'running',
    label: 'Launch',
    lede: 'Every way to start the console — and the five switches that decide what it may do.',
    // A menu, not a journey: you pick ONE of these ways in, you do not walk
    // them in order.
    kind: 'topic',
  },
  {
    id: 'run',
    label: 'Runs',
    lede: 'Starting a run, what one phase actually does, and how to watch, ask, pause or stop it.',
    kind: 'route',
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    lede: 'Answering what needs you, what “verified” means, and the verbs for a phase that stalled.',
    kind: 'topic',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    lede: 'Work that outlives the browser — plus the recovery and QA sessions the console starts for you, and the shutdown button.',
    kind: 'topic',
  },
  {
    id: 'notifications',
    label: 'Alerts',
    lede: 'One switch per category, governing every way a message could reach you — and how the inbox gets back to zero.',
    kind: 'topic',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    lede: 'Which layer actually stops an unattended run — and which one fails open.',
    kind: 'topic',
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    lede: 'Attaching tools to a plan, and finding out they are signed in before an hour is spent.',
    kind: 'topic',
  },
  {
    id: 'mobile',
    label: 'Mobile setup',
    lede: 'Reaching the console from a phone, end to end, with nothing on the public internet.',
    kind: 'route',
  },
  {
    id: 'troubleshooting',
    label: 'When stuck',
    lede: 'The four ways a run comes to rest, and the things that look broken and are not.',
    kind: 'topic',
  },
  {
    id: 'reference',
    label: 'Reference',
    lede: 'Flags, environment, verbs, gates, paths, and every status word the console can show you.',
    kind: 'topic',
  },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/** The default section, and the fallback for an unknown one. */
export const DEFAULT_SECTION = GUIDE_SECTIONS[0];

export function resolveSection(id: string | undefined): GuideSection {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_SECTION)!;
}

export const sectionIds: readonly string[] = SECTIONS.map((s) => s.id);
