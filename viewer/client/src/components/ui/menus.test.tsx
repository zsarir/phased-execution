/**
 * Select and DropdownMenu — the closed-list pickers, portalled by Radix.
 * What these tests hold: the trigger opens into a real `role="listbox"` /
 * `role="menu"` with the options as options and the verbs as menuitems;
 * picking one reports through the one channel (`onValueChange` / `onSelect`)
 * and closes; and the open surface passes the axe smoke on `document.body`,
 * because a portal renders outside the container a test would naively check.
 *
 * jsdom has no pointer capture; Radix asks for it, so the two stubs below
 * are the price of opening these at all here.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Label } from './label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

const openPointer = { button: 0, ctrlKey: false, pointerType: 'mouse' };

describe('Select', () => {
  const mount = (onValueChange = vi.fn()) => {
    render(
      <div>
        <Label htmlFor="model">Model</Label>
        <Select onValueChange={onValueChange}>
          <SelectTrigger id="model">
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fable">Fable</SelectItem>
            <SelectItem value="opus" hint="slow">
              Opus
            </SelectItem>
          </SelectContent>
        </Select>
      </div>,
    );
    return onValueChange;
  };

  it('the trigger opens a listbox with the options', async () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Model' }), openPointer);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Fable' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Opus/ })).toBeInTheDocument();
  });

  it('picking an option reports the value and closes', async () => {
    const onValueChange = mount();
    fireEvent.pointerDown(screen.getByRole('combobox'), openPointer);
    const option = await screen.findByRole('option', { name: 'Fable' });
    // Radix selects on pointerup only after a pointer event primed the item's
    // pointer type; the keyboard path is the deterministic one in jsdom.
    fireEvent.keyDown(option, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('fable');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('combobox')).toHaveTextContent('Fable');
  });

  it('has no axe violations while open (portalled: check the document)', async () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('combobox'), openPointer);
    await screen.findByRole('listbox');
    await expectNoAxeViolations(document.body);
  });
});

describe('DropdownMenu', () => {
  const mount = (onSelect = vi.fn()) => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Verbs</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Run</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onSelect}>Freeze</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive>Stop</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    return onSelect;
  };

  it('the trigger opens a menu with the verbs as menuitems', async () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Verbs' }), openPointer);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Freeze' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Stop' })).toHaveClass('text-failed');
  });

  it('clicking an item fires onSelect and closes the menu', async () => {
    const onSelect = mount();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Verbs' }), openPointer);
    const item = await screen.findByRole('menuitem', { name: 'Freeze' });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('has no axe violations while open (portalled: check the document)', async () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Verbs' }), openPointer);
    await screen.findByRole('menu');
    await expectNoAxeViolations(document.body);
  });
});
