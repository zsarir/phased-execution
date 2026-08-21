/**
 * The theme guard.
 *
 * Two things rot silently in a token system: a fourth breakpoint appearing
 * because someone needed "just one" media query, and a token being renamed out
 * from under the components that use it. The old stylesheet had five
 * breakpoints (640, 780, 900, 1180, 1200), no two of which agreed on what a
 * small screen was. This test is what keeps that from happening again — and,
 * since 3.0, what keeps the status palette a closed set of eight, the accent a
 * single amber, the type floor at 12 px and the fonts the four vendored files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BP_PHONE, BP_SHELL, BP_WIDE } from '@/lib/media';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('..');
const THEME = readFileSync(here('./theme.css'), 'utf8');

/** The only widths this design is allowed to branch on. */
const ALLOWED = [640, 900, 1200];

/** The eight UI states of `shared/status-vocab.js`, as the palette names them. */
const STATUS_TOKENS = [
  '--status-done', '--status-running', '--status-verifying', '--status-queued',
  '--status-waiting', '--status-needs-you', '--status-failed', '--status-skipped',
];

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
      ...STATUS_TOKENS,
      '--accent', '--action', '--focus', '--shadow-card', '--glow-action',
      '--font-sans', '--font-display', '--font-mono',
      '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl',
      '--tap-min', '--text-input', '--app-height',
      '--z-base', '--z-sticky', '--z-shell', '--z-scrim', '--z-toast',
      '--rail-width', '--content-max',
    ];
    const missing = required.filter((token) => !new RegExp(`\\${token}:`).test(THEME));
    expect(missing, `undeclared: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines each colour once, for both themes at the same time', () => {
    // The old file wrote the light palette twice on top of the dark one and the
    // three copies had already drifted (`--line-waiting` was missing from one).
    // `light-dark()` makes a second definition unnecessary — and a duplicate
    // here means someone started a fourth copy.
    for (const token of [...STATUS_TOKENS, '--ground', '--ground-deep', '--surface', '--surface-raised', '--ink', '--track']) {
      const declarations = [...THEME.matchAll(new RegExp(`^\\s*\\${token}:`, 'gm'))];
      expect(declarations.length, `${token} declared ${declarations.length}x`).toBe(1);
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      expect(line, `${token} should carry both themes`).toContain('light-dark(');
    }
  });

  it('holds the status palette at one OKLCH weight per theme', () => {
    // Equal weight is the design rule: no state shouts louder than another by
    // accident. Every chromatic state shares one L/C pair per theme; the two
    // neutrals (queued, skipped) keep the lightness and drop the chroma.
    const weights = new Map<string, { paper: string; night: string }>();
    for (const token of STATUS_TOKENS) {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      const match = /light-dark\(oklch\(([\d.]+%) ([\d.]+) [\d.]+\), oklch\(([\d.]+%) ([\d.]+) [\d.]+\)\)/.exec(line);
      expect(match, `${token} is not a light-dark(oklch, oklch) pair`).toBeTruthy();
      const [, paperL, paperC, nightL, nightC] = match!;
      weights.set(token, { paper: `${paperL} ${paperC}`, night: `${nightL} ${nightC}` });
      expect(paperL, `${token} paper lightness`).toBe(weights.get(STATUS_TOKENS[0])!.paper.split(' ')[0]);
      expect(nightL, `${token} night lightness`).toBe(weights.get(STATUS_TOKENS[0])!.night.split(' ')[0]);
    }
    const chromatic = STATUS_TOKENS.filter((t) => t !== '--status-queued' && t !== '--status-skipped');
    const paperC = new Set(chromatic.map((t) => weights.get(t)!.paper));
    const nightC = new Set(chromatic.map((t) => weights.get(t)!.night));
    expect([...paperC], 'one paper L/C for every chromatic state').toHaveLength(1);
    expect([...nightC], 'one night L/C for every chromatic state').toHaveLength(1);
  });

  it('reserves amber for the thing that needs a person', () => {
    // `--accent` is the semantic name; the action colour and the focus ring are
    // it, and it is the needs-you state. A component that wants "do this now"
    // asks for `--action`; nothing asks for the amber literal.
    expect(THEME).toMatch(/--accent:\s*var\(--status-needs-you\)/);
    expect(THEME).toMatch(/--action:\s*var\(--accent\)/);
    expect(THEME).toMatch(/--focus:\s*var\(--accent\)/);
    // Only one token may sit at the amber hue: every other hue in the palette
    // is at least 40° away, so no second state can be mistaken for the accent.
    const hues = STATUS_TOKENS.map((token) => {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      return { token, hue: Number(/oklch\([\d.]+% [\d.]+ ([\d.]+)\)/.exec(line)?.[1]) };
    });
    const amber = hues.find((h) => h.token === '--status-needs-you')!.hue;
    for (const { token, hue } of hues) {
      if (token === '--status-needs-you') continue;
      expect(Math.abs(hue - amber), `${token} sits too close to the amber hue`).toBeGreaterThanOrEqual(40);
    }
  });

  it('keeps the legacy 2.x tokens as aliases, never as a second palette', () => {
    // The views that predate the vocabulary still paint with `--line-*` and
    // `.state-ready` & co. Until Phase 11 deletes them they must resolve — to
    // the vocabulary's own tokens, not to a literal that could drift from it.
    for (const legacy of ['--line-done', '--line-ready', '--line-progress', '--line-waiting', '--line-blocked', '--line-stuck', '--line-gated']) {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${legacy}:`)) ?? '';
      expect(line, `${legacy} must alias a --status-* token`).toMatch(/var\(--status-[a-z-]+\)/);
    }
    for (const cls of ['state-ready', 'state-in-progress', 'state-blocked', 'state-stuck', 'state-gated']) {
      expect(THEME, `.${cls} must alias a --status-* token`).toMatch(new RegExp(`\\.${cls}\\s*\\{\\s*--state:\\s*var\\(--status-[a-z-]+\\)`));
    }
  });

  it('sets a .state-<ui> class for each of the eight UI states', () => {
    for (const token of STATUS_TOKENS) {
      const ui = token.replace('--status-', '');
      expect(THEME, `.state-${ui}`).toMatch(new RegExp(`\\.state-${ui}\\s*\\{\\s*--state:\\s*var\\(${token}\\)`));
    }
  });

  it('sets the type floor at 12 px and lifts the reading sizes', () => {
    const sizes = Object.fromEntries(
      [...THEME.matchAll(/--text-(2xs|xs|sm|md):\s*([\d.]+)rem/g)].map(([, k, v]) => [k, Number(v)]),
    );
    expect(sizes).toEqual({ '2xs': 0.75, xs: 0.8125, sm: 0.875, md: 0.9375 });
    // Nothing in the stylesheet is set below the floor.
    const rems = [...THEME.matchAll(/--text-[\w-]+:\s*([\d.]+)rem/g)].map(([, v]) => Number(v));
    expect(Math.min(...rems)).toBeGreaterThanOrEqual(0.75);
    // Tabular figures are the body's default, and `.tnum` exists for opt-back-in.
    expect(THEME).toMatch(/body\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
    expect(THEME).toMatch(/@utility tnum\s*\{\s*font-variant-numeric:\s*tabular-nums/);
  });

  it('vendors IBM Plex as exactly four woff2 files and nothing else', () => {
    const fonts = readdirSync(here('../assets/fonts')).filter((f) => f.endsWith('.woff2')).sort();
    expect(fonts).toEqual([
      'ibm-plex-mono-400.woff2', 'ibm-plex-mono-500.woff2',
      'ibm-plex-sans-condensed-600.woff2', 'ibm-plex-sans-var.woff2',
    ]);
    // Every @font-face points at one of them, and every one is pointed at.
    const referenced = [...THEME.matchAll(/url\('\.\.\/assets\/fonts\/([\w.-]+\.woff2)'\)/g)].map(([, f]) => f).sort();
    expect(referenced).toEqual(fonts);
    for (const f of fonts) expect(existsSync(here(`../assets/fonts/${f}`))).toBe(true);
    // The families the tokens name are the families the faces declare.
    expect(THEME).toMatch(/--font-sans:\s*'IBM Plex Sans'/);
    expect(THEME).toMatch(/--font-display:\s*'IBM Plex Sans Condensed'/);
    expect(THEME).toMatch(/--font-mono:\s*'IBM Plex Mono'/);
    // Ligatures are off in the mono utility itself, not only on `code`.
    expect(THEME).toMatch(/--font-mono--font-feature-settings:\s*'liga' 0, 'calt' 0/);
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
