/**
 * The keys a phone keyboard does not have.
 *
 * A software keyboard has no Esc, no Tab, no arrows and no Ctrl, which is most
 * of what a shell is driven with. This bar supplies them — and one of them,
 * Ctrl, is *sticky*: tap it, then tap a letter on the real keyboard, and the
 * next character becomes its control code. That is how `^C` is typed on a
 * phone without a dedicated button per combination.
 */

import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface KeyBarProps {
  /** Send a literal byte sequence to the pty. */
  onSend(data: string): void;
  /** Ctrl is armed for the next character typed on the real keyboard. */
  ctrl: boolean;
  onCtrl(next: boolean): void;
  onPaste(): void;
}

const KEYS: readonly { label: string; icon?: typeof ArrowUp; data: string; title: string }[] = [
  { label: 'Esc', data: '\x1b', title: 'Escape' },
  { label: 'Tab', data: '\t', title: 'Tab — completion' },
  { label: '^C', data: '\x03', title: 'Interrupt (Ctrl-C)' },
  { label: '↑', icon: ArrowUp, data: '\x1b[A', title: 'Up — previous command' },
  { label: '↓', icon: ArrowDown, data: '\x1b[B', title: 'Down' },
  { label: '←', icon: ArrowLeft, data: '\x1b[D', title: 'Left' },
  { label: '→', icon: ArrowRight, data: '\x1b[C', title: 'Right' },
];

export function KeyBar({ onSend, ctrl, onCtrl, onPaste }: KeyBarProps) {
  const bar = useRef<HTMLDivElement>(null);

  /**
   * ⚠️ Attached natively, with `{ passive: false }`, on purpose.
   *
   * React registers `touchstart` on its root as **passive**, so calling
   * `preventDefault()` inside an `onTouchStart` prop does nothing but log a
   * warning. It has to be prevented: without it, tapping a key blurs xterm's
   * hidden textarea, iOS dismisses the keyboard, and the arrow you just pressed
   * arrives at a terminal that no longer has focus. Same reasoning as
   * `useMapView` in `components/dag.tsx`.
   */
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const hold = (event: TouchEvent) => { event.preventDefault(); };
    element.addEventListener('touchstart', hold, { passive: false });
    return () => element.removeEventListener('touchstart', hold);
  }, []);

  return (
    <div
      ref={bar}
      // A grid row of the terminal column, never `position: fixed` — same rule
      // as the shell's tab bar, and for the same iOS reason.
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-rule bg-ground-deep px-2 py-1.5"
      role="toolbar"
      aria-label="Terminal keys"
    >
      <button
        type="button"
        aria-pressed={ctrl}
        title="Ctrl — the next key you type becomes its control code"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCtrl(!ctrl)}
        className={cn(
          'min-h-(--tap-min) shrink-0 rounded border px-3 font-mono text-sm',
          ctrl
            ? 'border-action bg-action text-ground'
            : 'border-rule bg-surface text-ink-muted hover:text-ink',
        )}
      >
        Ctrl
      </button>

      {KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          title={key.title}
          aria-label={key.title}
          // mousedown is NOT one of React's passive root listeners, so the
          // prop is enough here — this is what keeps focus on the terminal
          // when the bar is used with a mouse or a trackpad.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSend(key.data)}
          className="min-h-(--tap-min) shrink-0 rounded border border-rule bg-surface px-3 font-mono text-sm text-ink-muted hover:text-ink"
        >
          {key.icon ? <key.icon size={16} aria-hidden /> : key.label}
        </button>
      ))}

      <button
        type="button"
        title="Paste from the clipboard"
        aria-label="Paste"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPaste}
        className="ml-auto flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded border border-rule bg-surface px-3 text-sm text-ink-muted hover:text-ink"
      >
        <ClipboardPaste size={16} aria-hidden />
        Paste
      </button>
    </div>
  );
}

/**
 * Apply an armed Ctrl to what the user typed.
 *
 * Only single printable characters are transformed: an arrow key arrives as a
 * three-byte escape sequence and must pass through untouched, or the bar would
 * break the very keys it exists to provide.
 */
export function applyCtrl(data: string): string | null {
  if (data.length !== 1) return null;
  const code = data.toUpperCase().charCodeAt(0);
  // `Ctrl` maps @A–Z[\]^_ to 0–31. Anything else has no control code and is
  // sent as itself rather than as a silently wrong byte.
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}
