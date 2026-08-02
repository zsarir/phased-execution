/**
 * Shared UI state: toasts, the confirm dialog, theme and the list preferences
 * (sort, filters, density) that persist between sessions.
 */

import { useState, useEffect } from './html.js';

const KEY = 'phase-console.ui';

const DEFAULTS = {
  theme: 'system',
  density: 'comfortable',
  sort: 'activity',
  showDocuments: false,
  showComplete: true,
  model: '',
};

let state = load();
const subscribers = new Set();

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { ...DEFAULTS }; }
}

export function getPrefs() { return state; }

export function setPrefs(patch) {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  applyTheme(state.theme);
  for (const notify of subscribers) notify(state);
}

export function usePrefs() {
  const [value, setValue] = useState(state);
  useEffect(() => {
    subscribers.add(setValue);
    return () => subscribers.delete(setValue);
  }, []);
  return [value, setPrefs];
}

export function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/* ---------------- toasts ---------------- */

let toasts = [];
const toastSubscribers = new Set();
let toastId = 0;

export function toast(message, kind = 'ok', ms = 2600) {
  const id = ++toastId;
  toasts = [...toasts, { id, message, kind }];
  for (const notify of toastSubscribers) notify(toasts);
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    for (const notify of toastSubscribers) notify(toasts);
  }, ms);
}

export function useToasts() {
  const [value, setValue] = useState(toasts);
  useEffect(() => {
    toastSubscribers.add(setValue);
    return () => toastSubscribers.delete(setValue);
  }, []);
  return value;
}

/* ---------------- clipboard ---------------- */

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    // Clipboard access can be refused; fall back to a selection the user can copy.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    toast(ok ? label : 'Could not copy — select the text instead', ok ? 'ok' : 'error');
    return Boolean(ok);
  }
}
