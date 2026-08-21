/**
 * Switch, Checkbox, RadioGroup, ToggleGroup — the choice controls. What
 * these tests hold: a Switch is a real `role="switch"` whose click flips
 * `aria-checked` and `data-state` (the stylesheet's channel); a Checkbox
 * reports through `onCheckedChange` and can honestly say "some of these"
 * (`indeterminate`); a RadioItem is a whole labelled row — label and help
 * line visible, the radio checked by clicking; a ToggleGroup's selected
 * segment reads through `data-state="on"` and is amber ONLY when the caller
 * says the group narrows a view (`accent` → `data-accent` on the root).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Checkbox } from './checkbox';
import { RadioGroup, RadioItem } from './radio-group';
import { Switch } from './switch';
import { ToggleGroup, ToggleItem } from './toggle-group';

describe('Switch', () => {
  it('click flips aria-checked and data-state', () => {
    render(<Switch aria-label="Auto-recover" />);
    const control = screen.getByRole('switch', { name: 'Auto-recover' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAttribute('data-state', 'checked');
    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('reports through onCheckedChange', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Notify" onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('has no axe violations', async () => {
    const { container } = render(<Switch aria-label="Auto-recover" defaultChecked />);
    await expectNoAxeViolations(container);
  });
});

describe('Checkbox', () => {
  it('click reports through onCheckedChange', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Include QA" onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include QA' }));
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('indeterminate renders as "some of these"', () => {
    render(<Checkbox aria-label="All skills" checked="indeterminate" />);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(box).toHaveAttribute('data-state', 'indeterminate');
    expect(box.querySelector('svg')).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Checkbox aria-label="Include QA" defaultChecked />);
    await expectNoAxeViolations(container);
  });
});

describe('RadioGroup + RadioItem', () => {
  const mount = (onValueChange?: (v: string) => void) =>
    render(
      <RadioGroup aria-label="Permission profile" defaultValue="guarded" onValueChange={onValueChange}>
        <RadioItem value="guarded" label="Guarded" description="Ask before anything sharp." />
        <RadioItem value="standard" label="Standard" description="The shipped defaults." />
      </RadioGroup>,
    );

  it('items render as radios with label and help line visible', () => {
    mount();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Guarded')).toBeVisible();
    expect(screen.getByText('Ask before anything sharp.')).toBeVisible();
  });

  it('clicking one checks it and reports the value', () => {
    const onValueChange = vi.fn();
    mount(onValueChange);
    const standard = screen.getByRole('radio', { name: /Standard/ });
    expect(standard).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(standard);
    expect(standard).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Guarded/ })).toHaveAttribute('aria-checked', 'false');
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('standard');
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('ToggleGroup + ToggleItem', () => {
  it('type="single": clicking selects (data-state="on") and reports the value', () => {
    const onValueChange = vi.fn();
    render(
      <ToggleGroup type="single" aria-label="Density" onValueChange={onValueChange}>
        <ToggleItem value="cozy">Cozy</ToggleItem>
        <ToggleItem value="compact">Compact</ToggleItem>
      </ToggleGroup>,
    );
    const compact = screen.getByText('Compact').closest('button') as HTMLElement;
    expect(compact).toHaveAttribute('data-state', 'off');
    fireEvent.click(compact);
    expect(compact).toHaveAttribute('data-state', 'on');
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('compact');
  });

  it('accent marks the root — amber is for a group that narrows a view', () => {
    const { container: accented } = render(
      <ToggleGroup type="single" accent aria-label="Filter">
        <ToggleItem value="all">All</ToggleItem>
      </ToggleGroup>,
    );
    expect(accented.firstElementChild).toHaveAttribute('data-accent');
    const { container: plain } = render(
      <ToggleGroup type="single" aria-label="Theme">
        <ToggleItem value="dark">Dark</ToggleItem>
      </ToggleGroup>,
    );
    expect(plain.firstElementChild).not.toHaveAttribute('data-accent');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ToggleGroup type="single" defaultValue="cozy" aria-label="Density">
        <ToggleItem value="cozy">Cozy</ToggleItem>
        <ToggleItem value="compact">Compact</ToggleItem>
      </ToggleGroup>,
    );
    await expectNoAxeViolations(container);
  });
});
