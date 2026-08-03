import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * A tooltip is a hover affordance, and a phone has no hover — so on touch this
 * renders the trigger alone and the information has to exist somewhere a thumb
 * can reach. Radix already suppresses hover-open on touch; what matters is that
 * nothing load-bearing is put in here in the first place.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  ...props
}: {
  content: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
} & Omit<ComponentProps<typeof TooltipPrimitive.Root>, 'children'>) {
  if (content == null || content === '') return <>{children}</>;
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-(--z-toast) max-w-72 rounded border border-rule bg-surface-raised px-2 py-1',
            'text-2xs text-ink shadow-card',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-surface-raised" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
