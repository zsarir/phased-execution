import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Disclosures in a stack — a run's phases grouped by state, the settings
 * sections on a phone, "how / tried" under an inbox row. Radix owns the
 * `aria-expanded`/`aria-controls` wiring and the keyboard; this owns the
 * paint and the one rule every disclosure here follows: the whole header
 * row is the tap target (44 px on touch), and the chevron only decorates it.
 */
export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item className={cn('border-b border-rule last:border-b-0', className)} {...props} />
  );
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          'group/acc flex flex-1 items-center justify-between gap-3 py-2.5 text-left text-sm font-medium text-ink',
          'transition-colors duration-fast ease-transit hover:text-accent',
          '[@media(hover:none)]:min-h-(--tap-min)',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          size={16}
          aria-hidden
          className="shrink-0 text-ink-faint transition-transform duration-fast ease-transit group-data-[state=open]/acc:rotate-180"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className={cn('overflow-hidden text-sm text-ink-muted data-[state=open]:animate-fade', className)}
      {...props}
    >
      <div className="pb-3">{children}</div>
    </AccordionPrimitive.Content>
  );
}
