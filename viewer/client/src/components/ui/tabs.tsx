import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useEffect, useRef } from 'react';
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
  const list = useRef<HTMLDivElement>(null);
  // The strip hides its scrollbar, so tabs 5–7 were invisible AND undiscoverable
  // on a phone. Two affordances: the active trigger scrolls itself into view
  // (the guide's own idiom), and a fade on the trailing edge says "there is
  // more" — via mask-image so it works on both themes without a painted cap.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[data-state="active"]');
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
  return (
    <TabsPrimitive.List
      ref={list}
      className={cn(
        'flex items-stretch gap-1 overflow-x-auto border-b border-rule',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'max-md:[mask-image:linear-gradient(90deg,black_88%,transparent)]',
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
