/**
 * AA is a test, not a promise.
 *
 * The status palette in `theme.css` is authored in OKLCH, once per token, as
 * `light-dark(paper, night)`. Nothing in jsdom computes a colour, so this file
 * does the arithmetic itself: OKLCH → OKLab → linear sRGB → relative luminance,
 * then WCAG 2 contrast for every (state, surface) pair in BOTH themes. The
 * thresholds are AA's: 4.5:1 for a status used as text (a badge's label, a
 * state-coloured count) on every surface the app paints on, 3:1 for a status
 * used as a mark (a dot, a strip segment, a station) against the track.
 *
 * The converter is the standard one (Björn Ottosson's OKLab matrices); it is
 * checked against the two `--ground` hexes `index.html` and the manifest carry,
 * which also pins those literals to the token they mirror — the one place a
 * custom property cannot reach.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const THEME = readFileSync(here('./theme.css'), 'utf8');
const INDEX_HTML = readFileSync(here('../../index.html'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(here('../../public/manifest.webmanifest'), 'utf8')) as {
  background_color: string;
  theme_color: string;
};

/* ---------------- the arithmetic ---------------- */

type Oklch = { L: number; C: number; h: number };
type Linear = [number, number, number];

/** OKLCH → linear sRGB (no gamma, unclamped — gamut is asserted separately). */
export function oklchToLinear({ L, C, h }: Oklch): Linear {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function toHex(colour: Oklch): string {
  return `#${oklchToLinear(colour)
    .map((v) =>
      Math.round(gamma(clamp01(v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** WCAG 2.x relative luminance of a linear sRGB triple. */
export const luminance = ([r, g, b]: Linear): number =>
  0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);

/** WCAG 2.x contrast ratio, ≥ 1. */
export function contrast(a: Oklch, b: Oklch): number {
  const [hi, lo] = [luminance(oklchToLinear(a)), luminance(oklchToLinear(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Inside the sRGB cube, with a hair of tolerance for the matrices' rounding. */
export const inGamut = (colour: Oklch): boolean =>
  oklchToLinear(colour).every((v) => v >= -0.0005 && v <= 1.0005);

/* ---------------- reading the stylesheet ---------------- */

const OKLCH_RE = /oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+%?)?\)/g;

/** `--token: light-dark(oklch(…), oklch(…))` → both themes, or null. */
function pair(token: string): { paper: Oklch; night: Oklch } | null {
  const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`));
  if (!line) return null;
  const colours = [...line.matchAll(OKLCH_RE)].map(([, L, C, h]) => ({
    L: Number(L) / 100,
    C: Number(C),
    h: Number(h),
  }));
  if (colours.length !== 2) return null;
  return { paper: colours[0], night: colours[1] };
}

const STATES = ['done', 'running', 'verifying', 'queued', 'waiting', 'needs-you', 'failed', 'skipped'];
/** Every surface a status may be painted ON as text. */
const TEXT_SURFACES = ['--ground', '--ground-deep', '--surface', '--surface-raised'];
/** What a status mark sits against when it is a dot, a segment or a station. */
const MARK_SURFACES = ['--track'];

const THEMES = ['paper', 'night'] as const;

/* ---------------- the assertions ---------------- */

describe('the converter', () => {
  it('reproduces the two ground hexes the document and the manifest carry', () => {
    // These literals are the one place a token cannot reach; if the ground
    // moves, the browser chrome and the splash must move with it.
    const ground = pair('--ground')!;
    expect(INDEX_HTML).toContain(`media="(prefers-color-scheme: dark)" content="${toHex(ground.night)}"`);
    expect(INDEX_HTML).toContain(`media="(prefers-color-scheme: light)" content="${toHex(ground.paper)}"`);
    expect(MANIFEST.theme_color).toBe(toHex(ground.night));
    expect(MANIFEST.background_color).toBe(toHex(ground.night));
  });

  it('agrees with WCAG on black and white', () => {
    expect(contrast({ L: 1, C: 0, h: 0 }, { L: 0, C: 0, h: 0 })).toBeCloseTo(21, 1);
    expect(toHex({ L: 1, C: 0, h: 0 })).toBe('#ffffff');
    expect(toHex({ L: 0, C: 0, h: 0 })).toBe('#000000');
  });
});

describe('the status palette clears AA in both themes', () => {
  const surfaces = Object.fromEntries(
    [...TEXT_SURFACES, ...MARK_SURFACES].map((token) => [token, pair(token)]),
  ) as Record<string, { paper: Oklch; night: Oklch }>;

  for (const token of [...TEXT_SURFACES, ...MARK_SURFACES]) {
    it(`${token} is a light-dark(oklch, oklch) pair`, () => {
      expect(surfaces[token], token).toBeTruthy();
    });
  }

  for (const state of STATES) {
    const token = `--status-${state}`;
    const colours = pair(token);

    it(`${token} is declared as a light-dark(oklch, oklch) pair and stays inside sRGB`, () => {
      expect(colours, token).toBeTruthy();
      for (const theme of THEMES) {
        expect(
          inGamut(colours![theme]),
          `${token} (${theme}) is outside the sRGB gamut — the browser would clip it`,
        ).toBe(true);
      }
    });

    for (const theme of THEMES) {
      for (const surface of TEXT_SURFACES) {
        it(`${state} as text on ${surface} (${theme}) ≥ 4.5:1`, () => {
          const ratio = contrast(colours![theme], surfaces[surface][theme]);
          expect(ratio, `${token} on ${surface} in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            4.5,
          );
        });
      }
      for (const surface of MARK_SURFACES) {
        it(`${state} as a mark against ${surface} (${theme}) ≥ 3:1`, () => {
          const ratio = contrast(colours![theme], surfaces[surface][theme]);
          expect(
            ratio,
            `${token} against ${surface} in ${theme}: ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }

  it('keeps the ink readable on every surface, both themes', () => {
    // Not a status, but the same promise: the body text and the muted text
    // must clear AA wherever they land. Faint ink is metadata and is held to
    // the large-text floor.
    const ink = pair('--ink')!;
    const muted = pair('--ink-muted')!;
    const faint = pair('--ink-faint')!;
    for (const theme of THEMES) {
      for (const surface of TEXT_SURFACES) {
        expect(
          contrast(ink[theme], surfaces[surface][theme]),
          `ink on ${surface} ${theme}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(muted[theme], surfaces[surface][theme]),
          `ink-muted on ${surface} ${theme}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(faint[theme], surfaces[surface][theme]),
          `ink-faint on ${surface} ${theme}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
