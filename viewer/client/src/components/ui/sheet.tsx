import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A sheet — the Dialog primitive entering from an edge: the BOTTOM on a
 * phone (the tab-bar "More", a session picker, a filter tray) and the RIGHT
 * on a desktop (the bell drawer, the run settings). Same Radix root as
 * `Dialog`, so focus, dismissal and `aria-modal` are identical.
 *
 * Sized by `--app-height` — the visible viewport the shell lays out against —
 * never `dvh`, which on iOS ignores the software keyboard and left a sheet's
 * buttons under it. A bottom sheet rides up with the keyboard (`100% −
 * --app-height` is the keyboard's share of the layout viewport a fixed
 * element is positioned in) and clears the home indicator (`pb-safe`).
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const scrim =
  'fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px] data-[state=open]:animate-fade';

export type SheetSide = 'bottom' | 'right';

export function SheetContent({
  className,
  children,
  title,
  description,
  side = 'bottom',
  showTitle = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** Required for assistive tech; visually hidden unless `showTitle`. */
  title: string;
  description?: ReactNode;
  side?: SheetSide;
  showTitle?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-(--z-scrim) overflow-y-auto overscroll-contain bg-surface shadow-card outline-none',
          side === 'bottom' && [
            // Rides up with the keyboard, never taller than 85 % of what is visible.
            'inset-x-0 bottom-[calc(100%-var(--app-height,100%))] max-h-[calc(var(--app-height,100%)*0.85)]',
            'rounded-t-lg border-t border-rule pb-safe data-[state=open]:animate-rise',
          ],
          side === 'right' && [
            'right-0 top-0 h-(--app-height) w-[min(28rem,calc(100%-2rem))]',
            'border-l border-rule data-[state=open]:animate-fade',
          ],
          className,
        )}
        {...props}
      >
        {side === 'bottom' ? (
          // The handle stays at the top of the sheet's OWN scroller (this is a
          // vertical scroller of its own, not an overflow-x wrapper).
          <div className="sticky top-0 z-(--z-base) bg-surface pt-2">
            <div className="mx-auto h-1 w-9 rounded-full bg-rule-strong" aria-hidden />
            <DialogPrimitive.Title className={showTitle ? 'px-3 pt-2 font-display text-lg' : 'sr-only'}>{title}</DialogPrimitive.Title>
            {description != null && (
              <DialogPrimitive.Description className={showTitle ? 'px-3 text-sm text-ink-muted' : 'sr-only'}>
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="font-display text-lg">{title}</DialogPrimitive.Title>
              {description != null && (
                <DialogPrimitive.Description className="mt-0.5 text-sm text-ink-muted">{description}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-m-1 inline-grid size-9 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
            >
              <X size={16} aria-hidden />
            </DialogPrimitive.Close>
          </div>
        )}
        <div className={side === 'bottom' ? 'p-3' : 'p-4'}>{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
