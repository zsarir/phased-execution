import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * An on/off switch — for a setting that takes effect at once (auto-recover,
 * a notification category, a skill in the default set). A checkbox is for a
 * choice inside a form that is submitted; a switch is the submit.
 *
 * The visible track is 36×20; the hit area is the thumb floor on touch
 * (44×44, via padding on the root), so a fat finger lands it. The thumb
 * moves with a transform, not a layout change, and the track reads its state
 * through `data-state` — the accent only when ON, never to attract a press.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'group relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-rule-strong bg-ground-deep',
        'transition-colors duration-fast ease-transit',
        'data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/25',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // The thumb floor without growing the drawn track: padding inside a
        // transparent box-shadow ring extends the hit area on touch devices.
        '[@media(hover:none)]:before:absolute [@media(hover:none)]:before:-inset-3 [@media(hover:none)]:before:content-[""]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 translate-x-0.5 rounded-full bg-ink-muted shadow-card',
          'transition-transform duration-fast ease-transit',
          'data-[state=checked]:translate-x-[1.1rem] data-[state=checked]:bg-accent',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
