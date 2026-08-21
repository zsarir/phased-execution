/**
 * The keyboard machinery, exercised against a mutable fake visualViewport.
 * Phone/touch is faked via vi.mock('@/lib/media') — the ONLY way that works;
 * the first matchMedia answer of a run is cached module-level (see
 * guide.test.tsx for the long version).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

import {
  KEYBOARD_MIN_PX, installAppHeight, registerBottomBar, useBottomBars, useKeyboardInset, useKeyboardOpen,
} from './viewport';

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
const prop = (name: string) => document.documentElement.style.getPropertyValue(name);
const appHeight = () => prop('--app-height');

function install(height: number) {
  const vv = fakeViewport(height);
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
  return { vv, uninstall: installAppHeight() };
}

afterEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

describe('installAppHeight', () => {
  it('mirrors the visual viewport into --app-height, and stops on uninstall', async () => {
    const { vv, uninstall } = install(700);
    await frame();
    expect(appHeight()).toBe('700px');

    vv.height = 420; // the keyboard came up
    vv.fire('resize');
    await frame();
    expect(appHeight()).toBe('420px');

    uninstall();
    expect(appHeight()).toBe('');
    expect(prop('--keyboard-inset')).toBe('');
  });

  it('under a pinch-zoom the shell keeps its layout height — and a keyboard still shrinks it', async () => {
    const { vv, uninstall } = install(700);
    await frame();
    expect(appHeight()).toBe('700px');

    // Zoomed 2.4×: the visual viewport is 291px of a 700px layout. The old
    // mirror bailed here and froze; the product with the scale is the layout
    // height the zoomed page still occupies.
    vv.scale = 2.4;
    vv.height = 291;
    vv.fire('resize');
    await frame();
    expect(appHeight()).toBe('698px');
    expect(prop('--keyboard-inset')).toBe('2px');

    // Keyboard under the zoom: 291 → 175 visible, ×2.4 = 420 of layout.
    vv.height = 175;
    vv.fire('resize');
    await frame();
    expect(appHeight()).toBe('420px');
    uninstall();
  });

  it('exposes the keyboard inset — the tallest height seen at this width, minus the current one', async () => {
    const { vv, uninstall } = install(700);
    const { result } = renderHook(() => useKeyboardInset());
    await act(async () => { await frame(); });
    expect(prop('--keyboard-inset')).toBe('0px');
    expect(result.current).toBe(0);

    vv.height = 420;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(prop('--keyboard-inset')).toBe('280px');
    expect(result.current).toBe(280);

    vv.height = 700;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(result.current).toBe(0);
    uninstall();
  });

  it('a rotation resets the baseline — a shorter landscape is not a keyboard', async () => {
    const { vv, uninstall } = install(844);
    const { result } = renderHook(() => useKeyboardInset());
    await act(async () => { await frame(); });

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 844 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 390 });
    vv.height = 390;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(result.current).toBe(0);
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
  async function focusA(tag: 'textarea' | 'button') {
    const element = document.createElement(tag);
    document.body.appendChild(element);
    await act(async () => {
      element.focus();
      element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    return element;
  }

  it('is focus AND a keyboard-sized shrink: a text field alone (a hardware keyboard) is not open', async () => {
    const { vv, uninstall } = install(700);
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    await act(async () => { await frame(); });
    expect(result.current).toBe(false);

    const textarea = await focusA('textarea');
    expect(result.current).toBe(false);

    vv.height = 700 - KEYBOARD_MIN_PX;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(result.current).toBe(true);

    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await frame();
    });
    expect(result.current).toBe(false);
    textarea.remove();
    unmount();
    uninstall();
  });

  it('a shrink alone (the URL bar, a split view) never counts as a keyboard', async () => {
    const { vv, uninstall } = install(700);
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    vv.height = 400;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(result.current).toBe(false);
    unmount();
    uninstall();
  });

  it('a plain button never counts as a keyboard', async () => {
    const { vv, uninstall } = install(700);
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    const button = await focusA('button');
    vv.height = 400;
    await act(async () => { vv.fire('resize'); await frame(); });
    expect(result.current).toBe(false);
    button.remove();
    unmount();
    uninstall();
  });
});

describe('bottom bars', () => {
  it('sum into --bottom-bars while registered, and withdraw', () => {
    const { result } = renderHook(() => useBottomBars());
    const tabBar = document.createElement('nav');
    const keyBar = document.createElement('div');
    Object.defineProperty(tabBar, 'offsetHeight', { value: 60 });
    Object.defineProperty(keyBar, 'offsetHeight', { value: 104 });
    document.body.append(tabBar, keyBar);

    let unregisterTab!: () => void;
    let unregisterKeys!: () => void;
    act(() => { unregisterTab = registerBottomBar(tabBar); });
    expect(prop('--bottom-bars')).toBe('60px');
    act(() => { unregisterKeys = registerBottomBar(keyBar); });
    expect(prop('--bottom-bars')).toBe('164px');
    expect(result.current).toBe(164);

    act(() => { unregisterTab(); });
    expect(prop('--bottom-bars')).toBe('104px');
    act(() => { unregisterKeys(); });
    expect(prop('--bottom-bars')).toBe('0px');
    tabBar.remove();
    keyBar.remove();
  });
});
