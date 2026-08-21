import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A segmented control — the theme switcher, a sort, a density. One value of
 * several (`type="single"`) or a set (`type="multiple"`); Radix owns the
 * roving focus and the `aria-pressed`/`aria-checked` semantics that the old
 * hand-rolled `ButtonGroup` had to be given by each caller.
 *
 * The selected segment is amber ONLY when the control narrows a view (a
 * filter); for a plain choice (theme, sort) pass `accent={false}` and it reads
 * as the raised surface. Amber is for what needs a person, not for "selected".
 */
export function ToggleGroup({
  className,
  accent = false,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root> & { accent?: boolean }) {
  return (
    <ToggleGroupPrimitive.Root
      data-accent={accent ? '' : undefined}
      className={cn('group/toggle inline-flex overflow-hidden rounded border border-rule', className)}
      {...props}
    />
  );
}

export function ToggleItem({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap border-r border-rule px-2.5 text-xs font-medium text-ink-muted last:border-r-0',
        'transition-colors duration-fast ease-transit hover:bg-surface hover:text-ink',
        'disabled:pointer-events-none disabled:opacity-50',
        '[@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:min-w-(--tap-min)',
        // Selected: the raised surface by default; amber when the group narrows a view.
        'data-[state=on]:bg-surface-raised data-[state=on]:text-ink',
        'group-data-[accent]/toggle:data-[state=on]:bg-accent/15 group-data-[accent]/toggle:data-[state=on]:text-accent',
        className,
      )}
      {...props}
    />
  );
}
