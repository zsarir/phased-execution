import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form';
import {
  cloneElement,
  isValidElement,
  useId,
  type FormHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { Label } from './label';

/**
 * Forms, the accessible way, once.
 *
 * `Field` is the unit: a label, the control, a hint, an error — wired by id
 * so the control is named by its label, described by its hint and its error,
 * and marked invalid when the error is shown (`aria-invalid`, which the
 * inputs paint by). Every form in the console composes these; nothing builds
 * a label/input pair by hand.
 *
 * `Form` + `FormField` are the react-hook-form layer: `Form` provides the
 * context, `FormField` is a `Controller` that renders a `Field` with the
 * control bound and the error read from the form state. A `Field` also
 * works alone, for a control whose state lives elsewhere (a Switch that
 * saves on change).
 *
 * Validation is the caller's schema (zod/mini through a resolver); this file
 * knows nothing about shapes — it only shows what the resolver said.
 */

/** Ids for a control and the elements that describe it. */
export function useFieldIds(explicit?: string): { id: string; hintId: string; errorId: string } {
  const generated = useId();
  const id = explicit ?? `field-${generated}`;
  return { id, hintId: `${id}-hint`, errorId: `${id}-error` };
}

export interface FieldProps {
  label: ReactNode;
  /** One line under the label — what this does, the default, the unit. */
  hint?: ReactNode;
  /** The resolver's message; shown in the failed colour and announced. */
  error?: ReactNode;
  required?: boolean;
  /** The control. A single element: its `id`, `aria-*` are filled in here. */
  children: ReactElement | ((ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode);
  id?: string;
  /** Put the control beside the label (a Switch, a Checkbox) rather than under it. */
  inline?: boolean;
  className?: string;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  children,
  id: explicitId,
  inline = false,
  className,
}: FieldProps) {
  const { id, hintId, errorId } = useFieldIds(explicitId);
  const describedBy =
    [hint != null ? hintId : null, error != null ? errorId : null].filter(Boolean).join(' ') || undefined;
  const invalid = error != null;
  const control =
    typeof children === 'function'
      ? children({ id, describedBy, invalid })
      : isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id,
            'aria-describedby': describedBy,
            'aria-invalid': invalid || undefined,
            'aria-required': required || undefined,
          })
        : children;
  return (
    <div
      className={cn('grid min-w-0 gap-1', inline && 'grid-cols-[1fr_auto] items-center gap-x-3', className)}
    >
      <Label htmlFor={id} required={required} className={cn(inline && 'row-start-1')}>
        {label}
      </Label>
      <div className={cn('min-w-0', inline && 'row-start-1 col-start-2')}>{control}</div>
      {hint != null && !invalid && (
        <p id={hintId} className={cn('text-xs text-ink-muted', inline && 'col-span-2')}>
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} role="alert" className={cn('text-xs text-failed', inline && 'col-span-2')}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The react-hook-form context provider around a real `<form>`. */
export function Form<TValues extends FieldValues>({
  form,
  onSubmit,
  children,
  className,
  ...props
}: {
  form: UseFormReturn<TValues>;
  onSubmit: (values: TValues) => void | Promise<void>;
  children: ReactNode;
} & Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'>) {
  return (
    <FormProvider {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => onSubmit(values))}
        className={cn('grid min-w-0 gap-3', className)}
        {...props}
      >
        {children}
      </form>
    </FormProvider>
  );
}

/**
 * A `Field` bound to a form value. The render prop receives the controller's
 * `field` (value/onChange/onBlur/ref/name) plus the ids, so any control —
 * an Input, a Select, a Switch — binds the same way.
 */
export function FormField<TValues extends FieldValues, TName extends FieldPath<TValues>>({
  name,
  label,
  hint,
  required,
  inline,
  className,
  render,
  ...controller
}: Omit<ControllerProps<TValues, TName>, 'render'> &
  Omit<FieldProps, 'children' | 'error'> & {
    render: (args: {
      field: Parameters<ControllerProps<TValues, TName>['render']>[0]['field'];
      ids: { id: string; describedBy?: string; invalid: boolean };
    }) => ReactNode;
  }) {
  const form = useFormContext<TValues>();
  return (
    <Controller
      name={name}
      control={form.control}
      {...controller}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          hint={hint}
          required={required}
          inline={inline}
          className={className}
          error={fieldState.error?.message}
        >
          {(ids) => render({ field, ids })}
        </Field>
      )}
    />
  );
}
