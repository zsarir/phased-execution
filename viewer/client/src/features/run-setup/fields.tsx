/**
 * The field primitives every mode of RunSetup is made of — and the one thing
 * they all do that the old four forms did not: say where the value came from.
 *
 * ## "from defaults" vs "changed here"
 *
 * A launch dialog seeded from Settings ▸ Automation looks exactly like a launch
 * dialog somebody typed into. That is how a run ends up on a model nobody
 * chose: the operator reads a value, assumes it is theirs, and it is the
 * preference — or assumes it is the preference, and it is a leftover from the
 * run's own record. `Provenance` is one muted line under a control saying which
 * of the three answers is true here, and it costs one comparison.
 *
 * The three words are deliberate and exhaustive:
 * - **from defaults** — Settings ▸ Automation, or this console's own fallback.
 * - **from this run** — the run's stored record, which outranks a preference.
 * - **changed here** — the operator touched it; this launch differs.
 */

import type { ReactNode } from 'react';
import { Button, Field, Input, field as fieldClass } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Where a value came from, once the form and its seed are compared. */
export type Source = 'defaults' | 'run' | 'plan' | 'changed';

const SOURCE_WORDS: Record<Source, string> = {
  defaults: 'from defaults',
  run: 'from this run',
  plan: 'from the plan',
  changed: 'changed here',
};

export function Provenance({ source }: { source?: Source }) {
  if (!source) return null;
  return (
    <span
      className={cn('text-2xs', source === 'changed' ? 'text-action' : 'text-ink-faint')}
      data-source={source}
    >
      {SOURCE_WORDS[source]}
    </span>
  );
}

/**
 * Which of the three it is.
 *
 * `seed` is what the form opened on and `origin` is where THAT came from, so a
 * value equal to its seed reports the seed's origin and anything else reports
 * `changed`. Comparison is by JSON because half these values are arrays and
 * objects, and a reference check would call every render a change.
 */
export function sourceOf(value: unknown, seed: unknown, origin: Source): Source {
  return JSON.stringify(value) === JSON.stringify(seed) ? origin : 'changed';
}

/**
 * A labelled control with its provenance.
 *
 * Wraps the design system's `Field` (which owns the label/hint/error wiring and
 * the aria ids) rather than re-implementing it — this adds exactly one thing.
 */
export function SetupField({
  label,
  hint,
  source,
  error,
  inline,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  error?: ReactNode;
  inline?: boolean;
  children: Parameters<typeof Field>[0]['children'];
  className?: string;
}) {
  // Provenance rides in the HINT, not in the label. A label is the control's
  // accessible NAME — "Branch from defaults" is the wrong name for a select,
  // and it also breaks every `getByLabelText('Branch')` in the suite. As a
  // description it is exactly right: `aria-describedby`, read after the name,
  // and it is a description of where the value came from.
  const described =
    source && hint != null ? (
      <>
        {hint} <Provenance source={source} />
      </>
    ) : source ? (
      <Provenance source={source} />
    ) : (
      hint
    );
  return (
    <Field label={label} hint={described} error={error} inline={inline} className={className}>
      {children}
    </Field>
  );
}

/** A `<select>` over `[value, label]` pairs — the shape every vocabulary has. */
export function SelectField({
  label,
  hint,
  source,
  value,
  options,
  disabled,
  onChange,
  placeholder,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  value: string;
  /** `[value, label]`; a `''` entry is offered by the caller, never invented here. */
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
  onChange: (next: string) => void;
  /** The label for a `''` option the caller wants prepended. */
  placeholder?: string;
}) {
  return (
    <SetupField label={label} hint={hint} source={source}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          // `w-full` is load-bearing, not cosmetic: a bare <select> sizes to
          // its WIDEST option, so "Create a work branch per run
          // (pe/console-frontend-redesign)" made the control 423px inside a
          // 390px phone and the whole page scrolled sideways. The parent is
          // `min-w-0`, so full-width here is bounded by the column.
          className={cn(fieldClass, 'w-full')}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder != null && <option value="">{placeholder}</option>}
          {options.map(([id_, text]) => (
            <option key={id_} value={id_}>
              {text}
            </option>
          ))}
        </select>
      )}
    </SetupField>
  );
}

/**
 * A number that may be blank.
 *
 * `type=number` with a STRING value on purpose: the empty string is a real
 * answer on every one of these ("no ceiling", "this console's default"), and
 * coercing here would turn it into `0`, which means the opposite.
 */
export function NumberField({
  label,
  hint,
  source,
  error,
  value,
  min,
  step,
  placeholder = 'none',
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  error?: ReactNode;
  value: string;
  min?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <SetupField label={label} hint={hint} source={source} error={error}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          min={min}
          step={step}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </SetupField>
  );
}

/**
 * A boolean, as the checkbox this console has always used.
 *
 * Deliberately NOT the design system's `Switch`, and the reason is a test:
 * `qa-launcher.test.tsx` asks for `getByRole('checkbox')` with no name, which
 * throws on a second one — that bare query is what holds "the QA activation
 * checkbox is the only checkbox in that dialog" true. A Radix Switch has
 * `role="switch"`, so moving these would not fail that assertion, it would make
 * it vacuous, and a gate that cannot fail is worse than no gate.
 *
 * `disabledReason` rather than a bare `disabled`: a capability that exists and
 * is unavailable has to name the flag that turns it on — the same contract
 * `QaButton` and `RecoveryActions` keep. A control that simply greys out
 * teaches nothing.
 */
export function ToggleField({
  label,
  hint,
  source,
  value,
  disabledReason,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  value: boolean;
  disabledReason?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const off = Boolean(disabledReason) || disabled;
  return (
    <label className="flex flex-wrap items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1 accent-[var(--action)]"
        checked={value && !disabledReason}
        disabled={off}
        title={disabledReason}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1">
        {label} <Provenance source={source} />
        {/* The HINT wins over the reason when both are given: `disabledReason`
            is the terse thing the tooltip needs ("restart with --allow-writes"),
            and the hint is the paragraph that says what is still true anyway.
            Collapsing them loses the second, which is the useful half. */}
        {(hint ?? disabledReason) != null && (
          <span className="block text-2xs text-ink-faint">{hint ?? disabledReason}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A boolean rendered as a pressed button — the "Attach default skills" shape.
 *
 * Its own component for the same reason as above, stated the other way round:
 * this one must NOT be a checkbox, or the QA dialog gains a second one and the
 * bare `getByRole('checkbox')` pin starts throwing.
 */
export function PressField({
  label,
  hint,
  source,
  value,
  disabled,
  on = 'On',
  off = 'Off',
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  value: boolean;
  disabled?: boolean;
  on?: string;
  off?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0">
        <span className="text-ink">{label}</span> <Provenance source={source} />
        {hint != null && <span className="mt-0.5 block text-2xs text-ink-faint">{hint}</span>}
      </span>
      <Button size="sm" aria-pressed={value} disabled={disabled} onClick={() => onChange(!value)}>
        {value ? on : off}
      </Button>
    </div>
  );
}
