/**
 * Composer — one line to a session. What these tests hold: Send is disabled
 * until there is text (unless the caller allows a bare Enter to a TUI);
 * `onSend` receives the RAW text — no trailing `\r`, that is the pty
 * caller's own business — and the input clears and keeps focus so the phone
 * keyboard stays up; nothing may rewrite the line on the way (autocorrect,
 * capitalisation and spellcheck are off) and the keyboard's return key says
 * "send"; multiline submits on Enter and keeps Shift+Enter for the newline.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Composer } from './composer';

describe('Composer', () => {
  it('Send stays disabled until there is text', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const button = screen.getByRole('button', { name: /Send/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    expect(button).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } });
    expect(button).toBeDisabled();
  });

  it('submits the raw text, clears, and keeps focus in the input', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Composer' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello');
    expect(onSend.mock.calls[0][0]).not.toContain('\r');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('is a command line, not prose: nothing rewrites it, and return says send', () => {
    render(<Composer onSend={() => {}} />);
    const input = screen.getByLabelText('Message');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('enterkeyhint')).toBe('send');
  });

  it('allowEmpty lets a bare Enter through to a TUI', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} allowEmpty />);
    expect(screen.getByRole('button', { name: /Send/ })).toBeEnabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Composer' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('');
  });

  it('multiline: Enter without shift submits; Shift+Enter is a newline', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} multiline />);
    const area = screen.getByLabelText('Message');
    expect(area.tagName).toBe('TEXTAREA');
    fireEvent.change(area, { target: { value: 'line one' } });
    fireEvent.keyDown(area, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('line one');
  });

  it('disabled means the whole bar is off', () => {
    render(<Composer onSend={() => {}} disabled />);
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Composer onSend={() => {}} label="Message the session" />);
    await expectNoAxeViolations(container);
  });
});
