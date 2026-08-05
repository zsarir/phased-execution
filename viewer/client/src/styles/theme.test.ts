/**
 * The theme guard.
 *
 * Two things rot silently in a token system: a fourth breakpoint appearing
 * because someone needed "just one" media query, and a token being renamed out
 * from under the components that use it. The old stylesheet had five
 * breakpoints (640, 780, 900, 1180, 1200), no two of which agreed on what a
 * small screen was. This test is what keeps that from happening again.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BP_PHONE, BP_SHELL, BP_WIDE } from '@/lib/media';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('..');
const THEME = readFileSync(here('./theme.css'), 'utf8');

/** The only widths this design is allowed to branch on. */
const ALLOWED = [640, 900, 1200];

/** Shipped source only — a test may name a width in order to reject it. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('theme tokens', () => {
  it('declares exactly three breakpoints, at 640/900/1200', () => {
    const declared = [...THEME.matchAll(/--breakpoint-([\w-]+):\s*(\d+)px/g)]
      .map(([, name, value]) => ({ name, value: Number(value) }));
    expect(declared.map((b) => b.value)).toEqual(ALLOWED);
    // Tailwind's own sm/md/lg/xl/2xl must be cleared, or there are eight.
    expect(THEME).toMatch(/--breakpoint-\*:\s*initial/);
  });

  it('keeps the media.ts constants in step with the stylesheet', () => {
    // A media query cannot read a custom property, so these live in two places
    // by necessity. This is the assertion that makes that survivable.
    const doc = Object.fromEntries(
      [...THEME.matchAll(/--bp-(phone|shell|wide):\s*(\d+)px/g)].map(([, k, v]) => [k, Number(v)]),
    );
    expect(doc).toEqual({ phone: BP_PHONE, shell: BP_SHELL, wide: BP_WIDE });
    expect([BP_PHONE, BP_SHELL, BP_WIDE]).toEqual(ALLOWED);
  });

  it('declares every token the components paint with', () => {
    const required = [
      '--ground', '--ground-deep', '--surface', '--surface-raised', '--rule', '--rule-strong',
      '--ink', '--ink-muted', '--ink-faint', '--track', '--hatch',
      '--line-done', '--line-ready', '--line-progress', '--line-waiting',
      '--line-blocked', '--line-stuck', '--line-gated',
      '--action', '--focus', '--shadow-card', '--glow-action',
      '--tap-min', '--text-input',
      '--z-base', '--z-sticky', '--z-shell', '--z-scrim', '--z-toast',
      '--rail-width', '--content-max',
    ];
    const missing = required.filter((token) => !new RegExp(`\\${token}:`).test(THEME));
    expect(missing, `undeclared: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines each state colour once, for both themes at the same time', () => {
    // The old file wrote the light palette twice on top of the dark one and the
    // three copies had already drifted (`--line-waiting` was missing from one).
    // `light-dark()` makes a second definition unnecessary — and a duplicate
    // here means someone started a fourth copy.
    for (const token of ['--line-done', '--line-ready', '--line-waiting', '--line-stuck', '--ground', '--ink']) {
      const declarations = [...THEME.matchAll(new RegExp(`^\\s*\\${token}:`, 'gm'))];
      expect(declarations.length, `${token} declared ${declarations.length}x`).toBe(1);
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      expect(line, `${token} should carry both themes`).toContain('light-dark(');
    }
  });

  it('reserves amber for the actionable thing', () => {
    // `--action` is the semantic name. A component that wants "do this now"
    // asks for it; nothing asks for the amber literal, and nothing but a phase
    // state asks for `--line-ready`.
    expect(THEME).toMatch(/--action:\s*var\(--line-ready\)/);
    expect(THEME).toMatch(/--focus:\s*var\(--action\)/);
  });
});

/**
 * Three phone defects, each of which was one declaration, and each of which
 * made a page unusable rather than untidy. They are asserted here because the
 * fix is a stylesheet line with nothing else to hold it in place.
 */
describe('the phone holds together', () => {
  const ROUTE_MAP = readFileSync(here('./route-map.css'), 'utf8');

  it('lets a long path in a sentence wrap instead of widening the page', () => {
    // The skill directory printed on Settings is one unbreakable word 91px
    // wider than the phone, and it took the tab bar sideways with it.
    expect(THEME).toMatch(/:not\(pre\)\s*>\s*code[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    // …and a block of shell still scrolls inside itself rather than wrapping.
    expect(THEME).not.toMatch(/\bpre\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('does not bounce a strip of empty ground in under the tab bar', () => {
    expect(THEME).toMatch(/body\s*\{[^}]*overscroll-behavior:\s*none/s);
  });

  it('leaves the vertical swipe to the page, even over the route map', () => {
    // `touch-action: none` gave the map every touch that began inside it, and
    // on a phone the map is half the screen — so the tab could not be scrolled.
    // The map now opens LOCKED (`auto` — every gesture is the page's) and only
    // the unlocked `[data-interactive]` state takes the horizontal gestures,
    // still leaving `pan-y` to the page.
    expect(ROUTE_MAP).toMatch(/\.route-frame\s*\{[^}]*touch-action:\s*auto/s);
    expect(ROUTE_MAP).toMatch(/\.route-frame\[data-interactive\]\s*\{[^}]*touch-action:\s*pan-y/s);
    expect(ROUTE_MAP).not.toMatch(/touch-action:\s*none/s);
  });
});

describe('no stray breakpoints', () => {
  it('branches on no width outside 640/900/1200 anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Plain CSS media queries, and Tailwind's arbitrary-variant forms
      // (`min-[820px]:`, `max-[700px]:`, `[@media(max-width:700px)]:`).
      const widths = [
        ...text.matchAll(/@media[^{]*?(\d+)px/g),
        ...text.matchAll(/(?:min|max)-\[(\d+)px\]/g),
      ].map(([, value]) => Number(value));
      for (const width of widths) {
        // `BP - 1` is how a max-width query expresses "below the breakpoint".
        if (!ALLOWED.includes(width) && !ALLOWED.includes(width + 1)) {
          offenders.push(`src/${file.replace(SRC, '')}: ${width}px`);
        }
      }
    }
    expect(offenders, `stray widths:\n${offenders.join('\n')}`).toEqual([]);
  });
});
