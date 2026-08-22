/**
 * A guide section's markdown, cut into cards.
 *
 * The guide used to render one file as one undivided column, which is how
 * `mobile.md` became 192 lines of continuous scroll and `reference.md` ~90 table
 * rows under a single heading. Cards fix that — but only if the cutting rule
 * survives someone editing the prose, because the whole reason the content lives
 * in markdown (see `sections.ts`) is that editing a sentence must not be editing
 * a component.
 *
 * So the rule names no heading, expects no count, and hard-codes no level:
 *
 *   **The shallowest heading level present in the file is the GROUP level.
 *   One deeper is the CARD level. Anything deeper stays inside a card's body.**
 *
 * That single sentence handles all three shapes the nine files actually have — a
 * flat file of `##`, a file of `##` with some `###` children, and `mobile.md`'s
 * one `##` carrying nine `###` — without knowing which is which. Promote every
 * heading a level, add a tenth step, demote a table: the outline still comes out
 * right. A group with no children becomes a single card carrying its own prose,
 * so a flat file is not a special case, it is the general case with one child.
 *
 * Fence-awareness is not a nicety. `mobile.md` has `# ~/.local/bin/phase-notify`
 * inside a shell block; a splitter that reads that as structure invents a
 * section and truncates the one it was in.
 *
 * `marker` and `actor` are DERIVED, never configured. Fifteen headings already
 * carry `Stop 2½ ·` or `Step 4 ·`, and `concepts.md` already declares a green /
 * yellow legend for "the machine does this" versus "you do this". Reading what
 * the prose already says beats a registry that has to be kept in step with it.
 */

// From `lib/plain-text`, NOT from `components/markdown`'s re-export of it —
// that re-export pulls `marked` (≈40 KB gz) in behind it, which is the trap
// `lib/plain-text.ts`'s own header exists to prevent. It costs nothing today
// because `section.tsx` (this module's only importer) is behind the help
// sheet's `lazy()`; it would cost 40 KB of entry the day anything on a page
// imports the splitter.
import { plainText } from '@/lib/plain-text';

/** Who moves next — the distinction `concepts.md` calls the hardest to hold. */
export type Actor = 'machine' | 'person';

/** The ordinal the prose already carries: `Stop 2½ ·`, `Step 4 ·`. */
export interface Marker {
  word: string;
  n: string;
}

export interface GuideCard {
  /** Slug of the raw heading, deduped within its section. The `?card=` handle. */
  id: string;
  /** The heading LINE, verbatim. What makes the round-trip test exact. */
  heading: string;
  /** Heading text with the marker prefix and actor glyph removed. */
  title: string;
  marker?: Marker;
  actor?: Actor;
  /** The source under the heading, verbatim but for outer trimming. */
  body: string;
  /**
   * A card that is mostly one long code block — a paste-this-into-Claude prompt,
   * a config file. Derived rather than configured, because the property that
   * makes these start collapsed is a fact about the body, not an editorial
   * opinion someone has to remember to record in a registry. They are material
   * you copy, not prose you read, and open by default they dominate the page.
   */
  bulky: boolean;
}

export interface GuideGroup extends Omit<GuideCard, 'body' | 'bulky'> {
  /** True when the heading had children — the renderer draws a band for it. */
  banded: boolean;
  /** The group's own prose above its first child. `''` when not banded. */
  intro: string;
  /** Never empty. */
  cards: GuideCard[];
}

export interface GuideOutline {
  /** Anything before the first heading. `''` in all ten files today. */
  intro: string;
  groups: GuideGroup[];
}

