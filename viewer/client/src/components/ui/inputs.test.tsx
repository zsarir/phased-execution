/**
 * Input, Textarea, Label, Separator — the bare form controls. What these
 * tests hold: an input named by a real `<Label htmlFor>`; the invalid state
 * arrives through `aria-invalid` (the form layer's channel — never a second
 * prop) and the failed-border hook rides that attribute; `block` is the one
 * width knob; a Label's required mark is decoration (`aria-hidden`) because
 * the control itself carries `aria-required`; a Separator is decorative by
 * default and a real boundary only when asked.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Input } from './input';
import { Label } from './label';
import { Separator } from './separator';
import { Textarea } from './textarea';

describe('Input', () => {
  it('is named by its label and carries the field class', () => {
    render(
      <div>
        <Label htmlFor="port">Port</Label>
        <Input id="port" defaultValue="4123" />
      </div>,
    );
    const input = screen.getByLabelText('Port');
    expect(input).toHaveValue('4123');
    expect(input.className).toContain('h-9');
  });

  it('the invalid styling hook rides aria-invalid, not a prop of its own', () => {
    render(<Input aria-label="Port" aria-invalid />);
    const input = screen.getByLabelText('Port');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.className).toContain('aria-[invalid=true]:border-failed/70');
  });

  it('block makes it fill its container', () => {
    render(<Input aria-label="Wide" block />);
    expect(screen.getByLabelText('Wide')).toHaveClass('w-full');
    render(<Input aria-label="Narrow" />);
    expect(screen.getByLabelText('Narrow')).not.toHaveClass('w-full');
  });

  it('has no axe violations with a real label', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="repo">Repository</Label>
        <Input id="repo" block placeholder="~/code/project" />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Textarea', () => {
  it('renders rows and shares the invalid hook', () => {
    render(<Textarea aria-label="Notes" rows={5} aria-invalid />);
    const area = screen.getByLabelText('Notes');
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveAttribute('rows', '5');
    expect(area.className).toContain('aria-[invalid=true]:border-failed/70');
  });

  it('block widens it; the height is its own, never the h-9 control class', () => {
    render(<Textarea aria-label="Body" block />);
    const area = screen.getByLabelText('Body');
    expect(area).toHaveClass('w-full');
    expect(area.className).not.toContain('h-9');
  });

  it('has no axe violations with a real label', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="why">Why</Label>
        <Textarea id="why" block defaultValue="Because the gate said so." />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Label', () => {
  it('required draws the mark as decoration only', () => {
    const { container } = render(
      <Label htmlFor="x" required>
        Name
      </Label>,
    );
    const mark = container.querySelector('[aria-hidden]');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('*');
  });

  it('carries an inline hint', () => {
    render(
      <Label htmlFor="x" hint="optional">
        Alias
      </Label>,
    );
    expect(screen.getByText('optional')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="name" required hint="as git knows you">
          Name
        </Label>
        <Input id="name" aria-required />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Separator', () => {
  it('is decorative by default — hidden from assistive tech', () => {
    const { container } = render(<Separator />);
    const rule = container.firstElementChild as HTMLElement;
    expect(rule.getAttribute('role')).toBe('none');
    expect(rule).toHaveClass('h-px', 'w-full');
  });

  it('decorative={false} is a real separator with an orientation', () => {
    const { container } = render(<Separator decorative={false} orientation="vertical" />);
    const rule = container.firstElementChild as HTMLElement;
    expect(rule).toHaveAttribute('role', 'separator');
    expect(rule).toHaveAttribute('aria-orientation', 'vertical');
    expect(rule).toHaveClass('w-px');
  });

  it('has no axe violations both ways', async () => {
    const { container } = render(
      <div>
        <p>above</p>
        <Separator />
        <p>below</p>
        <Separator decorative={false} />
        <p>after</p>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
