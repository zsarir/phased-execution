import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A dialog — a question or a form in the middle of the screen. Radix owns
 * focus trapping, `aria-modal`, Escape and outside-click; this owns the paint
 * and the phone rules: centred in and bounded by `--app-height` (the visible
 * viewport the shell lays out against — never `dvh`, which on iOS ignores the
 * software keyboard and left the wizard's buttons under it), never sized by
 * the full viewport width (the unit that ignores the scrollbar), scrolling
 * inside itself with overscroll contained.
 *
 * The edge-anchored variant lives in `sheet.tsx`; the one that cannot be
 * dismissed by accident in `alert-dialog.tsx`.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

const scrim =
  'fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px] data-[state=open]:animate-fade';

export function DialogContent({
  className,
  children,
  title,
  description,
  hideHeader = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** Required for assistive tech; rendered as the header unless `hideHeader`. */
  title: string;
  description?: string;
  /** Keep the title for screen readers only — the palette draws its own chrome. */
  hideHeader?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-[calc(var(--app-height,100%)/2)] z-(--z-scrim) w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[min(42rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto overscroll-contain',
          'rounded-lg border border-rule bg-surface p-4 shadow-card outline-none',
          'data-[state=open]:animate-fade',
          className,
        )}
        {...props}
      >
        {hideHeader ? (
          <>
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>}
          </>
        ) : (
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
              className="-m-1 inline-grid size-8 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
            >
              <X size={16} aria-hidden />
            </DialogPrimitive.Close>
          </div>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

/* The sheet used to live here; it is its own file now (bottom on a phone,
   right for a drawer). Re-exported so nothing that imported it from here
   breaks until Phase 11 sweeps those imports. */
export { Sheet, SheetClose, SheetContent, SheetTrigger } from './sheet';
