import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A label. Radix's `Label` is a `<label>` that also stops a double-click on
 * the text from selecting it — the one thing a hand-rolled label gets wrong
 * on a phone, where a long-press on the word selects the page.
 *
 * `required` draws the mark; the control itself carries `aria-required`, so
 * the mark is decoration for sighted eyes and never the only signal.
 */
export function Label({
  className,
  required = false,
  hint,
  children,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root> & { required?: boolean; hint?: string }) {
  return (
    <LabelPrimitive.Root
      className={cn('inline-flex items-baseline gap-1 text-sm font-medium text-ink', className)}
      {...props}
    >
      {children}
      {required && <span aria-hidden className="text-accent">*</span>}
      {hint && <span className="text-2xs font-normal text-ink-faint">{hint}</span>}
    </LabelPrimitive.Root>
  );
}
