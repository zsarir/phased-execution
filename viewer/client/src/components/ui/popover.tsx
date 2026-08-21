import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A popover: a small panel anchored to what opened it — a date picker, a
 * combobox's list, a "which account" chooser. Radix owns focus, dismissal
 * and collision flipping; this owns the paint and one rule: a popover is
 * never wider than the visible viewport less a margin, so on a phone it
 * cannot push the page sideways.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-(--z-scrim) min-w-40 max-w-[calc(100%-1rem)] rounded-lg border border-rule bg-surface p-2 text-ink shadow-card outline-none',
          'max-h-[min(24rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto overscroll-contain',
          'data-[state=open]:animate-fade',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
