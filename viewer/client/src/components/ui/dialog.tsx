import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const scrim =
  'fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px] data-[state=open]:animate-fade';

export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-(--z-scrim) w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto overscroll-contain',
          'rounded-lg border border-rule bg-surface p-4 shadow-card',
          className,
        )}
        {...props}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="font-display text-xl">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-1 text-sm text-ink-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-m-1 shrink-0 rounded p-1 text-ink-faint hover:bg-surface-raised hover:text-ink"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

/* ------------------------------------------------------------------ *
 * Sheet — the same primitive, entering from the bottom edge.
 *
 * A phone dismisses a sheet by swiping down or tapping outside, and it must
 * clear the home indicator; the safe-area padding is not decoration.
 * ------------------------------------------------------------------ */

export function SheetContent({
  className,
  children,
  title,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-(--z-scrim) max-h-[85dvh] overflow-y-auto overscroll-contain',
          'rounded-t-lg border-t border-rule bg-surface pb-safe shadow-card',
          'data-[state=open]:animate-rise',
          className,
        )}
        {...props}
      >
        <div className="sticky top-0 bg-surface pt-2">
          <div className="mx-auto h-1 w-9 rounded-full bg-rule-strong" aria-hidden />
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        </div>
        <div className="p-3">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
