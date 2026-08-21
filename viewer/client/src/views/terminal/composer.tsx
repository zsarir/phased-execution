/**
 * The terminal's composer: the `ui/composer` primitive, handing the pane the
 * line WITH its Enter — `text + '\r'`, the keystroke the TUI is waiting for —
 * through the same path the key bar uses.
 *
 * Why the line is composed here and not typed straight into xterm's hidden
 * textarea: a phone keyboard's autocorrect and capitalisation rewrite a
 * command mid-word, and the TUI's own line editing sees every intermediate
 * keystroke. The primitive turns all of that off and sends one line.
 *
 * Phone-only by the pane's choice (a desktop has a real keyboard). Sits above
 * the key bar, registered with it as a bottom bar so toasts clear both.
 */

import { Composer as UiComposer } from '@/components/ui/composer';

export function Composer({ onSend, placeholder = 'Message the session…' }: {
  /** The line with its Enter: `text + '\r'`. */
  onSend(data: string): void;
  placeholder?: string;
}) {
  return <UiComposer onSend={(text) => onSend(`${text}\r`)} placeholder={placeholder} />;
}
