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
  const lastActive = useRef<string | null>(null);
  // The strip hides its scrollbar, so tabs 5–7 were invisible AND undiscoverable
  // on a phone. Two affordances: the active trigger scrolls itself into view,
  // and a fade on the trailing edge says "there is more" — via mask-image so it
  // works on both themes without a painted cap.
  //
  // Two hard-won rules in this effect. It runs after every render (no dep
  // array — the active trigger is DOM state Radix owns, not a prop), so it
  // must SCROLL only when the active tab actually changed: the run tab
  // re-renders on every SSE event, and an unconditional scroll made the page
  // crawl back up to the strip while you were reading below it. And it moves
  // `scrollLeft` by hand rather than calling `scrollIntoView`, because that
  // scrolls every ancestor too — even `block: 'nearest'` yanks the PAGE when
  // the strip is above the viewport. The strip is the only thing this
  // affordance is allowed to move.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    const key = active.id || active.textContent || '';
    if (key === lastActive.current) return;
    lastActive.current = key;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (right > node.scrollLeft + node.clientWidth) node.scrollLeft = right - node.clientWidth;
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
