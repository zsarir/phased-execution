/**
 * One session, one xterm, one socket.
 *
 * Everything stateful lives in refs rather than React state on purpose: a pty
 * is a stream at hundreds of frames a second, and routing it through a
 * `setState` would re-render the tree on every keystroke of output. React owns
 * the chrome around the terminal; xterm owns the terminal.
 *
 * ## The phone contract (the mechanism Phase 10 carries, not re-invents)
 *
 *  - **Born at the real size.** The terminal is fitted synchronously, before
 *    the first `connect()`, so the mint carries the settled `cols/rows`; the
 *    link buffers the latest size and flushes it the moment the socket opens.
 *  - **Fit per frame, resize the pty per ~150 ms.** The visual fit stays on
 *    rAF; the wire resize is debounced inside `TerminalLink`, so a keyboard
 *    animation costs the TUI one repaint, not fifteen.
 *  - **Focus only when lost, without moving anything.** xterm's hidden
 *    textarea sits at the cursor cell; focusing it the old way scrolled the
 *    cursor into view on every key, which on a phone past the 80-column floor
 *    yanked the terminal sideways. `focusTerminal` focuses with
 *    `{ preventScroll: true }`, only if focus actually went elsewhere, and puts
 *    the host's `scrollLeft` back.
 *  - **Reattach, don't stack.** Every attach replays the server's scrollback;
 *    on a reattach the terminal is reset first, so a reconnect shows one copy.
 *  - **Reconnects itself.** `TerminalLink` retries with backoff and says
 *    "Reconnecting… (n)"; the banner keeps a manual button for impatience.
 *  - **`A−`/`A+` instead of pinch.** The font steps (persisted in prefs) and
 *    the terminal refits; the page may still pinch-zoom, and `--app-height`
 *    no longer breaks when it does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { ArrowDown, Plug, RotateCw } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
// After xterm's own sheet on purpose — see the file for what it takes back.
import './terminal.css';

import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { usePrefs } from '@/lib/prefs';
import { TerminalLink, type LinkStatus } from '@/lib/terminal';
import { useBottomBar } from '@/lib/viewport';
import type { TerminalSession } from '@/lib/api';
import { Button, toast } from '@/components/ui';
import { KeyBar, applyCtrl } from './keybar';
import { Composer } from './composer';
import { xtermTheme } from './palette';

export interface TerminalPaneProps {
  sessionId: string;
  onSession?(session: TerminalSession): void;
  /** The size the browser actually settled on, whenever it changes. */
  onSize?(size: { cols: number; rows: number }): void;
  onEnded?(): void;
  /** A one-line composer above the key bar — claude sessions, where a phone
   * keyboard's autocorrect and the TUI's line editing fight. */
  composer?: boolean;
}

/**
 * A phone is ~40 columns at 16px, and everything a session actually shows —
 * a claude TUI, a test table, a diff — is written for 80. Rather than let it
 * wrap into confetti, the terminal keeps at least 80 columns and the HOST
 * scrolls sideways: rows stay fitted to the height, width pans under a finger.
 */
const PHONE_MIN_COLS = 80;

/** The font stepper's range, in px. */
export const FONT_MIN = 10;
export const FONT_MAX = 24;

/**
 * The terminal font: 16px on a phone (below that iOS zooms the page when the
 * hidden textarea takes focus — `terminal.css` pins the textarea itself now,
 * so the stepper may go lower), 14px on a desktop, plus the operator's steps.
 */
export function terminalFontSize(phone: boolean, step: number): number {
  const base = phone ? 16 : 14;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, base + (Number.isFinite(step) ? Math.round(step) : 0)));
}

function fitWithFloor(terminal: Terminal, fitAddon: FitAddon, phone: boolean): void {
  const proposal = fitAddon.proposeDimensions();
  if (!proposal || !Number.isFinite(proposal.cols) || !Number.isFinite(proposal.rows)) return;
  const cols = phone ? Math.max(proposal.cols, PHONE_MIN_COLS) : proposal.cols;
  terminal.resize(Math.max(2, cols), Math.max(2, proposal.rows));
}