interface RawHeading {
  line: number;
  level: number;
  text: string;
  raw: string;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const MARKER = /^(Stop|Step)\s+(\S+)\s*·\s*/;

/** The legend `concepts.md` declares, read back off the headings that use it. */
const ACTOR_GLYPH: [string, Actor][] = [
  ['\u{1F7E2}', 'machine'],
  ['\u{1F7E1}', 'person'],
];

/**
 * Heading lines only. A `#` inside a fence is shell, not structure — and the
 * closing fence has to match the marker that opened it, or a `~~~` inside a
 * ``` block would end it early.
 */
function scan(lines: string[]): RawHeading[] {
  const found: RawHeading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const opened = FENCE.exec(lines[i]);
    if (opened) {
      if (fence === null) fence = opened[1];
      else if (lines[i].trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const head = HEADING.exec(lines[i]);
    if (head) found.push({ line: i, level: head[1].length, text: head[2].trim(), raw: lines[i] });
  }
  return found;
}

/**
 * Is this body mostly one big fenced block?
 *
 * The threshold is deliberately blunt — a card is bulky when it is long enough
 * to dominate a screen AND more than half of it is inside fences. A short
 * example under two paragraphs of prose stays open; a 27-line setup prompt with
 * one sentence above it does not.
 */
function isBulky(body: string): boolean {
  const lines = body.split('\n');
  if (lines.length < 18) return false;
  let fence: string | null = null;
  let fenced = 0;
  for (const line of lines) {
    const opened = FENCE.exec(line);
    if (opened) {
      fenced++;
      if (fence === null) fence = opened[1];
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) fenced++;
  }
  return fenced * 2 > lines.length;
}

/** `Stop 2½ · Give yourself a launcher` → `stop-2-give-yourself-a-launcher`. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unique(base: string, used: Set<string>): string {
  const stem = base || 'card';
  let id = stem;
  for (let n = 2; used.has(id); n++) id = `${stem}-${n}`;
  used.add(id);
  return id;
}

/** The facts a heading carries about itself. */
function read(head: RawHeading, used: Set<string>): Omit<GuideCard, 'body' | 'bulky'> {
  let text = head.text;
  let actor: Actor | undefined;
  for (const [glyph, who] of ACTOR_GLYPH) {
    if (text.includes(glyph)) {
      actor = who;
      text = text.split(glyph).join('').trim();
    }
  }
  const marked = MARKER.exec(text);
  if (marked) text = text.slice(marked[0].length).trim();
  return {
    id: unique(slug(head.text), used),
    heading: head.raw,
    // `plainText` flattens `*(optional)*` synchronously, so a card's accessible
    // name never waits on an effect the way rendered markdown does.
    title: plainText(text) || plainText(head.text) || 'Untitled',
    ...(marked ? { marker: { word: marked[1], n: marked[2] } } : {}),
    ...(actor ? { actor } : {}),
  };
}

export function splitGuide(markdown: string | undefined): GuideOutline {
  const source = String(markdown ?? '');
  const lines = source.split('\n');
  const heads = scan(lines);
  if (!heads.length) return { intro: source.trim(), groups: [] };

  const groupLevel = Math.min(...heads.map((h) => h.level));
  const cardLevel = groupLevel + 1;
  const slice = (from: number, to: number) => lines.slice(from, to).join('\n').trim();
  const used = new Set<string>();
  const groups: GuideGroup[] = [];

  for (let i = 0; i < heads.length; i++) {
    if (heads[i].level !== groupLevel) continue;
    const nextGroup = heads.findIndex((h, j) => j > i && h.level <= groupLevel);
    const end = nextGroup === -1 ? lines.length : heads[nextGroup].line;
    const kids = heads.filter(
      (h, j) => j > i && (nextGroup === -1 || j < nextGroup) && h.level === cardLevel,
    );
    const facts = read(heads[i], used);

    if (!kids.length) {
      const body = slice(heads[i].line + 1, end);
      groups.push({
        ...facts,
        banded: false,
        intro: '',
        cards: [{ ...facts, body, bulky: isBulky(body) }],
      });
      continue;
    }

    groups.push({
      ...facts,
      banded: true,
      intro: slice(heads[i].line + 1, kids[0].line),
      cards: kids.map((kid) => {
        const after = heads.find((h) => h.line > kid.line && h.level <= cardLevel);
        const body = slice(kid.line + 1, Math.min(after?.line ?? lines.length, end));
        return { ...read(kid, used), body, bulky: isBulky(body) };
      }),
    });
  }

  return { intro: slice(0, heads[0].line), groups };
}

/** Every card of an outline, in reading order. */
export function cardsOf(outline: GuideOutline): GuideCard[] {
  return outline.groups.flatMap((g) => g.cards);
}
