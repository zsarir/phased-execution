import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ForwardedRef } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * `action` is the amber one, and it is rationed: amber means "this is the thing
 * to do now" (start the ready phase, answer the card). A screen with two amber
 * buttons has told you nothing. Everything else is `default` or `ghost`.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium ' +
    'transition-colors duration-fast ease-transit ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    // Every control is thumb-sized on a touch device. On a mouse the same
    // control can be its natural height — 44px of chrome around a text button
    // reads as a form, not a toolbar.
    '[@media(hover:none)]:min-h-(--tap-min)',
  {
    variants: {
      variant: {
        default: 'border border-rule bg-surface text-ink hover:bg-surface-raised hover:border-rule-strong',
        action: 'border border-action/60 bg-action/12 text-action hover:bg-action/20',
        ghost: 'border border-transparent text-ink-muted hover:bg-surface hover:text-ink',
        danger: 'border border-blocked/50 bg-blocked/10 text-blocked hover:bg-blocked/20',
      },
      size: {
        sm: 'h-7 px-2 text-2xs',
        md: 'h-9 px-3 text-sm',
        lg: 'h-11 px-4 text-md',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef(function Button(
  { className, variant, size, asChild = false, type = 'button', ...props }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      // A `<button>` inside a form defaults to `submit`; every button in this
      // app that meant submit says so.
      {...(asChild ? {} : { type })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

/** A segmented group — the theme switcher, density, sort. */
export function ButtonGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn(
        'inline-flex overflow-hidden rounded border border-rule',
        '[&>button]:rounded-none [&>button]:border-0 [&>button]:border-r [&>button]:border-rule',
        '[&>button:last-child]:border-r-0',
        '[&>button[aria-pressed=true]]:bg-action/15 [&>button[aria-pressed=true]]:text-action',
        className,
      )}
      {...props}
    />
  );
}
