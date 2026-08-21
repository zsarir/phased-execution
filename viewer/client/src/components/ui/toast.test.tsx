/**
 * Toaster + toast() — severity you can see, raised from anywhere. What
 * these tests hold: `toast()` reaches the mounted Toaster from module level
 * (no provider needed at the call site); each kind is a real variant, not
 * one grey box with different words; an action toast renders its button,
 * the action fires on click, and — because `ms: 0` means "until someone
 * deals with it" — it is the update-prompt shape that must never time out
 * unread.
 *
 * The store is module-level, so every test dismisses what it raised.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { dismissToast, toast, Toaster } from './toast';

const raised: number[] = [];
const raise = (...args: Parameters<typeof toast>): number => {
  let id = 0;
  act(() => {
    id = toast(...args);
  });
  raised.push(id);
  return id;
};

afterEach(() => {
  act(() => {
    for (const id of raised) dismissToast(id);
  });
  raised.length = 0;
});

describe('Toaster + toast()', () => {
  it('a toast raised from module level appears in the mounted Toaster', async () => {
    render(<Toaster />);
    raise('Handoff recorded', 'ok');
    expect(await screen.findByText('Handoff recorded')).toBeInTheDocument();
  });

  it('kinds are real variants — warn does not arrive looking like "Copied"', async () => {
    render(<Toaster />);
    raise('Copied', 'ok');
    raise('The console is running older code', 'warn');
    const okItem = (await screen.findByText('Copied')).closest('li') as HTMLElement;
    const warnItem = (await screen.findByText(/older code/)).closest('li') as HTMLElement;
    expect(okItem.className).not.toBe(warnItem.className);
    expect(warnItem.className).toContain('border-action');
  });

  it('an action toast renders its button and the action fires', async () => {
    const onSelect = vi.fn();
    render(<Toaster />);
    raise('An update is ready', 'info', 0, { label: 'Reload', onSelect });
    const button = await screen.findByRole('button', { name: 'Reload' });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('dismissing removes it', async () => {
    render(<Toaster />);
    const id = raise('Going soon', 'info', 0);
    await screen.findByText('Going soon');
    act(() => dismissToast(id));
    await waitFor(() => expect(screen.queryByText('Going soon')).toBeNull());
  });

  it('has no axe violations with a toast up', async () => {
    render(<Toaster />);
    raise('Saved', 'ok');
    raise('Halted: verify failed', 'error', 0);
    await screen.findByText('Saved');
    await expectNoAxeViolations(document.body);
  });
});