export function TerminalPane({ sessionId, onSession, onSize, onEnded, composer }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const link = useRef<TerminalLink | null>(null);
  const ctrlArmed = useRef(false);

  const phone = usePhone();
  const [prefs, setPrefs] = usePrefs();
  const fontSize = terminalFontSize(phone, prefs.terminalFontStep);
  // The mount effect's resize closure outlives breakpoint flips; it reads the
  // CURRENT answer through this ref rather than the one captured at mount.
  const phoneLive = useRef(phone);
  phoneLive.current = phone;
  const fontLive = useRef(fontSize);
  fontLive.current = fontSize;
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [detail, setDetail] = useState<string>();
  const [ctrl, setCtrl] = useState(false);
  const [exited, setExited] = useState<TerminalSession['exited']>();
  const [scrolledUp, setScrolledUp] = useState(false);

  // The key bar and the composer are bottom bars: toasts stack above them.
  useBottomBar(bottom, phone);

  /**
   * Give the terminal focus back — only if it lost it, and without letting the
   * browser scroll anything to show the textarea (which sits at the cursor).
   */
  const focusTerminal = useCallback(() => {
    const terminal = term.current;
    const element = host.current;
    if (!terminal || !element) return;
    const textarea = terminal.textarea ?? element.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!textarea || document.activeElement === textarea) return;
    // Composing: a key-bar tap must not pull the keyboard away from the
    // composer's input — the bytes went to the pty either way.
    if (bottom.current?.contains(document.activeElement)) return;
    const { scrollLeft, scrollTop } = element;
    try { textarea.focus({ preventScroll: true }); } catch { terminal.focus(); }
    element.scrollLeft = scrollLeft;
    element.scrollTop = scrollTop;
  }, []);

  const send = useCallback((data: string) => {
    link.current?.send(data);
    focusTerminal();
  }, [focusTerminal]);

  /* ---------------- the terminal itself ---------------- */

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const terminal = new Terminal({
      fontSize: fontLive.current,
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono')
        || 'ui-monospace, monospace',
      lineHeight: 1.15,
      cursorBlink: true,
      // The server keeps its own ring for reattach; this is what you can
      // scroll back to *within* a live session.
      scrollback: 5_000,
      allowProposedApi: true,
      theme: xtermTheme(element),
      // A phone has no right mouse button and no easy Ctrl-C, so selecting
      // text should just copy it.
      rightClickSelectsWord: true,
      // A flick through scrollback should land, not glide — the pane's own
      // touch scroller already smooths by the finger.
      smoothScrollDuration: 0,
      // ⌥ as Meta on a Mac keyboard: ⌥B/⌥F word-move in a shell, as in a
      // native terminal, instead of typing ∫ and ƒ.
      macOptionIsMeta: true,
      // xterm's accessibility tree — a live region per row. A preference, not
      // a guess: no web API says a screen reader is present, and the tree is
      // not free on a chatty TUI.
      screenReaderMode: prefs.terminalScreenReader === true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(element);
    // The WebGL renderer after `open`, with the DOM renderer as the fallback:
    // a GPU that refuses a context, or loses one under memory pressure, just
    // leaves xterm drawing rows the slow way. OPT-IN (`prefs.terminalWebgl`):
    // measured under a CDP-driven Chromium, the addon painted nothing at
    // devicePixelRatio ≥ 2 — see the preference's note — and the DOM renderer
    // is the one the phone has been verified with.
    if (prefs.terminalWebgl === true) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        terminal.loadAddon(webgl);
      } catch { /* DOM renderer */ }
    }
    term.current = terminal;
    fit.current = fitAddon;

    const connection = new TerminalLink({
      onData: (bytes) => terminal.write(bytes),
      onStatus: (next, why) => { setStatus(next); setDetail(why); },
      onSession: (session, { reattach }) => {
        // The server replays its scrollback on every attach: a reattach
        // starts from an empty screen or the replay would stack on the copy
        // already there.
        if (reattach) terminal.reset();
        onSession?.(session);
      },
      onExit: (ended) => { setExited(ended); onEnded?.(); },
      onSize: (size) => onSize?.(size),
    });
    link.current = connection;

    // Typing. A `\r` from xterm is Enter; everything else is bytes, including
    // the escape sequences the key bar sends through the same path.
    // "Scrolled up" as a TRANSITION, not per output line: onScroll fires for
    // every write while following, and a setState each time would re-render
    // the pane at output speed.
    let wasUp = false;
    const scrolled = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const up = buffer.viewportY < buffer.baseY;
      if (up !== wasUp) { wasUp = up; setScrolledUp(up); }
    });

    const typed = terminal.onData((data) => {
      if (ctrlArmed.current) {
        const control = applyCtrl(data);
        ctrlArmed.current = false;
        setCtrl(false);
        if (control) { connection.send(control); return; }
      }
      connection.send(data);
    });

    /**
     * Fit the glyphs to the host and tell the pty. The fit is visual and runs
     * per frame (a rotation fires resize dozens of times; each is a repaint);
     * the pty hears the settled size once, on the link's own ~150 ms trailing
     * debounce, and reports it to the page from the same edge.
     */
    const fitNow = (): boolean => {
      if (!element.clientWidth || !element.clientHeight) return false;
      try { fitWithFloor(terminal, fitAddon, phoneLive.current); } catch { return false; /* a detached node mid-teardown */ }
      connection.resize(terminal.cols, terminal.rows);
      return true;
    };
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { fitNow(); });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('orientationchange', resize);

    /**
     * Touch scrolling for the scrollback, done by hand.
     *
     * xterm's screen has no native touch scrolling — the scroll proxy sits
     * under the canvas — so native panning either does nothing or rubber-bands
     * the page. The first move picks an axis: horizontal pans stay native (the
     * host scrolls sideways past the 80-column floor); vertical pans are
     * claimed here and turned into `scrollLines`. Only the NORMAL buffer
     * scrolls — a full-screen TUI (claude, vim) owns its own viewport, and
     * guessing its arrow-key encoding corrupts more than it helps. The
     * `touchstart` listener is PASSIVE (it only reads the finger); only the
     * vertical `touchmove` is cancelled, and only once the axis is known.
     */
    let touchX = 0; let touchY = 0; let axis: 'x' | 'y' | null = null; let carry = 0;
    const touchBegin = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) { axis = 'x'; return; }
      touchX = touch.clientX; touchY = touch.clientY; axis = null; carry = 0;
    };
    const touchScroll = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) return;
      const dx = touchX - touch.clientX;
      const dy = touchY - touch.clientY;
      if (axis === null) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      }
      if (axis === 'x') return;
      if (terminal.buffer.active.type === 'alternate') return;
      if (event.cancelable) event.preventDefault();
      touchX = touch.clientX; touchY = touch.clientY;
      carry += dy;
      const cell = (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1.15);
      const lines = Math.trunc(carry / cell);
      if (lines) { terminal.scrollLines(lines); carry -= lines * cell; }
    };
    element.addEventListener('touchstart', touchBegin, { passive: true });
    element.addEventListener('touchmove', touchScroll, { passive: false });

    /**
     * Repaint on a theme change. `theme.css` resolves `light-dark()` at paint
     * time, so the page repaints itself — but xterm holds a copy of the colours
     * it was constructed with and would keep the old ones. `system` mode sets
     * no attribute at all, which is why the media query is watched too.
     */
    const repaint = () => { terminal.options.theme = xtermTheme(element); };
    const themeAttribute = new MutationObserver(repaint);
    themeAttribute.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', repaint);

    // Fitted BEFORE the first connect — synchronously, because the host is
    // laid out by the time this effect runs — so the mint carries the real
    // size and the pty is never born at xterm's 80×24 defaults. The link
    // flushes the same size on `open` in case the frame moved meanwhile.
    fitNow();
    void connection.connect(sessionId, { cols: terminal.cols, rows: terminal.rows });

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('touchstart', touchBegin);
      element.removeEventListener('touchmove', touchScroll);
      observer.disconnect();
      themeAttribute.disconnect();
      scheme.removeEventListener('change', repaint);
      window.removeEventListener('orientationchange', resize);
      typed.dispose();
      scrolled.dispose();
      connection.dispose();
      terminal.dispose();
      term.current = null;
      fit.current = null;
      link.current = null;
    };
    // `phone`, the font and the screen-reader pref are read once to construct
    // the terminal; re-running on a change would tear down a live shell. The
    // font follows live in the effect below. The rest is keyed by `sessionId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live, not mount-captured: the font changes with a breakpoint flip (a
  // rotation on a tablet, a desktop-loaded session opened on a phone) or a
  // tap on A−/A+ — the glyphs re-size and the terminal refits without tearing
  // down the live shell.
  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    if (terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    try { if (fit.current) fitWithFloor(terminal, fit.current, phone); } catch { /* mid-teardown */ }
    if (link.current && terminal.cols && terminal.rows) {
      link.current.resize(terminal.cols, terminal.rows);
    }
  }, [fontSize, phone]);

  const reconnect = useCallback(() => {
    const terminal = term.current;
    if (!terminal || !link.current) return;
    setExited(undefined);
    void link.current.connect(sessionId, { cols: terminal.cols, rows: terminal.rows });
  }, [sessionId]);

  const paste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) send(text);
    } catch {
      toast('The browser would not hand over the clipboard', 'error');
    }
  }, [send]);

  const armCtrl = useCallback((next: boolean) => {
    ctrlArmed.current = next;
    setCtrl(next);
    focusTerminal();
  }, [focusTerminal]);

  const stepFont = useCallback((delta: -1 | 1) => {
    const current = terminalFontSize(phoneLive.current, prefs.terminalFontStep);
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta));
    if (next === current) return;
    setPrefs({ terminalFontStep: prefs.terminalFontStep + (next - current) });
    focusTerminal();
  }, [prefs.terminalFontStep, setPrefs, focusTerminal]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(status !== 'live' || exited) && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-surface px-3 py-2 text-sm"
          role="status"
          aria-live="polite"
        >
          <Plug size={15} className="shrink-0 text-ink-muted" aria-hidden />
          <span className="min-w-0 flex-1 text-ink-muted">
            {exited
              ? exited.closedByOperator
                ? 'This shell was closed.'
                : `The shell exited (${exited.signal ? `signal ${exited.signal}` : `status ${exited.code}`}).`
              : status === 'connecting' ? 'Connecting…'
                : status === 'reconnecting' ? `Reconnecting… (${detail ?? '1'})`
                  : status === 'error' ? (detail ?? 'The connection failed.')
                    : detail === 'no heartbeat' ? 'The connection went quiet — reconnecting.'
                      : 'Disconnected.'}
          </span>
          {status !== 'connecting' && !exited && (
            <Button size="sm" onClick={reconnect}>
              <RotateCw size={14} aria-hidden /> Reconnect
            </Button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={host}
          // `min-h-0` so the flex child may actually shrink; without it a long
          // scrollback sets the track height and the shell scrolls sideways.
          className={cn(
            // `phase-term` is the hook `terminal.css` needs to out-specify
            // xterm's own `.xterm .xterm-viewport { background: #000 }`.
            'phase-term h-full bg-ground-deep px-1 py-1',
            // The 80-column floor makes the content wider than the phone; the
            // host is the horizontal scroller, and `touch-action` says so out
            // loud — vertical pans go to the pane's own touch scroller,
            // horizontal to here, pinch to the page (whose `--app-height` now
            // survives a zoom), and nothing is left for the browser to guess
            // (and rubber-band). No `pan-y`: declaring it would let the
            // browser promote a vertical drag to a native pan whose touchmove
            // is no longer cancelable, fighting the scroller mid-gesture.
            phone
              ? 'overflow-x-auto overflow-y-hidden overscroll-x-contain [touch-action:pan-x_pinch-zoom]'
              : 'overflow-hidden',
            status !== 'live' && 'opacity-70',
          )}
        />
        {/* A flick through 5,000 lines of scrollback needs a way home — the
            scrollbar styling is a no-op on touch. */}
        {scrolledUp && (
          <Button
            size="sm"
            className="absolute bottom-2 right-3 z-(--z-base) shadow-card"
            onClick={() => { term.current?.scrollToBottom(); focusTerminal(); }}
          >
            <ArrowDown size={13} aria-hidden /> Latest
          </Button>
        )}
      </div>

      {phone && (
        <div ref={bottom} className="shrink-0">
          {composer && <Composer onSend={send} />}
          <KeyBar onSend={send} ctrl={ctrl} onCtrl={armCtrl} onPaste={paste} onFont={stepFont} />
        </div>
      )}
    </div>
  );
}

/**
 * The ended/gone panels, re-exported so the terminal and agent pages reach them
 * through this module.
 *
 * Not tidiness — a build invariant. Both routes lazy-load one shared chunk, and
 * the bundler names it after the module the routes import. A second such module
 * makes a second facade and renames the chunk (`pane-*` → whatever), which slips
 * past `globIgnores` in `vite.config.ts` and precaches 346 KB of xterm on every
 * first visit. Keeping this file the only facade keeps the name stable, without
 * reaching for `manualChunks` — which drags React into the chunk instead (see
 * the warning in `vite.config.ts`). `scripts/check-dist.mjs` holds both ends.
 */
export { EndedBanner, SessionGone, exitSummary } from './ended';
export { SessionVitals, sessionLinkage } from './vitals';
export { SessionControls, sessionStateNote } from '../agent/session-controls';
export { SessionStrip, SESSION_HINTS, type StripSession } from './strip';
export { Composer } from './composer';
