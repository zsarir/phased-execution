/**
 * The keyboard machinery, exercised against a mutable fake visualViewport.
 * Phone/touch is faked via vi.mock('@/lib/media') — the ONLY way that works;
 * the first matchMedia answer of a run is cached module-level (see
 * guide.test.tsx for the long version).
 */

import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
}));

import { installAppHeight, useKeyboardOpen } from './viewport';

type Listener = () => void;

function fakeViewport(height: number) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    height,
    width: 390,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string) { for (const listener of listeners.get(type) ?? []) listener(); },
  };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');

describe('installAppHeight', () => {
  it('mirrors the visual viewport into --app-height, and stops on uninstall', async () => {
    const vv = fakeViewport(700);
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: vv });
    const uninstall = installAppHeight();
    await frame();
    expect(appHeight()).toBe('700px');

    vv.height = 420; // the keyboard came up
    vv.fire('resize');
    await frame();
    expect(appHeight()).toBe('420px');

    uninstall();
    expect(appHeight()).toBe('');
  });

  it('ignores pinch-zoom — a zoomed page must not shrink the shell', async () => {
    const vv = fakeViewport(700);
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: vv });
    const uninstall = installAppHeight();
    await frame();
    expect(appHeight()).toBe('700px');

    vv.scale = 2.4;
    vv.height = 291;
    vv.fire('resize');
    await frame();
    expect(appHeight()).toBe('700px');
    uninstall();
  });

  it('does nothing where visualViewport is absent — CSS falls back to 100dvh', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: null });
    const uninstall = installAppHeight();
    expect(appHeight()).toBe('');
    uninstall();
  });
});

describe('useKeyboardOpen', () => {
  it('flips on focusin of a text field and back on focusout', async () => {
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(result.current).toBe(true);

    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await frame();
    });
    expect(result.current).toBe(false);
    textarea.remove();
    unmount();
  });

  it('a plain button never counts as a keyboard', async () => {
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    const button = document.createElement('button');
    document.body.appendChild(button);
    await act(async () => {
      button.focus();
      button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(result.current).toBe(false);
    button.remove();
    unmount();
  });
});
