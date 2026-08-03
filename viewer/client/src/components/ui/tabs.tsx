import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Radix owns the roving-tabindex and arrow-key behaviour, which is the part
 * hand-rolled tabs always get wrong. What is added here is that the list scrolls
 * horizontally on a phone rather than wrapping: seven plan tabs wrapped onto
 * three lines pushed the plan itself off the screen.
 */

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'flex items-stretch gap-1 overflow-x-auto border-b border-rule',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative shrink-0 whitespace-nowrap px-3 py-2 text-sm text-ink-muted',
        'border-b-2 border-transparent -mb-px transition-colors duration-fast ease-transit',
        'hover:text-ink',
        'data-[state=active]:border-action data-[state=active]:text-ink',
        '[@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-3 outline-none', className)} {...props} />;
}
