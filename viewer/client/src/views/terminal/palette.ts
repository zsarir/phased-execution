/**
 * Colours for a VT.
 *
 * This is the one place in the client where literal colours are correct, and
 * the reason is worth stating: the sixteen ANSI slots are an *addressing
 * scheme*, not a design decision. A program writes `\e[31m` meaning "slot 1",
 * and the emulator decides what slot 1 looks like. There is no design token
 * that can carry that — `--line-blocked` is "a blocked phase", not "red as
 * `ls` means it".
 *
 * Everything that *is* a design decision — the background, the foreground, the
 * cursor, the selection — is read from the live stylesheet instead, so the
 * terminal sits in the same Night or Paper as the page around it.
 */

/** What xterm needs. Declared here so the view does not import xterm's types. */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

/** Night: readable on the deep blue-teal ground, hue-matched to the app. */
const ANSI_NIGHT = {
  black: '#33424b', red: '#ff6b68', green: '#7ec96f', yellow: '#e3b341',
  blue: '#6cb6ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#c9d6dd',
  brightBlack: '#5b6f7a', brightRed: '#ff9492', brightGreen: '#a2e08f', brightYellow: '#f2cc60',
  brightBlue: '#96d0ff', brightMagenta: '#e2c5ff', brightCyan: '#7ce8f0', brightWhite: '#eef4f7',
};

/**
 * Paper: the same hues re-solved for a light ground. xterm's own defaults are
 * built for a dark background — `brightWhite` on Paper would be white on white,
 * and a `ls` listing would lose half its filenames.
 */
const ANSI_PAPER = {
  black: '#1f2b31', red: '#b3211f', green: '#2c6e2a', yellow: '#8a6100',
  blue: '#1b57a8', magenta: '#8b2fa0', cyan: '#0f6b74', white: '#4a5a62',
  brightBlack: '#6a7a82', brightRed: '#d1332f', brightGreen: '#3a8a37', brightYellow: '#a97b00',
  brightBlue: '#2a6fd0', brightMagenta: '#a63cbd', brightCyan: '#15848f', brightWhite: '#20303a',
};

/**
 * The **used** value of a custom property, as sRGB hex.
 *
 * Two conversions, both load-bearing:
 *
 * 1. Every colour in `theme.css` is declared once as `light-dark(paper,
 *    night)`, so reading `--ground` off the element returns that literal
 *    string — the theme resolves at paint time, not at custom-property time.
 *    Painting a probe with it and reading `color` back is what forces it.
 *
 * 2. ⚠️ **What comes back is `oklch(…)`, and xterm cannot parse that.** The
 *    palette is authored in OKLCH and Chrome preserves the colour space in the
 *    computed value, so handing it to xterm silently yields its default black
 *    background — in *both* themes, which reads as "the theme toggle does not
 *    reach the terminal" rather than as a parse failure. A 1×1 canvas is the
 *    conversion: the browser rasterises whatever syntax it understands, and
 *    the pixel that comes back is plain sRGB.
 */
function used(probe: HTMLElement, token: string, fallback: string): string {
  probe.style.color = '';
  probe.style.color = `var(${token})`;
  const value = getComputedStyle(probe).color;
  if (!value || value === 'rgba(0, 0, 0, 0)') return fallback;
  return toHex(value) ?? fallback;
}

/** Rasterise one pixel of `colour` and read it back as `#rrggbb`. */
function toHex(colour: string): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // No canvas (jsdom, a hardened browser): the caller's fallback is a
    // reasonable terminal colour, and a wrong background beats a blank page.
    return null;
  }
}

/** `#rrggbb` → 0–1 relative luminance, near enough for "is this dark". */
function luminance(colour: string): number {
  const hex = colour.replace('#', '');
  if (hex.length < 6) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Read the current theme out of the document.
 *
 * Which palette to use is decided by the ground's *measured* lightness rather
 * than by `data-theme`, because the attribute is absent in `system` mode — and
 * `system` is the default, so keying on the attribute would give every
 * automatic light-mode user the dark ANSI set.
 */
export function xtermTheme(container: HTMLElement): XtermTheme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  container.appendChild(probe);
  try {
    const background = used(probe, '--ground-deep', '#16232a');
    const foreground = used(probe, '--ink', '#e8f1f4');
    const ansi = luminance(background) < 0.5 ? ANSI_NIGHT : ANSI_PAPER;
    return {
      background,
      foreground,
      cursor: used(probe, '--action', '#e8b23a'),
      cursorAccent: background,
      // xterm composites the selection over the cell, so it must be
      // translucent or it hides the text it is selecting.
      selectionBackground: luminance(background) < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)',
      ...ansi,
    };
  } finally {
    probe.remove();
  }
}
