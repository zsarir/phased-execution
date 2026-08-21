import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * One choice of several, each with a label and an optional line of help —
 * the permission profile, the MCP policy, the on-limit policy. Radix owns
 * the roving focus and the arrow keys; this owns the layout: a whole row is
 * the tap target, not the 16 px dot.
 */
export const RadioGroup = ({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) => (
  <RadioGroupPrimitive.Root className={cn('grid gap-1.5', className)} {...props} />
);

export function RadioItem({
  value,
  label,
  description,
  disabled,
  className,
  id,
}: {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const itemId = id ?? `radio-${value.replace(/[^a-z0-9_-]+/gi, '-')}`;
  return (
    <label
      htmlFor={itemId}
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded border border-transparent px-2 py-1.5',
        'hover:bg-surface-raised has-[[data-state=checked]]:border-rule',
        '[@media(hover:none)]:min-h-(--tap-min)',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <RadioGroupPrimitive.Item
        id={itemId}
        value={value}
        disabled={disabled}
        className={cn(
          'mt-0.5 inline-grid size-4 shrink-0 place-items-center rounded-full border border-rule-strong bg-ground',
          'data-[state=checked]:border-accent',
          'transition-colors duration-fast ease-transit',
        )}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
      </RadioGroupPrimitive.Item>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {description != null && <span className="block text-xs text-ink-muted">{description}</span>}
      </span>
    </label>
  );
}
