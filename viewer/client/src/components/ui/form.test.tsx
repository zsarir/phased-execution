/**
 * Field, Form, FormField — forms, the accessible way, once. What these tests
 * hold: a Field wires label→control→hint→error BY ID, so the control is
 * named by its label, described by its hint, and — when the resolver speaks —
 * described by the error, marked `aria-invalid`, with the message announced
 * (`role="alert"`); the react-hook-form layer surfaces the schema's own
 * words and hands `onSubmit` the values only once they hold. Nothing in the
 * console builds a label/input pair by hand, so this is where that contract
 * is enforced.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from './button';
import { Field, Form, FormField, useFieldIds } from './form';
import { Input } from './input';

function NameForm({ onSubmit }: { onSubmit: (values: { name: string }) => void }) {
  const form = useForm<{ name: string }>({ defaultValues: { name: '' } });
  return (
    <Form form={form} onSubmit={onSubmit} aria-label="Identity">
      <FormField
        name="name"
        label="Name"
        rules={{ required: 'Required' }}
        render={({ field, ids }) => (
          <Input
            id={ids.id}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            name={field.name}
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            block
          />
        )}
      />
      <Button type="submit">Save</Button>
    </Form>
  );
}

describe('Form + FormField (react-hook-form)', () => {
  it("an empty submit announces the schema's own words and marks the control", async () => {
    const onSubmit = vi.fn();
    render(<NameForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Required');
    expect(onSubmit).not.toHaveBeenCalled();

    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toContain(error.id);
  });

  it('filling and submitting hands onSubmit the values', async () => {
    const onSubmit = vi.fn();
    render(<NameForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mobin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'mobin' }));
  });

  it('has no axe violations, valid and invalid', async () => {
    const { container } = render(<NameForm onSubmit={() => {}} />);
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    await expectNoAxeViolations(container);
  });
});

describe('Field alone', () => {
  it('label htmlFor is the control id; the hint id is in aria-describedby', () => {
    const { container } = render(
      <Field label="Port" hint="1–65535">
        <Input />
      </Field>,
    );
    const label = container.querySelector('label') as HTMLLabelElement;
    const input = screen.getByLabelText(/Port/);
    expect(label.htmlFor).toBe(input.id);
    const hint = screen.getByText('1–65535');
    expect(hint.id).not.toBe('');
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(hint.id);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('an error replaces the hint, is announced, and flips aria-invalid', () => {
    render(
      <Field label="Port" hint="1–65535" error="Out of range">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/Port/);
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Out of range');
    expect(screen.queryByText('1–65535')).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('required marks the control itself, not just the label', () => {
    render(
      <Field label="Name" required>
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText(/Name/)).toHaveAttribute('aria-required', 'true');
  });

  it('the render-prop form receives the same ids', () => {
    render(
      <Field label="Model" hint="what boards the phase" id="model">
        {(ids) => (
          <Input id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} />
        )}
      </Field>,
    );
    const input = screen.getByLabelText(/Model/);
    expect(input.id).toBe('model');
    expect(input.getAttribute('aria-describedby')).toBe('model-hint');
  });

  it('useFieldIds derives hint and error ids from the control id', () => {
    let got: { id: string; hintId: string; errorId: string } | undefined;
    function Probe() {
      got = useFieldIds('port');
      return null;
    }
    render(<Probe />);
    expect(got).toEqual({ id: 'port', hintId: 'port-hint', errorId: 'port-error' });
  });

  it('has no axe violations with hint and with error', async () => {
    const { container } = render(
      <div>
        <Field label="Port" hint="1–65535">
          <Input />
        </Field>
        <Field label="Host" error="Required">
          <Input />
        </Field>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
