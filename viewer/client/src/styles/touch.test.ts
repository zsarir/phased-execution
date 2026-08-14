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
    expect(theme.slice(floor)).toMatch(/input,\s*textarea,\s*select\s*\{\s*font-size:\s*max\(var\(--text-input\),\s*1em\)/);
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
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/h-\(--app-height\)/);
    expect(app).not.toMatch(/'grid h-dvh/);
  });
});

describe('scroll traps stay dead', () => {
  it('the live console body chains at its ends instead of stopping the page', () => {
    const console_ = readFileSync(join(SRC, 'views', 'run', 'console.tsx'), 'utf8');
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

  it('dialogs never size by 100vw (it ignores the scrollbar)', () => {
    for (const name of ['dialog.tsx', 'alert-dialog.tsx']) {
      const text = readFileSync(join(SRC, 'components', 'ui', name), 'utf8');
      expect(text).not.toMatch(/100vw/);
    }
  });

  it('the terminal scrollback is contained — a flick must not rubber-band the shell', () => {
    const css = readFileSync(join(SRC, 'views', 'terminal', 'terminal.css'), 'utf8');
    expect(css).toMatch(/\.xterm-viewport\s*\{\s*overscroll-behavior:\s*contain/);
  });
});
