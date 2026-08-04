/**
 * One session, one xterm, one socket.
 *
 * Everything stateful lives in refs rather than React state on purpose: a pty
 * is a stream at hundreds of frames a second, and routing it through a
 * `setState` would re-render the tree on every keystroke of output. React owns
 * the chrome around the terminal; xterm owns the terminal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Plug, RotateCw } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
// After xterm's own sheet on purpose — see the file for what it takes back.
import './terminal.css';

import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { TerminalLink, type LinkStatus } from '@/lib/terminal';
import type { TerminalSession } from '@/lib/api';
import { Button, toast } from '@/components/ui';
import { KeyBar, applyCtrl } from './keybar';
import { xtermTheme } from './palette';

export interface TerminalPaneProps {
  sessionId: string;
  onSession?(session: TerminalSession): void;
  /** The size the browser actually settled on, whenever it changes. */
  onSize?(size: { cols: number; rows: number }): void;
  onEnded?(): void;
}

export function TerminalPane({ sessionId, onSession, onSize, onEnded }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const link = useRef<TerminalLink | null>(null);
  const ctrlArmed = useRef(false);

  const phone = usePhone();
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [detail, setDetail] = useState<string>();
  const [ctrl, setCtrl] = useState(false);
  const [exited, setExited] = useState<TerminalSession['exited']>();

  const send = useCallback((data: string) => {
    link.current?.send(data);
    term.current?.focus();
  }, []);

  /* ---------------- the terminal itself ---------------- */

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const terminal = new Terminal({
      // ≥16px on a phone is not a taste call: it is the size below which iOS
      // zooms the page when the hidden textarea takes focus, which leaves the
      // terminal half off-screen with no way back.
      fontSize: phone ? 16 : 14,
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
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(element);
    term.current = terminal;
    fit.current = fitAddon;

    const connection = new TerminalLink({
      onData: (bytes) => terminal.write(bytes),
      onStatus: (next, why) => { setStatus(next); setDetail(why); },
      onSession: (session) => { onSession?.(session); },
      onExit: (ended) => { setExited(ended); onEnded?.(); },
    });
    link.current = connection;

    // Typing. A `\r` from xterm is Enter; everything else is bytes, including
    // the escape sequences the key bar sends through the same path.
    const typed = terminal.onData((data) => {
      if (ctrlArmed.current) {
        const control = applyCtrl(data);
        ctrlArmed.current = false;
        setCtrl(false);
        if (control) { connection.send(control); return; }
      }
      connection.send(data);
    });

    // The pty is authoritative about size, so every fit is followed by telling
    // it what we settled on. Debounced through rAF: a rotation fires resize
    // dozens of times and each one would otherwise be an ioctl and a repaint.
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!element.clientWidth || !element.clientHeight) return;
        try { fitAddon.fit(); } catch { /* a detached node mid-teardown */ }
        connection.resize(terminal.cols, terminal.rows);
        // Reported rather than read back off the session list: that list is
        // fetched, so it carries whatever size the last fetch saw — which after
        // a rotation or a window resize is the previous one.
        onSize?.({ cols: terminal.cols, rows: terminal.rows });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('orientationchange', resize);

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

    resize();
    void connection.connect(sessionId, { cols: terminal.cols, rows: terminal.rows });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeAttribute.disconnect();
      scheme.removeEventListener('change', repaint);
      window.removeEventListener('orientationchange', resize);
      typed.dispose();
      connection.close();
      terminal.dispose();
      term.current = null;
      fit.current = null;
      link.current = null;
    };
    // `phone` is read once, to pick a font size; re-running on a rotation would
    // tear down a live shell. The rest is keyed by `sessionId` from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
    term.current?.focus();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(status !== 'live' || exited) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-surface px-3 py-2 text-sm">
          <Plug size={15} className="shrink-0 text-ink-muted" aria-hidden />
          <span className="min-w-0 flex-1 text-ink-muted">
            {exited
              ? exited.closedByOperator
                ? 'This shell was closed.'
                : `The shell exited (${exited.signal ? `signal ${exited.signal}` : `status ${exited.code}`}).`
              : status === 'connecting' ? 'Connecting…'
                : status === 'error' ? (detail ?? 'The connection failed.')
                  : 'Disconnected.'}
          </span>
          {status !== 'connecting' && !exited && (
            <Button size="sm" onClick={reconnect}>
              <RotateCw size={14} aria-hidden /> Reconnect
            </Button>
          )}
        </div>
      )}

      <div
        ref={host}
        // `min-h-0` so the flex child may actually shrink; without it a long
        // scrollback sets the track height and the shell scrolls sideways.
        className={cn(
          // `phase-term` is the hook `terminal.css` needs to out-specify
          // xterm's own `.xterm .xterm-viewport { background: #000 }`.
          'phase-term min-h-0 flex-1 overflow-hidden bg-ground-deep px-1 py-1',
          status !== 'live' && 'opacity-70',
        )}
      />

      {phone && <KeyBar onSend={send} ctrl={ctrl} onCtrl={armCtrl} onPaste={paste} />}
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
