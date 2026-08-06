/**
 * The splitter loses nothing and invents nothing.
 *
 * The centrepiece is the round-trip: reassembling every real section from its
 * own outline has to reproduce the source. That is a far stronger statement than
 * any count of cards, and it is the one that makes it safe to restructure ~800
 * lines of prose — a heading eaten by a bad fence guard, a body truncated at the
 * wrong boundary, or a group's intro swallowed by its first child all fail here
 * rather than in a reader's face.
 *
 * Everything else is asserted against SYNTHETIC fixtures, deliberately: a test
 * that names a real heading turns editing prose into breaking the build, which
 * is exactly the coupling `split.ts` exists to avoid.
 */

import { describe, expect, it } from 'vitest';
import { SECTIONS } from './sections';
import { cardsOf, slug, splitGuide } from './split';

/** Trailing whitespace and blank-line runs are not content. */
const norm = (text: string) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n');

function reassemble(markdown: string): string {
  const outline = splitGuide(markdown);
  const parts: string[] = [outline.intro];
  for (const group of outline.groups) {
    if (group.banded) parts.push(group.heading, group.intro);
    for (const card of group.cards) parts.push(card.heading, card.body);
  }
  return parts.join('\n');
}

describe('the outline is lossless', () => {
  it('reassembles every guide section byte-for-byte', () => {
    for (const section of SECTIONS) {
      expect(norm(reassemble(section.body)), section.id).toBe(norm(section.body));
    }
  });

  it('gives every section at least two cards', () => {
    // The point of the refactor. A section that still splits into one card is a
    // section whose headings did not survive the rewrite.
    for (const section of SECTIONS) {
      expect(cardsOf(splitGuide(section.body)).length, section.id).toBeGreaterThan(1);
    }
  });

  it('gives every card a non-empty id and title', () => {
    for (const section of SECTIONS) {
      for (const card of cardsOf(splitGuide(section.body))) {
        expect(card.id, `${section.id}: empty id`).toBeTruthy();
        expect(card.title.trim(), `${section.id}/${card.id}: empty title`).toBeTruthy();
      }
    }
  });

  it('keeps card ids unique within a section', () => {
    for (const section of SECTIONS) {
      const ids = cardsOf(splitGuide(section.body)).map((c) => c.id);
      expect(new Set(ids).size, section.id).toBe(ids.length);
    }
  });
});

describe('the cutting rule', () => {
  it('treats the shallowest level present as the group level', () => {
    const flat = splitGuide('## One\na\n\n## Two\nb');
    expect(flat.groups.map((g) => g.title)).toEqual(['One', 'Two']);
    expect(flat.groups.every((g) => !g.banded)).toBe(true);
    expect(flat.groups[0].cards[0].body).toBe('a');

    // The same file promoted a level reads identically.
    const promoted = splitGuide('# One\na\n\n# Two\nb');
    expect(promoted.groups.map((g) => g.title)).toEqual(['One', 'Two']);
  });

  it('bands a group that has children, and keeps its intro', () => {
    const outline = splitGuide('## Group\nlede prose\n\n### First\na\n\n### Second\nb');
    expect(outline.groups).toHaveLength(1);
    const [group] = outline.groups;
    expect(group.banded).toBe(true);
    expect(group.intro).toBe('lede prose');
    expect(group.cards.map((c) => c.title)).toEqual(['First', 'Second']);
    expect(group.cards[0].body).toBe('a');
  });

  it('leaves headings deeper than card level inside the body', () => {
    const outline = splitGuide('## G\n\n### Card\nbefore\n\n#### Deep\nafter');
    expect(outline.groups[0].cards).toHaveLength(1);
    expect(outline.groups[0].cards[0].body).toContain('#### Deep');
  });

  it('does not let a child leak past the end of its group', () => {
    const outline = splitGuide('## A\n\n### A1\nfirst\n\n## B\nsecond');
    expect(outline.groups.map((g) => g.title)).toEqual(['A', 'B']);
    expect(outline.groups[0].cards[0].body).toBe('first');
    expect(outline.groups[1].cards[0].body).toBe('second');
  });

  it('ignores a heading inside a fence', () => {
    // The real shape: `mobile.md` has `# ~/.local/bin/phase-notify` in a shell
    // block. Read as structure it invents a section and truncates this one.
    const outline = splitGuide('## Real\n\n```bash\n# ~/.local/bin/phase-notify\necho hi\n```\n\ntail');
    expect(outline.groups).toHaveLength(1);
    expect(outline.groups[0].cards[0].body).toContain('# ~/.local/bin/phase-notify');
    expect(outline.groups[0].cards[0].body).toContain('tail');
  });

  it('does not end a ``` fence on a ~~~ line', () => {
    const outline = splitGuide('## Real\n\n```\n~~~\n## Not a heading\n```\n');
    expect(outline.groups).toHaveLength(1);
  });

  it('keeps prose before the first heading as the outline intro', () => {
    const outline = splitGuide('opening line\n\n## One\na');
    expect(outline.intro).toBe('opening line');
    expect(outline.groups).toHaveLength(1);
  });

  it('is total on degenerate input', () => {
    for (const input of ['', '   ', 'no headings at all', undefined]) {
      const outline = splitGuide(input);
      expect(outline.groups).toEqual([]);
    }
    expect(splitGuide('prose only').intro).toBe('prose only');
  });
});

