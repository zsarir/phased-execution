/**
 * The keys a phone keyboard does not have.
 *
 * A software keyboard has no Esc, no Tab, no arrows and no Ctrl, which is most
 * of what a shell is driven with. This bar supplies them — and one of them,
 * Ctrl, is *sticky*: tap it, then tap a letter on the real keyboard, and the
 * next character becomes its control code. That is how `^C` is typed on a
 * phone without a dedicated button per combination.
 *
 * ## The shape, and why it is a grid
 *
 * The bar is a **fixed two-row grid** on a phone (`Esc Tab ⇧Tab ^C Ctrl` over
 * `↑ ↓ ← → Paste`) and one row from the `sm` breakpoint up, plus a `⋯` key that
 * flips to a second page (`Home End PgUp PgDn Del` over `A− A+ ^L ^D ^R`). It
 * is never a scroller. The first version was a single `overflow-x-auto` row,
 * 559 px wide at 390 px, with `→` and Paste off the screen and a native
 * `touchstart → preventDefault()` that cancelled the very scroll that would
 * have reached them; its keys fired on `touchend` with no movement test, so a
 * swipe that started on Esc typed Esc. Every rule below is the negation of one
 * of those:
 *
 *  - every key is in the grid, ≥ 44 px wide and tall, reachable without sliding;
 *  - a key fires on **`click`** — the browser's own tap-vs-scroll slop decides
 *    what a moving finger meant, and a swipe never becomes a keystroke;
 *  - `onPointerDown` (and its `mousedown` compatibility twin) `preventDefault`
 *    to keep focus on xterm's hidden textarea — a key that blurred the terminal
 *    would dismiss the iOS keyboard and arrive at nothing. Cancelling
 *    `pointerdown` suppresses the focus move but NOT the `click`, which is
 *    exactly the split this bar needs; no native listener, no passive-ness trap;
 *  - `touch-action: manipulation` (no double-tap zoom, no 300 ms delay),
 *    `select-none` and no `-webkit-touch-callout`, so a long press on a key is a
 *    key and not a text selection.
 */

import { useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Ellipsis,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export interface KeyBarProps {
  /** Send a literal byte sequence to the pty. */
  onSend(data: string): void;
  /** Ctrl is armed for the next character typed on the real keyboard. */
  ctrl: boolean;
  onCtrl(next: boolean): void;
  onPaste(): void;
  /** The `A−` / `A+` keys: the pane steps the terminal font and refits. */
  onFont(delta: -1 | 1): void;
}

export type BarKey =
  | { kind: 'send'; label: string; icon?: LucideIcon; data: string; title: string }
  | { kind: 'ctrl' }
  | { kind: 'paste' }
  | { kind: 'font'; delta: -1 | 1; label: string; title: string };

const send = (label: string, data: string, title: string, icon?: LucideIcon): BarKey => ({
  kind: 'send',
  label,
  data,
  title,
  ...(icon ? { icon } : {}),
});

/**
 * Two pages of ten. Page one is the bar most of the time; page two is what a
 * pager or an editor wants, plus the font stepper that replaces pinch-zoom on
 * the terminal (the page still pinch-zooms — `--app-height` no longer breaks
 * when it does — but a zoomed terminal is a cropped one; a bigger font is what
 * people actually mean).
 */
export const KEY_PAGES: readonly (readonly BarKey[])[] = [
  [
    send('Esc', '\x1b', 'Escape'),
    send('Tab', '\t', 'Tab — completion'),
    // CSI Z, the backtab. Harmless in a shell, and in a claude session it is
    // Shift+Tab — the permission-mode cycle a phone keyboard cannot type.
    send('⇧Tab', '\x1b[Z', 'Shift-Tab — cycle Claude permission modes'),
    send('^C', '\x03', 'Interrupt (Ctrl-C)'),
    { kind: 'ctrl' },
    send('↑', '\x1b[A', 'Up — previous command', ArrowUp),
    send('↓', '\x1b[B', 'Down', ArrowDown),
    send('←', '\x1b[D', 'Left', ArrowLeft),
    send('→', '\x1b[C', 'Right', ArrowRight),
    { kind: 'paste' },
  ],
  [
    send('Home', '\x1b[H', 'Home — start of line'),
    send('End', '\x1b[F', 'End — end of line'),
    send('PgUp', '\x1b[5~', 'Page up'),
    send('PgDn', '\x1b[6~', 'Page down'),
    send('Del', '\x1b[3~', 'Delete — the character under the cursor'),
    { kind: 'font', delta: -1, label: 'A−', title: 'Smaller terminal font' },
    { kind: 'font', delta: 1, label: 'A+', title: 'Larger terminal font' },
    send('^L', '\x0c', 'Clear the screen (Ctrl-L)'),
    send('^D', '\x04', 'End of input (Ctrl-D)'),
    send('^R', '\x12', 'Search history (Ctrl-R)'),
  ],
];

const KEY_CLASS =
  'flex min-h-(--tap-min) min-w-0 items-center justify-center rounded border px-1 font-mono text-sm';
const IDLE = 'border-rule bg-surface text-ink-muted hover:text-ink';
const ARMED = 'border-action bg-action text-ground';

export function KeyBar({ onSend, ctrl, onCtrl, onPaste, onFont }: KeyBarProps) {
  const [page, setPage] = useState(0);

  /**
   * Keep the terminal focused under a tap. The focus move is the default
   * action of `pointerdown` (and of the compatibility `mousedown` it produces);
   * cancelling it leaves the `click` intact, which is the half that types.
   */
  const hold = (event: React.SyntheticEvent) => {
    event.preventDefault();
  };

  const renderKey = (key: BarKey, index: number) => {
    if (key.kind === 'ctrl') {
      return (
        <button
          key="ctrl"
          type="button"
          aria-pressed={ctrl}
          title="Ctrl — the next key you type becomes its control code"
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => onCtrl(!ctrl)}
          className={cn(KEY_CLASS, ctrl ? ARMED : IDLE)}
        >
          Ctrl
        </button>
      );
    }
    if (key.kind === 'paste') {
      return (
        <button
          key="paste"
          type="button"
          title="Paste from the clipboard"
          aria-label="Paste"
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={onPaste}
          className={cn(KEY_CLASS, IDLE, 'gap-1 font-sans')}
        >
          {/* The word, always; the glyph only where a key is wide enough for
              both — at 60 px the pair truncated to "Pa…". */}
          <ClipboardPaste size={16} aria-hidden className="hidden sm:inline" />
          <span className="truncate">Paste</span>
        </button>
      );
    }
    if (key.kind === 'font') {
      return (
        <button
          key={key.label}
          type="button"
          title={key.title}
          aria-label={key.title}
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => onFont(key.delta)}
          className={cn(KEY_CLASS, IDLE)}
        >
          {key.label}
        </button>
      );
    }
    return (
      <button
        key={`${page}-${index}`}
        type="button"
        title={key.title}
        aria-label={key.title}
        onPointerDown={hold}
        onMouseDown={hold}
        onClick={() => onSend(key.data)}
        className={cn(KEY_CLASS, IDLE)}
      >
        {key.icon ? <key.icon size={18} aria-hidden /> : key.label}
      </button>
    );
  };

  return (
    <div
      // A grid row of the terminal column, never `position: fixed` — same rule
      // as the shell's tab bar, and for the same iOS reason. Five columns and
      // two rows on a phone; one row of ten from `sm` up. The `⋯` page key
      // takes the last column, both rows on a phone.
      className={cn(
        'grid shrink-0 grid-cols-[repeat(5,minmax(0,1fr))_auto] gap-1.5 border-t border-rule bg-ground-deep px-2 py-1.5',
        'sm:grid-cols-[repeat(10,minmax(0,1fr))_auto]',
        'select-none [-webkit-touch-callout:none] [touch-action:manipulation]',
      )}
      role="toolbar"
      aria-label="Terminal keys"
      data-page={page}
    >
      {KEY_PAGES[page].map(renderKey)}
      <button
        type="button"
        aria-label={page === 0 ? 'More keys' : 'Main keys'}
        aria-pressed={page === 1}
        title={page === 0 ? 'Home, End, PgUp, PgDn, Del, font size, ^L ^D ^R' : 'Back to the main keys'}
        onPointerDown={hold}
        onMouseDown={hold}
        onClick={() => setPage((current) => (current === 0 ? 1 : 0))}
        className={cn(
          // Placed explicitly so the ten keys auto-flow into columns 1–5 (1–10
          // from `sm`) and never into this column.
          KEY_CLASS,
          'col-start-6 row-start-1 row-span-2 min-w-(--tap-min) flex-col gap-1',
          'sm:col-start-11 sm:row-span-1',
          page === 1 ? 'border-rule-strong bg-surface-raised text-ink' : IDLE,
        )}
      >
        <Ellipsis size={18} aria-hidden />
        {/* Page dots: which of the two pages is up. */}
        <span className="flex gap-1" aria-hidden>
          <span className={cn('size-1.5 rounded-full', page === 0 ? 'bg-ink' : 'bg-rule-strong')} />
          <span className={cn('size-1.5 rounded-full', page === 1 ? 'bg-ink' : 'bg-rule-strong')} />
        </span>
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
