import { SendHorizontal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/**
 * A one-line composer: an input and a Send button, for saying one thing to a
 * session — a message to a pty, an Ask, a Steer.
 *
 * Built for a phone keyboard first: autocorrect, capitalisation and
 * spellcheck are OFF (a command line is not prose and nothing may rewrite it
 * on the way), the input is 16 px so iOS does not zoom into it, `enterKeyHint`
 * makes the keyboard's return key say "send", and focus stays in the input
 * after sending so the keyboard stays up. The caller registers the bar it
 * sits in as a bottom bar (`useBottomBar`) so toasts clear it.
 *
 * Hands `onSend` the TEXT. A pty caller appends its own `\r`.
 */
export interface ComposerProps {
  onSend: (text: string) => void;
  placeholder?: string;
  /** The input's accessible name. */
  label?: string;
  sendLabel?: string;
  disabled?: boolean;
  /** Allow an empty send (a bare Enter to a TUI). Default: the button is disabled until there is text. */
  allowEmpty?: boolean;
  /** Multi-line: Shift+Enter inserts a newline, Enter sends. Default single-line. */
  multiline?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  placeholder = 'Message the session…',
  label = 'Message',
  sendLabel = 'Send',
  disabled = false,
  allowEmpty = false,
  multiline = false,
  className,
  autoFocus = false,
}: ComposerProps) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const canSend = !disabled && (allowEmpty || text.trim().length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
    // Keep composing: focus stays here, so the keyboard stays up — without
    // scrolling the page to do it.
    input.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!multiline) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const shared = {
    ref: input,
    value: text,
    onChange: (event: { target: { value: string } }) => setText(event.target.value),
    placeholder,
    'aria-label': label,
    disabled,
    // A command line, not prose: nothing may rewrite it on the way.
    autoCapitalize: 'off' as const,
    autoCorrect: 'off',
    autoComplete: 'off',
    spellCheck: false,
    enterKeyHint: 'send' as const,
    autoFocus,
    onKeyDown,
    // text-base = 16px — below that iOS zooms the page on focus.
    className: cn(
      'min-h-(--tap-min) min-w-0 flex-1 rounded border border-rule bg-ground px-3 text-base text-ink placeholder:text-ink-faint',
      'hover:border-rule-strong focus-visible:border-rule-strong disabled:opacity-50',
      multiline && 'field-sizing-content max-h-[min(10rem,calc(var(--app-height,100%)*0.4))] py-2',
    ),
  };

  return (
    <form
      className={cn('flex shrink-0 items-end gap-1.5 border-t border-rule bg-ground-deep px-2 py-1.5', className)}
      aria-label="Composer"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      {multiline ? <textarea rows={1} {...shared} /> : <input type="text" {...shared} />}
      <Button type="submit" variant="action" className="min-h-(--tap-min) shrink-0" disabled={!canSend}>
        <SendHorizontal size={15} aria-hidden /> {sendLabel}
      </Button>
    </form>
  );
}
