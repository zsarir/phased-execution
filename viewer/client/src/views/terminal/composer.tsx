/**
 * A one-line composer for a claude session on a phone.
 *
 * Typing straight into xterm's hidden textarea from a phone keyboard fights
 * two things at once: the keyboard's autocorrect and capitalisation rewrite a
 * command mid-word, and the TUI's own line editing sees every intermediate
 * keystroke. A plain input with those turned off, sent as one line, is how a
 * message to the session is actually composed. `Send` hands `onSend` the line
 * WITH its Enter — `text + '\r'`, the keystroke the TUI is waiting for — and
 * the pane writes it through the same path the key bar uses.
 *
 * Phone-only by the pane's choice (a desktop has a real keyboard). Sits above
 * the key bar, registered with it as a bottom bar so toasts clear both.
 */

import { useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui';

export function Composer({ onSend, placeholder = 'Message the session…' }: {
  /** The line with its Enter: `text + '\r'`. */
  onSend(data: string): void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const submit = () => {
    if (!text.trim()) return;
    onSend(`${text}\r`);
    setText('');
    // Keep composing: focus stays here, so the keyboard stays up.
    input.current?.focus({ preventScroll: true });
  };

  return (
    <form
      className="flex shrink-0 items-center gap-1.5 border-t border-rule bg-ground-deep px-2 py-1.5"
      aria-label="Composer"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <input
        ref={input}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label="Message"
        // A command line, not prose: nothing may rewrite it on the way.
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        // text-base = 16px — below that iOS zooms the page on focus.
        className="min-h-(--tap-min) min-w-0 flex-1 rounded border border-rule bg-ground px-3 text-base"
      />
      <Button type="submit" variant="action" className="min-h-(--tap-min) shrink-0" disabled={!text.trim()}>
        <SendHorizontal size={15} aria-hidden /> Send
      </Button>
    </form>
  );
}
