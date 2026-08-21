/**
 * Popover, Command and Combobox — the type-to-narrow surfaces. What these
 * tests hold: a Popover opens from its trigger and yields to Escape; cmdk
 * filters the items as you type and owns the honest empty ("nothing
 * matches" is shown, never a blank list); CommandDialog is the palette
 * shape — a dialog named for assistive tech with the chrome hidden; and the
 * Combobox trigger reads as a real `role="combobox"` whose `aria-expanded`
 * tracks, filtering through the same cmdk list and reporting the pick
 * through `onChange`. Portalled content is axe-checked on `document.body`.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from './button';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from './command';
import { Combobox } from './combobox';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

describe('Popover', () => {
  it('opens from the trigger and closes on Escape', async () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Which account</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p>the default login</p>
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Which account' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(await screen.findByText('the default login')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('the default login')).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no axe violations while open (portalled: check the document)', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button>Details</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Details">
          <p>content</p>
        </PopoverContent>
      </Popover>,
    );
    await screen.findByText('content');
    await expectNoAxeViolations(document.body);
  });
});

describe('Command', () => {
  const mount = () =>
    render(
      <Command label="Palette">
        <CommandInput placeholder="Type a command…" aria-label="Search commands" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Plans">
            <CommandItem>Alpha plan</CommandItem>
            <CommandItem>Beta plan</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

  it('typing filters the items', async () => {
    mount();
    const input = screen.getByLabelText('Search commands');
    expect(screen.getByText('Alpha plan')).toBeInTheDocument();
    expect(screen.getByText('Beta plan')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => expect(screen.queryByText('Beta plan')).toBeNull());
    expect(screen.getByText('Alpha plan')).toBeInTheDocument();
  });

  it('nothing matching shows the empty, in words', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing matches.')).toBeInTheDocument();
    expect(screen.queryByText('Alpha plan')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('CommandDialog', () => {
  function Palette() {
    const [open, setOpen] = useState(true);
    return (
      <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Type to jump.">
        <CommandInput aria-label="Search" />
        <CommandList>
          <CommandEmpty>Nothing.</CommandEmpty>
          <CommandItem>Go to run</CommandItem>
        </CommandList>
      </CommandDialog>
    );
  }

  it('is a dialog named for assistive tech with the chrome hidden', async () => {
    render(<Palette />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toBeInTheDocument();
    // hideHeader: the name is sr-only, not a drawn heading with a close button.
    expect(screen.getByText('Command palette')).toHaveClass('sr-only');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText('Go to run')).toBeInTheDocument();
  });

  it('has no axe violations (portalled: check the document)', async () => {
    render(<Palette />);
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
  });
});

describe('Combobox', () => {
  const OPTIONS = [
    { value: 'alpha', label: 'Alpha plan' },
    { value: 'beta', label: 'Beta plan', hint: '11 phases' },
  ];

  it('the trigger is a combobox whose aria-expanded tracks', async () => {
    render(<Combobox options={OPTIONS} value={null} onChange={() => {}} label="Plan" />);
    const trigger = screen.getByRole('combobox', { name: 'Plan' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Choose…');
    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // aria-controls (Radix's, the popover content) must reference a real
    // element that holds the list — a dangling id is worse than none.
    const controls = trigger.getAttribute('aria-controls') ?? '';
    const controlled = document.getElementById(controls);
    expect(controlled).not.toBeNull();
    expect(controlled?.contains(screen.getByRole('listbox'))).toBe(true);
  });

  it('typing filters; picking reports through onChange and closes', async () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value={null} onChange={onChange} label="Plan" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Plan' }));
    const search = await screen.findByPlaceholderText('Type to filter…');
    fireEvent.change(search, { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('Alpha plan')).toBeNull());
    fireEvent.click(screen.getByText('Beta plan'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('beta');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('shows the selected label and clears when clearable', async () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="beta" onChange={onChange} label="Plan" clearable />);
    const trigger = screen.getByRole('combobox', { name: 'Plan' });
    expect(trigger).toHaveTextContent('Beta plan');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText('Beta plan', { selector: '[cmdk-item] span' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('has no axe violations while open (portalled: check the document)', async () => {
    render(<Combobox options={OPTIONS} value="alpha" onChange={() => {}} label="Plan" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Plan' }));
    await screen.findByRole('listbox');
    await expectNoAxeViolations(document.body);
  });
});
