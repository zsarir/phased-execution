/**
 * The on-screen keyboard, made a fact the shell can layout against.
 *
 * The shell is `h-(--app-height)` with `overflow-hidden` — the document never
 * scrolls. `dvh` does NOT shrink for the software keyboard on iOS (nor on
 * Android before `interactive-widget=resizes-content`), so focusing xterm's
 * hidden textarea used to scroll the WINDOW to reveal it: the top bar left the
 * screen and the terminal KeyBar sat under the keyboard — you typed into a
 * terminal you could not see. Two mechanisms fix it:
 *
 *  - `interactive-widget=resizes-content` in the viewport meta makes Android
 *    resize the layout viewport (its default resizes only the visual one);
 *  - `installAppHeight` mirrors the visual viewport into `--app-height` for
 *    iOS, which ignores that key, and pins the window's scroll back to 0 when
 *    iOS pans the visual viewport to reveal a focused field.
 *
 * Three more facts ride the same listener, each the answer to a phone defect:
 *
 *  - **`--app-height` is `min(vv.height × vv.scale, innerHeight)`**, not a
 *    bail-out on `scale`. The old mirror stopped updating the moment the page
 *    was pinch-zoomed, which froze the shell at whatever height the keyboard
 *    had left it; multiplying back by the scale yields the layout height a
 *    zoomed page still occupies, and a keyboard that opens under a zoom still
 *    shrinks it.
 *  - **`--keyboard-inset`** — how much of the screen the keyboard has taken:
 *    the tallest visual viewport seen at this width, minus the current one.
 *    The width is the orientation; a rotation resets the baseline, a keyboard
 *    never changes the width. Exposed as a CSS property and as
 *    `useKeyboardInset()` for anything that must pin above the keyboard.
 *  - **`useKeyboardOpen` is hybrid**: a text-entry element has focus on a
 *    touch device AND the inset says a keyboard actually took room. Focus
 *    alone hid the tab bar for a hardware keyboard (nothing took room); the
 *    delta alone fires on a URL-bar collapse. Both together is a software
 *    keyboard, on either engine.
 *
 * **Bottom bars.** Toasts must never cover a control bar along the bottom
 * edge (the phone's tab bar, the terminal's key bar and composer), and must
 * stay visible with the keyboard open. Those bars register here; the sum of
 * their heights is `--bottom-bars`, and the toast viewport's `bottom` is the
 * keyboard inset plus that sum.
 */

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { useTouch } from '@/lib/media';

/** The smallest visual-viewport shrink that counts as a keyboard. */
export const KEYBOARD_MIN_PX = 120;

/* ---------------- the keyboard inset store ---------------- */

let inset = 0;
const insetListeners = new Set<() => void>();
function publishInset(next: number): void {
  if (next === inset) return;
  inset = next;
  for (const notify of insetListeners) notify();
}

/** The pixels the software keyboard currently occupies (0 when closed). */
export function useKeyboardInset(): number {
  return useSyncExternalStore(
    (notify) => {
      insetListeners.add(notify);
      return () => {
        insetListeners.delete(notify);
      };
    },
    () => inset,
    () => 0,
  );
}

/** Mirror the visual viewport into `--app-height` and `--keyboard-inset`. Returns the uninstaller. */
export function installAppHeight(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {}; // CSS falls back to 100dvh
  const root = document.documentElement;
  let raf = 0;
  // The tallest height seen at this width — the "no keyboard" reference.
  let baselineWidth = window.innerWidth;
  let baseline = 0;
  const apply = () => {
    raf = 0;
    const height = Math.round(Math.min(vv.height * vv.scale, window.innerHeight));
    if (!(height > 0)) return;
    root.style.setProperty('--app-height', `${height}px`);
    if (window.innerWidth !== baselineWidth) {
      baselineWidth = window.innerWidth;
      baseline = 0;
    }
    if (height > baseline) baseline = height;
    const taken = Math.max(0, baseline - height);
    root.style.setProperty('--keyboard-inset', `${taken}px`);
    publishInset(taken);
    // iOS pans the visual viewport to reveal a focused input. The shell has
    // its own layout for that now — the window must stay pinned, or the top
    // bar walks off the screen.
    const tag = document.activeElement?.tagName;
    if (vv.offsetTop > 0 && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      window.scrollTo(0, 0);
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  schedule();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (raf) cancelAnimationFrame(raf);
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--keyboard-inset');
    publishInset(0);
  };
}

function editable(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // `=== true`, not a bare read: jsdom leaves isContentEditable undefined, and
  // `x && undefined` fed setState an undefined that unrendered the boolean.
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/**
 * True while a software keyboard is up: a text-entry element has focus on a
 * touch device AND the visual viewport gave up at least `KEYBOARD_MIN_PX`.
 */
export function useKeyboardOpen(): boolean {
  const touch = useTouch();
  const taken = useKeyboardInset();
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!touch) {
      setFocused(false);
      return;
    }
    let raf = 0;
    const sync = () => {
      raf = 0;
      setFocused(editable(document.activeElement));
    };
    const onFocus = () => {
      if (raf) cancelAnimationFrame(raf);
      sync();
    };
    // Blur waits one frame: a field-to-field move blurs then focuses, and the
    // tab bar must not flicker through the gap.
    const onBlur = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [touch]);
  return touch && focused && taken >= KEYBOARD_MIN_PX;
}

/* ---------------- bottom bars ---------------- */

const bars = new Map<Element, number>();
let barsTotal = 0;
const barListeners = new Set<() => void>();

function publishBars(): void {
  let total = 0;
  for (const height of bars.values()) total += height;
  if (total === barsTotal) return;
  barsTotal = total;
  document.documentElement.style.setProperty('--bottom-bars', `${total}px`);
  for (const notify of barListeners) notify();
}

/**
 * Declare an element a bar along the bottom edge. Its height (live, via
 * ResizeObserver) joins `--bottom-bars`; the returned function withdraws it.
 */
export function registerBottomBar(element: HTMLElement): () => void {
  const measure = () => {
    bars.set(element, element.offsetHeight);
    publishBars();
  };
  measure();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  observer?.observe(element);
  return () => {
    observer?.disconnect();
    bars.delete(element);
    publishBars();
  };
}

/** The hook form: the ref's element is a bottom bar while the component is mounted. */
export function useBottomBar(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return undefined;
    return registerBottomBar(element);
  }, [ref, active]);
}

/** The current sum of registered bottom bars, in px. */
export function useBottomBars(): number {
  return useSyncExternalStore(
    (notify) => {
      barListeners.add(notify);
      return () => {
        barListeners.delete(notify);
      };
    },
    () => barsTotal,
    () => 0,
  );
}
