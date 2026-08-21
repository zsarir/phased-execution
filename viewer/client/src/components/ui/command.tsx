import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { Dialog, DialogContent } from './dialog';

/**
 * A command list — the ⌘K palette, a combobox's list, any "type to narrow,
 * arrow to pick" surface. cmdk owns the filtering, the roving selection and
 * the keyboard; this owns the paint and two rules: the input is 16 px (iOS
 * never zooms into it) and every item is thumb-high on touch.
 *
 * `CommandDialog` is the palette shape: a Dialog whose content is a Command,
 * sized by `--app-height` so it sits above a phone keyboard.
 */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex h-full w-full flex-col overflow-hidden rounded-lg bg-surface text-ink', className)}
      {...props}
    />
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-rule px-3" cmdk-input-wrapper="">
      <Search size={15} aria-hidden className="shrink-0 text-ink-faint" />
      <CommandPrimitive.Input
        className={cn(
          'h-11 w-full min-w-0 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[min(20rem,calc(var(--app-height,100%)*0.5))] overflow-y-auto overscroll-contain p-1', className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn('px-3 py-6 text-center text-sm text-ink-muted', className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden py-1 text-ink',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-faint',
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-rule', className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-ink outline-none',
        'data-[selected=true]:bg-surface-raised data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        '[@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
      {...props}
    />
  );
}

export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ml-auto font-mono text-2xs tracking-wide text-ink-faint', className)} {...props} />;
}

/**
 * The palette shell: a Dialog that is nothing but a Command. The caller
 * supplies the input, lists and items; the title is for assistive tech.
 */
export function CommandDialog({
  open,
  onOpenChange,
  title = 'Command palette',
  description,
  children,
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideHeader
        className="top-[max(1rem,calc(var(--app-height,100%)*0.12))] -translate-y-0 p-0 sm:w-[min(40rem,calc(100%-2rem))]"
      >
        <Command
          className={cn('[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0', className)}
          {...props}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
