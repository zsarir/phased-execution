/**
 * Touch-correctness guards, as source text — jsdom computes no styles
 * (`css: false`), so the honest assertions are about what ships, in the shape
 * `theme.test.ts` established.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const theme = readFileSync(join(here, 'theme.css'), 'utf8');
const indexHtml = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
/** Every primitive that floats over the page and must size by the VISIBLE viewport. */
const OVERLAYS = [
  'dialog.tsx',
  'alert-dialog.tsx',
  'sheet.tsx',
  'popover.tsx',
  'dropdown-menu.tsx',
  'select.tsx',
  'command.tsx',
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    // App source only — a test (this one included) may NAME the pattern.
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

describe('the input floor wins on touch', () => {
  it('theme.css carries the UNLAYERED coarse-pointer floor, after the last @layer block', () => {
    const floor = theme.indexOf('@media (pointer: coarse)');
    expect(floor).toBeGreaterThan(-1);
    expect(theme.slice(floor)).toMatch(
      /input,\s*textarea,\s*select\s*\{\s*font-size:\s*max\(var\(--text-input\),\s*1em\)/,
    );
    // Everything layered loses to unlayered CSS — but only if this rule IS
    // unlayered: it must sit after the last @layer/@import block.
    expect(floor).toBeGreaterThan(theme.lastIndexOf('@layer'));
  });

  it('the field class is defined exactly once under src/', () => {
    const definitions: string[] = [];
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      // The historic copy-paste: a local `const field = 'h-9 …'`.
      if (/const field =\s*\n?\s*'h-9 /.test(text)) definitions.push(path);
    }
    expect(definitions).toEqual([join(SRC, 'components', 'ui', 'field.ts')]);
  });
});

describe('the keyboard contract', () => {
  it('index.html asks Android to resize the LAYOUT viewport for the keyboard', () => {
    expect(indexHtml).toMatch(/interactive-widget=resizes-content/);
  });

  it('--app-height exists with its dvh fallback, and the shell consumes it', () => {
    expect(theme).toMatch(/--app-height:\s*100dvh/);
    // The grid moved out of `App.tsx` and into the shell layout in 3.0; the
    // rule did not move with it — `dvh` ignores the software keyboard on iOS,
    // so the shell's own height is this token and nothing else.
    const layout = readFileSync(join(SRC, 'app', 'shell', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/h-\(--app-height\)/);
    expect(layout).not.toMatch(/'grid h-dvh/);
  });
});

describe('scroll traps stay dead', () => {
  it('the live console body chains at its ends instead of stopping the page', () => {
    const console_ = readFileSync(join(SRC, 'features', 'runs', 'console.tsx'), 'utf8');
    expect(console_).not.toMatch(/live-body[^"]*overscroll-contain/);
  });

  it('the table header is not sticky inside its overflow wrapper', () => {
    const table = readFileSync(join(SRC, 'components', 'ui', 'table.tsx'), 'utf8');
    expect(table).not.toMatch(/sticky top-0/);
  });
});

describe('per-page mobile fixes stay fixed', () => {
  it('the route map sizes by dvh — vh is the iOS large-viewport trap', () => {
    const map = readFileSync(join(here, 'route-map.css'), 'utf8');
    expect(map).toMatch(/56dvh/);
    expect(map).not.toMatch(/56vh/);
  });

  it('dialogs, sheets, menus and popovers never size by 100vw (it ignores the scrollbar)', () => {
    for (const name of OVERLAYS) {
      const text = readFileSync(join(SRC, 'components', 'ui', name), 'utf8');
      expect(text).not.toMatch(/100vw/);
    }
  });

  it('the terminal scrollback is contained — a flick must not rubber-band the shell', () => {
    const css = readFileSync(join(SRC, 'features', 'sessions', 'terminal.css'), 'utf8');
    // xterm 6: fingers land on `.xterm-scrollable-element`; `.xterm-viewport`
    // is an empty ground behind the screen, and a rule on it contains nothing.
    expect(css).toMatch(/\.xterm-scrollable-element\s*\{\s*overscroll-behavior:\s*contain/);
    expect(css).not.toMatch(/\.xterm-viewport\s*\{[^}]*(overscroll-behavior|touch-action)/);
    // Scrollbar styling likewise — the viewport no longer scrolls.
    expect(css).not.toMatch(/\.xterm-viewport::-webkit-scrollbar/);
  });

  it('the terminal key bar is a grid, never a scroller, and never a touch listener', () => {
    // Code, not prose: the file's own comment names the old scroller to explain the ban.
    const keybar = readFileSync(join(SRC, 'features', 'sessions', 'keybar.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(keybar).not.toMatch(/overflow-x-auto/);
    expect(keybar).not.toMatch(/addEventListener\(['"]touch/);
    expect(keybar).not.toMatch(/onTouch(Start|End)=/);
    expect(keybar).toMatch(/touch-action:manipulation/);
  });

  it('nothing under src/ attaches a NON-PASSIVE touchstart (the listener that cancels a scroll it sits on)', () => {
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      const match = /addEventListener\(\s*['"]touchstart['"][^)]*passive:\s*false/.exec(text);
      expect(match, `${path} attaches a non-passive touchstart`).toBeNull();
    }
  });

  it('dialogs, sheets, menus and popovers size by --app-height — never dvh, which ignores the iOS keyboard', () => {
    for (const name of OVERLAYS) {
      const text = readFileSync(join(SRC, 'components', 'ui', name), 'utf8');
      // Classes, not prose: a `dvh` inside an arbitrary-value bracket.
      expect(text, `${name} sizes by dvh`).not.toMatch(/\[[^\]]*\bdvh\b[^\]]*\]/);
      expect(text).toMatch(/--app-height/);
    }
  });

  it('toasts sit above the keyboard and above every bottom bar, never at bottom-0', () => {
    const toast = readFileSync(join(SRC, 'components', 'ui', 'toast.tsx'), 'utf8');
    expect(toast).toMatch(/--app-height/);
    expect(toast).toMatch(/--bottom-bars/);
    expect(toast).not.toMatch(/fixed inset-x-0 bottom-0/);
    // The bars that register: the shell's tab bar and the terminal's bottom row.
    expect(readFileSync(join(SRC, 'app', 'shell', 'tab-bar.tsx'), 'utf8')).toMatch(/useBottomBar/);
    expect(readFileSync(join(SRC, 'features', 'sessions', 'pane.tsx'), 'utf8')).toMatch(/useBottomBar/);
  });

  it('the session strip WRAPS — `ml-auto` past an overflow puts the tabs off the left edge', () => {
    // Measured on the live page at 1440 (Phase 10): the strip's facts row grew
    // by one button and went 122 px past the viewport, and because `ml-auto`
    // resolves before an overflow the TAB LIST landed at x = −25 — the one
    // control the strip exists for, off screen, with no scrollbar to reach it.
    // A `shrink-0` on the facts row is what made it push instead of wrap.
    const strip = readFileSync(join(SRC, 'features', 'sessions', 'list.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const desktopRow = /className="flex shrink-0 flex-wrap items-center gap-1 border-b/.exec(strip);
    expect(desktopRow, 'the desktop strip row must be flex-wrap').not.toBeNull();
    const facts = /\{active && details && \(\s*<div className="([^"]+)"/.exec(strip);
    expect(facts, 'the facts row must be a div with classes').not.toBeNull();
    expect(facts![1]).toContain('min-w-0');
    expect(facts![1]).not.toContain('shrink-0');
  });

  it('the tab strip never calls scrollIntoView — it scrolls every ancestor, and live SSE renders made the run page crawl', () => {
    const tabs = readFileSync(join(SRC, 'components', 'ui', 'tabs.tsx'), 'utf8');
    // Invocations only — the file's own comment names the API to explain the ban.
    expect(tabs).not.toMatch(/\.scrollIntoView\(/);
    // The once-per-change guard: an every-render effect may only scroll when
    // the ACTIVE tab actually moved.
    expect(tabs).toMatch(/lastActive/);
  });
});

/* ------------------------------------------------------------------ *
 * `shrink-0` on a variable-length row — the defect three phases found
 * ------------------------------------------------------------------ */

/**
 * The rule, stated once because it has now cost four surfaces:
 *
 * a flex row whose CONTENT can grow — an actions bar that gains a button when a
 * lane goes live, a facts line that gains an ETA phrase, a page header whose
 * `<select>` sizes to a plan slug — must be allowed to shrink and to wrap.
 * `shrink-0` on such a row makes it PUSH instead, and because the shell's one
 * scroller has `overflow-y: auto` (which computes `overflow-x` to `auto`), the
 * push becomes a horizontal scroll of the whole app.
 *
 * `flex-wrap` alone does not save it: a row that may not shrink has nothing to
 * wrap into. Measured, each caught only by the tour:
 *
 *   Phase 10  the session strip           1326 in a 1204 track (tabs at x = −25)
 *   Phase 11  the run console's actions     441 in a  390 track
 *   Phase 11  Now's plan facts line         324 in a  320 track
 *   Phase 11  `Page`'s actions row          323 in a  320 track (every page)
 */
describe('a row that can grow may shrink and wrap', () => {
  const rows: [string, string][] = [
    ['components/page.tsx', 'flex min-w-0 flex-wrap gap-2'],
    ['features/runs/console.tsx', 'flex min-w-0 flex-wrap items-center justify-end gap-1.5'],
  ];

  for (const [file, cls] of rows) {
    it(`${file} keeps its actions row shrinkable`, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text).toContain(cls);
      expect(text, `${file} must not put shrink-0 back on that row`).not.toContain(
        cls.replace('min-w-0', 'shrink-0'),
      );
    });
  }

  it("Now's plan facts line is min-w-0, not shrink-0", () => {
    // `3/9 · 33%` is 60 px; `3/9 · 33% · ~1.5 h–5 h (from other plans)` is 295.
    const text = readFileSync(join(SRC, 'features/now/portfolio-strip.tsx'), 'utf8');
    expect(text).toContain('min-w-0 font-mono text-2xs break-words tabular-nums text-ink-faint');
  });
});

describe('text the app did not write can wrap', () => {
  it('a health issue message breaks long words', () => {
    // Issue messages quote plan text — slugs, paths, `bash -c '…'` — and a
    // token with no space in it for forty characters has nothing to wrap AT.
    // Phase 9 found this on a recorded command; Phase 11 on this list.
    const text = readFileSync(join(SRC, 'features/insights/portfolio.tsx'), 'utf8');
    expect(text).toContain('min-w-0 flex-1 text-sm break-words text-ink-muted');
  });
});

describe('every Settings section is reachable by thumb', () => {
  it('the nav links carry the tap minimum', () => {
    // The whole section list is links, and a link is the only way into a
    // section — a 28 px row here is a page a phone cannot open.
    const text = readFileSync(join(SRC, 'features/settings/nav.tsx'), 'utf8');
    expect(text).toContain('min-h-(--tap-min)');
  });

  it('the plan scope select cannot size to its widest option', () => {
    // A `<select>` sizes to its WIDEST option, and every option here is a plan
    // slug. Unbounded, one long slug made a 423 px control inside a 390 px
    // phone and scrolled the whole page sideways (Phase 6's trap).
    const text = readFileSync(join(SRC, 'features/insights/index.tsx'), 'utf8');
    expect(text).toMatch(/w-full max-w-\d+ min-w-0/);
  });
});
