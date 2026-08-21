/**
 * Dialog, Sheet, AlertDialog — the modal surfaces. What these tests hold:
 * every one is a real `role="dialog"`/`"alertdialog"` NAMED by its title —
 * `hideHeader` keeps the name for assistive tech (sr-only) while dropping
 * the drawn chrome; every one is sized by `--app-height` (the visible
 * viewport) and NEVER by `dvh`, which on iOS ignores the software keyboard
 * and left buttons underneath it; a right-hand sheet carries its own Close
 * button; and an AlertDialog's Confirm is the only way through — Cancel
 * closes without calling it.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from './alert-dialog';
import { Button } from './button';
import { Dialog, DialogContent } from './dialog';
import { Sheet, SheetContent } from './sheet';

/** The phone rule, as a class-string assertion: sized by --app-height, never dvh. */
const expectAppHeightSized = (el: HTMLElement) => {
  expect(el.className).toContain('--app-height');
  expect(el.className).not.toMatch(/dvh/);
};

describe('Dialog', () => {
  it('is a dialog named by its title, with the header drawn', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Start phase" description="Choose how it boards.">
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Start phase' });
    expect(dialog).toHaveAccessibleDescription('Choose how it boards.');
    expect(screen.getByText('Start phase')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expectAppHeightSized(dialog);
  });

  it('hideHeader keeps the accessible name but draws no chrome', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Command palette" description="Type to jump." hideHeader>
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Command palette')).toHaveClass('sr-only');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('the corner Close closes it', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Start phase" description="Options.">
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no axe violations (portalled: check the document)', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Start phase" description="Choose how it boards.">
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
  });
});

describe('Sheet', () => {
  it('side="bottom": a dialog named by its (sr-only) title, riding --app-height', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent title="More" description="The rest of the tabs." side="bottom">
          <p>tray</p>
        </SheetContent>
      </Sheet>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'More' });
    expect(screen.getByText('More')).toHaveClass('sr-only');
    expectAppHeightSized(dialog);
    // The bottom sheet is dismissed by scrim or swipe, not a corner button.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('side="right": a drawer with its title drawn and a Close button', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent title="Notifications" description="What arrived." side="right">
          <p>drawer</p>
        </SheetContent>
      </Sheet>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(screen.getByText('Notifications')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expectAppHeightSized(dialog);
  });

  it('has no axe violations on both sides (portalled: check the document)', async () => {
    const { unmount } = render(
      <Sheet defaultOpen>
        <SheetContent title="More" description="Tabs." side="bottom">
          <p>tray</p>
        </SheetContent>
      </Sheet>,
    );
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
    unmount();
    render(
      <Sheet defaultOpen>
        <SheetContent title="Notifications" description="Arrived." side="right">
          <p>drawer</p>
        </SheetContent>
      </Sheet>,
    );
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
  });
});

describe('AlertDialog', () => {
  it('renders title and description; Confirm calls onConfirm', async () => {
    const onConfirm = vi.fn();
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent
          title="Stop this run?"
          description="Its session is checkpointed first."
          confirmLabel="Stop run"
          destructive
          onConfirm={onConfirm}
        />
      </AlertDialog>,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop this run?' });
    expect(dialog).toHaveAccessibleDescription('Its session is checkpointed first.');
    expectAppHeightSized(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Cancel closes without confirming — "clicked past it" is not an outcome', async () => {
    const onConfirm = vi.fn();
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent title="Clear the inbox?" description="Gone is gone." onConfirm={onConfirm} />
      </AlertDialog>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('opens from its trigger', async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="danger">Force release</Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title="Force release?"
          description="The holder may still be alive."
          onConfirm={() => {}}
        />
      </AlertDialog>,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Force release' }));
    expect(await screen.findByRole('alertdialog', { name: 'Force release?' })).toBeInTheDocument();
  });

  it('has no axe violations (portalled: check the document)', async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent title="Stop this run?" description="Checkpointed first." onConfirm={() => {}} />
      </AlertDialog>,
    );
    await screen.findByRole('alertdialog');
    await expectNoAxeViolations(document.body);
  });
});
