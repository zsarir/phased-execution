/**
 * The key bar under a finger — the contract, asserted.
 *
 * jsdom lays nothing out, so widths are asserted as the CSS contract (a grid
 * of five key columns, never a scroller, every key `min-h-(--tap-min)`) and
 * measured for real in the phone tour; what jsdom CAN see is the event model,
 * and that is where the first bar went wrong: a native non-passive
 * `touchstart` that cancelled scrolling, keys firing on `touchend` with no
 * movement test (a swipe typed), and a focus call after every key that
 * scrolled the terminal sideways.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KEY_PAGES, KeyBar, applyCtrl } from './keybar';

const noop = () => {};

function mount(over: Partial<React.ComponentProps<typeof KeyBar>> = {}) {
  const sent: string[] = [];
  const utils = render(
    <KeyBar onSend={(d) => sent.push(d)} ctrl={false} onCtrl={noop} onPaste={noop} onFont={noop} {...over} />,
  );
  const bar = screen.getByRole('toolbar', { name: /terminal keys/i });
  return { sent, bar, ...utils };
}

describe('the key bar is a grid, never a scroller', () => {
  it('lays out five key columns (ten from sm) plus the page key, with no horizontal scrolling', () => {
    const { bar } = mount();
    expect(bar.className).toMatch(/\bgrid\b/);
    expect(bar.className).toMatch(/grid-cols-\[repeat\(5,/);
    expect(bar.className).toMatch(/sm:grid-cols-\[repeat\(10,/);
    expect(bar.className).not.toMatch(/overflow-x-auto/);
    // A long press is a key, not a selection; a double tap is two keys, not a zoom.
    expect(bar.className).toMatch(/touch-action:manipulation/);
    expect(bar.className).toMatch(/select-none/);
    expect(bar.className).toMatch(/-webkit-touch-callout:none/);
  });

  it('shows every key of the page at once — ten keys and the page key, each thumb-sized', () => {
    const { bar } = mount();
    const buttons = within(bar).getAllByRole('button');
    expect(buttons).toHaveLength(KEY_PAGES[0].length + 1);
    for (const button of buttons) expect(button.className).toMatch(/min-h-\(--tap-min\)/);
    // The page key is placed, not flowed: the ten keys fill columns 1–5 and
    // never slide into its column.
    const page = screen.getByRole('button', { name: /more keys/i });
    expect(page.className).toMatch(/col-start-6/);
    expect(page.className).toMatch(/row-span-2/);
  });

  it('registers NO native touchstart listener (the passive-listener trap is gone with the scroller)', () => {
    const listeners: { on: HTMLElement; type: string }[] = [];
    const original = HTMLElement.prototype.addEventListener;
    HTMLElement.prototype.addEventListener = function patched(
      this: HTMLElement,
      type: string,
      fn: never,
      options: never,
    ) {
      listeners.push({ on: this, type });
      return original.call(this, type, fn, options);
    } as typeof original;
    let bar: HTMLElement;
    try {
      ({ bar } = mount());
    } finally {
      HTMLElement.prototype.addEventListener = original;
    }
    const touch = listeners.filter((l) => /^touch/.test(l.type) && (l.on === bar || bar.contains(l.on)));
    expect(touch, 'the bar attaches no touch listener of its own').toEqual([]);
  });
});

describe('under a finger', () => {
  it('a tap sends exactly one sequence', () => {
    const { sent } = mount();
    fireEvent.click(screen.getByRole('button', { name: /escape/i }));
    expect(sent).toEqual(['\x1b']);
  });

  it('pointerdown → pointermove (30 px) → pointerup sends nothing — a swipe is not a key', () => {
    const { sent } = mount();
    const escape = screen.getByRole('button', { name: /escape/i });
    fireEvent.pointerDown(escape, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(escape, { pointerId: 1, clientX: 40, clientY: 12 });
    fireEvent.pointerUp(escape, { pointerId: 1, clientX: 40, clientY: 12 });
    // No `click` was synthesised, because the browser decides that — and a
    // finger that moved 30 px is a scroll, not a tap. The bar fires on click
    // alone, so nothing was sent.
    expect(sent).toEqual([]);
  });

  it('keeps focus where it was: pointerdown and mousedown are cancelled, and the bar never focuses anything', () => {
    const { sent } = mount();
    const terminal = document.createElement('textarea');
    document.body.append(terminal);
    terminal.focus();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const escape = screen.getByRole('button', { name: /escape/i });
    expect(!fireEvent.pointerDown(escape, { pointerId: 1 }), 'pointerdown is cancelled').toBe(true);
    expect(!fireEvent.mouseDown(escape), 'mousedown (the compatibility event) is cancelled').toBe(true);
    fireEvent.click(escape);
    expect(sent).toEqual(['\x1b']);
    expect(document.activeElement).toBe(terminal);
    // Focus is the pane's business (only when lost, with preventScroll); the
    // bar itself moves nothing, so a key can never scroll the host sideways.
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    terminal.remove();
  });

  it('shows Ctrl as armed so a sticky modifier is not invisible, and arms from a tap', () => {
    const armed: boolean[] = [];
    const { rerender } = render(
      <KeyBar onSend={noop} ctrl={false} onCtrl={(next) => armed.push(next)} onPaste={noop} onFont={noop} />,
    );
    // Exact: `/ctrl/i` also matches the `^C` key, whose label is "Interrupt (Ctrl-C)".
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    expect(armed).toEqual([true]);
    rerender(<KeyBar onSend={noop} ctrl onCtrl={noop} onPaste={noop} onFont={noop} />);
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Paste asks the pane, never the clipboard itself', () => {
    const onPaste = vi.fn();
    mount({ onPaste });
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    expect(onPaste).toHaveBeenCalledTimes(1);
  });
});

describe('the second page', () => {
  it('flips to Home/End/PgUp/PgDn/Del and the font stepper, and back', () => {
    const onFont = vi.fn();
    const { sent, bar } = mount({ onFont });
    expect(bar).toHaveAttribute('data-page', '0');
    fireEvent.click(screen.getByRole('button', { name: /more keys/i }));
    expect(bar).toHaveAttribute('data-page', '1');
    expect(screen.getByRole('button', { name: /main keys/i })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /page up/i }));
    fireEvent.click(screen.getByRole('button', { name: /^home/i }));
    expect(sent).toEqual(['\x1b[5~', '\x1b[H']);

    fireEvent.click(screen.getByRole('button', { name: /larger terminal font/i }));
    fireEvent.click(screen.getByRole('button', { name: /smaller terminal font/i }));
    expect(onFont.mock.calls).toEqual([[1], [-1]]);

    fireEvent.click(screen.getByRole('button', { name: /main keys/i }));
    expect(bar).toHaveAttribute('data-page', '0');
    expect(screen.getByRole('button', { name: /escape/i })).toBeInTheDocument();
  });

  it('both pages are ten keys, and every sequence is the bytes a terminal expects', () => {
    expect(KEY_PAGES.map((page) => page.length)).toEqual([10, 10]);
    const bytes = Object.fromEntries(
      KEY_PAGES.flat().flatMap((key) => (key.kind === 'send' ? [[key.label, key.data]] : [])),
    );
    expect(bytes).toMatchObject({
      Esc: '\x1b',
      Tab: '\t',
      '⇧Tab': '\x1b[Z',
      '^C': '\x03',
      '↑': '\x1b[A',
      '↓': '\x1b[B',
      '←': '\x1b[D',
      '→': '\x1b[C',
      Home: '\x1b[H',
      End: '\x1b[F',
      PgUp: '\x1b[5~',
      PgDn: '\x1b[6~',
      Del: '\x1b[3~',
      '^L': '\x0c',
      '^D': '\x04',
      '^R': '\x12',
    });
  });
});

describe('applyCtrl', () => {
  it('maps a letter to its control code', () => {
    expect(applyCtrl('c')).toBe('\x03');
    expect(applyCtrl('C')).toBe('\x03');
    expect(applyCtrl('d')).toBe('\x04');
    expect(applyCtrl('z')).toBe('\x1a');
  });

  it('passes an escape sequence through untouched', () => {
    // An arrow key arrives as three bytes. Transforming it would break the very
    // keys the bar exists to provide.
    expect(applyCtrl('\x1b[A')).toBe(null);
    expect(applyCtrl('')).toBe(null);
    expect(applyCtrl('1')).toBe(null);
  });
});
