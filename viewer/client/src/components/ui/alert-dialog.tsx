import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { buttonVariants } from './button';

/**
 * For the answers that cannot be taken back: stop a run, force a lock, clear the
 * inbox. Distinct from `Dialog` on purpose — this one has no dismiss affordance
 * in the corner and no outside-click close, so "I clicked past it" is not one of
 * the outcomes.
 */

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof AlertDialogPrimitive.Content>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px]" />
      <AlertDialogPrimitive.Content
        className={cn(
          // Centred in `--app-height` (what is visible above the keyboard),
          // never in `dvh` — see dialog.tsx.
          'fixed left-1/2 top-[calc(var(--app-height,100%)/2)] z-(--z-scrim) w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(var(--app-height,100%)-2rem)] overflow-y-auto overscroll-contain',
          'rounded-lg border border-rule bg-surface p-4 shadow-card',
          className,
        )}
        {...props}
      >
        <AlertDialogPrimitive.Title className="font-display text-lg">{title}</AlertDialogPrimitive.Title>
        {description != null && (
          <AlertDialogPrimitive.Description className="mt-1.5 text-sm text-ink-muted">
            {description}
          </AlertDialogPrimitive.Description>
        )}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: 'ghost' }))}>
            {cancelLabel}
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action
            onClick={onConfirm}
            className={cn(buttonVariants({ variant: destructive ? 'danger' : 'action' }))}
          >
            {confirmLabel}
          </AlertDialogPrimitive.Action>
        </div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}
