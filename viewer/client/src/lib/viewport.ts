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
 *  - `installAppHeight` mirrors `visualViewport.height` into `--app-height`
 *    for iOS, which ignores that key, and pins the window's scroll back to 0
 *    when iOS pans the visual viewport to reveal a focused field.
 *
 * `useKeyboardOpen` is focus-based rather than height-delta-based because it
 * then behaves identically on both engines: the tab bar hides while a text
 * field (xterm's textarea included) has focus on a touch device — typing is
 * never a navigation moment, and those 60px are what keep the prompt and the
 * KeyBar visible above the keyboard.
 */

import { useEffect, useState } from 'react';
import { useTouch } from '@/lib/media';

/** Mirror the visual viewport into `--app-height`. Returns the uninstaller. */
export function installAppHeight(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {}; // CSS falls back to 100dvh
  let raf = 0;
  const apply = () => {
    raf = 0;
    // Pinch-zoom also resizes the visual viewport; a zoomed page must not
    // shrink the shell. The keyboard never changes scale.
    if (vv.scale > 1.01) return;
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    // iOS pans the visual viewport to reveal a focused input. The shell has
    // its own layout for that now — the window must stay pinned, or the top
    // bar walks off the screen.
    const tag = document.activeElement?.tagName;
    if (vv.offsetTop > 0 && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      window.scrollTo(0, 0);
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  schedule();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (raf) cancelAnimationFrame(raf);
    document.documentElement.style.removeProperty('--app-height');
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

/** True while a text-entry element has focus on a touch device. */
export function useKeyboardOpen(): boolean {
  const touch = useTouch();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!touch) { setOpen(false); return; }
    let raf = 0;
    const sync = () => { raf = 0; setOpen(editable(document.activeElement)); };
    const onFocus = () => { if (raf) cancelAnimationFrame(raf); sync(); };
    // Blur waits one frame: a field-to-field move blurs then focuses, and the
    // tab bar must not flicker through the gap.
    const onBlur = () => { if (!raf) raf = requestAnimationFrame(sync); };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [touch]);
  return touch ? open : false;
}