describe('bulky', () => {
  it('marks a card that is mostly one long fenced block', () => {
    const prompt = ['## Paste this', 'One sentence of setup.', '', '```', ...Array(24).fill('a line of prompt'), '```'].join('\n');
    expect(splitGuide(prompt).groups[0].cards[0].bulky).toBe(true);
  });

  it('leaves a short example open', () => {
    const short = ['## Run it', 'Some prose.', '', '```bash', './start', '```', '', 'More prose.'].join('\n');
    expect(splitGuide(short).groups[0].cards[0].bulky).toBe(false);
  });

  it('leaves long prose with one small snippet open', () => {
    const prose = ['## Long', ...Array(24).fill('a sentence of prose.'), '', '```', 'x', '```'].join('\n');
    expect(splitGuide(prose).groups[0].cards[0].bulky).toBe(false);
  });
});

describe('what a heading says about itself', () => {
  it('lifts the ordinal the prose already carries', () => {
    const outline = splitGuide('## Stop 2½ · Give yourself a launcher\na');
    const [card] = outline.groups[0].cards;
    expect(card.marker).toEqual({ word: 'Stop', n: '2½' });
    expect(card.title).toBe('Give yourself a launcher');
    // The id still comes from the RAW heading, so a `?card=` link written
    // against the visible text keeps working.
    expect(card.id).toBe('stop-2-give-yourself-a-launcher');
  });

  it('lifts the actor glyph and strips it from the title', () => {
    const machine = splitGuide('## Each phase runs alone \u{1F7E2}\na').groups[0].cards[0];
    expect(machine.actor).toBe('machine');
    expect(machine.title).toBe('Each phase runs alone');

    const person = splitGuide('## \u{1F7E1} Write the plan\na').groups[0].cards[0];
    expect(person.actor).toBe('person');
    expect(person.title).toBe('Write the plan');
  });

  it('leaves a plain heading entirely alone', () => {
    const card = splitGuide('## Just a heading\na').groups[0].cards[0];
    expect(card.marker).toBeUndefined();
    expect(card.actor).toBeUndefined();
    expect(card.title).toBe('Just a heading');
  });

  it('flattens emphasis in the title', () => {
    expect(splitGuide('## The `--allow-run` switch\na').groups[0].cards[0].title)
      .toBe('The --allow-run switch');
  });

  it('never yields an empty id or title, however odd the heading', () => {
    const card = splitGuide('## \u{1F7E2}\na').groups[0].cards[0];
    expect(card.id).toBeTruthy();
    expect(card.title).toBeTruthy();
  });

  it('deduplicates colliding slugs rather than shadowing a card', () => {
    const outline = splitGuide('## Same\na\n\n## Same\nb');
    expect(outline.groups.map((g) => g.id)).toEqual(['same', 'same-2']);
  });
});

describe('slug', () => {
  it('is ascii, lowercase and trimmed of separators', () => {
    expect(slug('Stop 2½ · Give yourself a launcher')).toBe('stop-2-give-yourself-a-launcher');
    expect(slug('—')).toBe('');
    expect(slug('  Mixed CASE  ')).toBe('mixed-case');
  });
});
