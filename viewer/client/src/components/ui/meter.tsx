import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { UiState } from '@/lib/status-vocab';

/**
 * A meter: one quantity against its ceiling — a usage window, a run's spend
 * against its budget, a phase's weight against the session budget.
 *
 * `role="meter"` with the real numbers, so it reads as "62 of 100" and not
 * as a decoration; the painted share is clamped to the bar but the numbers
 * are not — over the ceiling the fill turns the failed colour and the text
 * says by how much. Quarter ticks make the share readable without a number
 * beside it, which is what a phone needs.
 */
export function Meter({
  value,
  max = 1,
  min = 0,
  label,
  valueText,
  tone = 'running',
  over: overTone = 'failed',
  showTicks = true,
  className,
  children,
  ...props
}: {
  value: number;
  max?: number;
  min?: number;
  /** The accessible name — what is being measured. */
  label: string;
  /** The human reading ("62 %", "$1.20 of $5.00"); defaults to the percentage. */
  valueText?: string;
  /** The fill's UI-state hue while within the ceiling. */
  tone?: UiState;
  /** The fill's UI-state hue once over the ceiling. */
  over?: UiState;
  showTicks?: boolean;
  /** Slot for a caption under the bar. */
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const span = Math.max(max - min, Number.EPSILON);
  const fraction = (value - min) / span;
  const over = fraction > 1;
  const shown = Math.max(0, Math.min(1, fraction));
  const text = valueText ?? `${Math.round(fraction * 100)} %`;
  return (
    <div className={cn('min-w-0', className)} {...props}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        title={`${label}: ${text}${over ? ' — over' : ''}`}
        className={cn('relative h-2 w-full overflow-hidden rounded-full bg-track', `state-${over ? overTone : tone}`)}
      >
        {showTicks && (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex justify-evenly">
            {[0, 1, 2].map((i) => <span key={i} className="w-px bg-surface/70" />)}
          </span>
        )}
        <span className="block h-full rounded-full bg-state" style={{ width: `${shown * 100}%` }} />
      </div>
      {children}
    </div>
  );
}
