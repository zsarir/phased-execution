import type { ForwardedRef, InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { field } from './field';

/**
 * A text input. `field` is THE control class (defined once, in field.ts — a
 * source guard holds that) and it already carries the thumb floor; this adds
 * the text colour, the focus ring and an `invalid` state the form layer sets
 * through `aria-invalid`, never through a second prop.
 *
 * Inputs are 16 px on touch by the stylesheet's unlayered floor, which is what
 * stops iOS zooming into them — nothing here may shrink the font.
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Makes the input take the full width of its container (the common case in a Field). */
  block?: boolean;
}

export const Input = forwardRef(function Input(
  { className, block = false, type = 'text', ...props }: InputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        field,
        'min-w-0 text-ink placeholder:text-ink-faint',
        'hover:border-rule-strong focus-visible:border-rule-strong',
        'aria-[invalid=true]:border-failed/70 aria-[invalid=true]:focus-visible:outline-failed',
        block && 'w-full',
        className,
      )}
      {...props}
    />
  );
});
