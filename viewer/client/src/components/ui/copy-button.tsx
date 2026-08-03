import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonProps } from './button';
import { copy } from './toast';

/**
 * Copy, and say so on the button rather than only in a toast.
 *
 * A boot prompt is the thing this console exists to hand over, and the one
 * question after clicking is "did that work?". The toast answers it for two
 * seconds somewhere else on the screen; the tick answers it where the finger
 * already is.
 */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  size = 'sm',
  variant = 'default',
  ...props
}: {
  /** A string, or a function producing one — for text that is fetched on click. */
  text: string | (() => string | Promise<string>);
  label?: string;
  copiedLabel?: string;
} & Omit<ButtonProps, 'children' | 'onClick'>) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clicking, navigating away, then having the timer fire into a dead component
  // is the classic React warning; clearing on unmount is the whole fix.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Button
      size={size}
      variant={variant}
      title="Copy to clipboard"
      onClick={async () => {
        const value = typeof text === 'function' ? await text() : text;
        if (!(await copy(value, copiedLabel))) return;
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
      {...props}
    >
      {done
        ? <Check size={13} aria-hidden className="text-done" />
        : <Copy size={13} aria-hidden />}
      {done ? copiedLabel : label}
    </Button>
  );
}
