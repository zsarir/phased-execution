import type { ForwardedRef, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * A multi-line input. Shares the field's border, ground, radius and invalid
 * state with `Input`; the height is its own (rows), so the `h-9` control
 * class is not reused — a textarea that is 36 px tall is a defect.
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  block?: boolean;
}

export const Textarea = forwardRef(function Textarea(
  { className, block = false, rows = 3, ...props }: TextareaProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'min-w-0 rounded border border-rule bg-ground px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint',
        'hover:border-rule-strong focus-visible:border-rule-strong disabled:opacity-50',
        'aria-[invalid=true]:border-failed/70 aria-[invalid=true]:focus-visible:outline-failed',
        // A textarea grows with its content on a phone rather than scrolling
        // inside a 3-row box under the keyboard.
        'field-sizing-content max-h-[min(20rem,calc(var(--app-height,100%)*0.5))]',
        block && 'w-full',
        className,
      )}
      {...props}
    />
  );
});
