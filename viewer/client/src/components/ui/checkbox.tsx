import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A checkbox — a choice inside a form, including the three-state kind
 * (`checked="indeterminate"` for "some of these").
 *
 * The drawn box is 16 px; on touch the hit area is the thumb floor, by the
 * same transparent inset trick the Switch uses. The check is an icon, not a
 * glyph, so it renders the same in every face.
 */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'relative inline-grid size-4 shrink-0 place-items-center rounded-sm border border-rule-strong bg-ground',
        'transition-colors duration-fast ease-transit',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-ground',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:text-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-failed',
        '[@media(hover:none)]:before:absolute [@media(hover:none)]:before:-inset-3.5 [@media(hover:none)]:before:content-[""]',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === 'indeterminate'
          ? <Minus size={12} strokeWidth={3} aria-hidden />
          : <Check size={12} strokeWidth={3} aria-hidden />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
