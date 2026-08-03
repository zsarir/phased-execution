/** Shared interface pieces. */

import { html, useEffect, useState } from '../html.js';
import { copy } from '../store.js';

export const STATE_LABEL = {
  done: 'Done',
  ready: 'Ready',
  'in-progress': 'In progress',
  waiting: 'Waiting',
  stuck: 'Blocked',
};

/** A phase state, spelled the way a departures board would. */
export const STATE_BOARD = {
  done: 'Departed',
  ready: 'Boarding',
  'in-progress': 'On track',
  waiting: 'Held',
  stuck: 'Blocked',
};

export function StateChip({ state, board = false, small = false }) {
  const label = (board ? STATE_BOARD : STATE_LABEL)[state] ?? state;
  return html`
    <span class=${`chip state state-${state} ${small ? 'small' : ''}`}>
      <span class="dot"></span>${label}
    </span>`;
}

export function Chip({ children, kind = '', title, onClick }) {
  const Tag = onClick ? 'button' : 'span';
  return html`<${Tag}
    class=${`chip ${kind}`}
    title=${title}
    onClick=${onClick}
    style=${onClick ? 'cursor:pointer' : null}>${children}<//>`;
}

export function Tile({ label, figure, unit, note, accent = false, title }) {
  return html`
    <div class=${`tile ${accent ? 'accent' : ''}`} title=${title}>
      <div class="label">${label}</div>
      <div class="figure">${figure}${unit ? html`<span class="unit">${unit}</span>` : null}</div>
      ${note ? html`<div class="note">${note}</div>` : null}
    </div>`;
}

/** Segmented progress: done, in progress, ready, then the rest as track. */
export function Progress({ total, done = 0, inProgress = 0, ready = 0, stuck = 0 }) {
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return html`
    <div class="progress" role="img" aria-label=${`${done} of ${total} phases done`}>
      <span class="done" style=${`width:${pct(done)}`}></span>
      <span class="in-progress" style=${`width:${pct(inProgress)}`}></span>
      <span class="stuck" style=${`width:${pct(stuck)}`}></span>
      <span class="ready" style=${`width:${pct(ready)}`}></span>
    </div>`;
}

export function Banner({ kind = 'info', children }) {
  return html`<div class=${`banner ${kind}`}>${children}</div>`;
}

export function Empty({ title, hint, children }) {
  return html`
    <div class="empty">
      <h3>${title}</h3>
      ${hint ? html`<p class="hint">${hint}</p>` : null}
      ${children}
    </div>`;
}

export function Spinner({ label }) {
  return html`<span class="row"><span class="spinner"></span>${label ? html`<span class="faint">${label}</span>` : null}</span>`;
}

export function Tabs({ tabs, active, onSelect }) {
  return html`
    <div class="tabs" role="tablist">
      ${tabs.map((tab) => html`
        <button
          class="tab"
          role="tab"
          key=${tab.id}
          aria-selected=${String(tab.id === active)}
          onClick=${() => onSelect(tab.id)}>
          ${tab.label}${tab.count != null ? html`<span class="count">${tab.count}</span>` : null}
        </button>`)}
    </div>`;
}

export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', className = 'btn small', title }) {
  const [done, setDone] = useState(false);
  return html`
    <button
      class=${className}
      title=${title ?? 'Copy to clipboard'}
      onClick=${async () => {
        const ok = await copy(typeof text === 'function' ? await text() : text, copiedLabel);
        if (ok) { setDone(true); setTimeout(() => setDone(false), 1400); }
      }}>
      ${done ? '✓ Copied' : label}
    </button>`;
}

export function KeyValue({ items }) {
  return html`
    <dl class="kv">
      ${items.filter((item) => item && item[1] != null && item[1] !== '').map(([key, value]) => html`
        <dt key=${key}>${key}</dt><dd>${value}</dd>`)}
    </dl>`;
}

export function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return html`
    <div class="scrim" onClick=${(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
        <header>
          <h3>${title}</h3>
          <button class="btn ghost small" onClick=${onClose} aria-label="Close">✕</button>
        </header>
        <div class="body">${children}</div>
        ${footer ? html`<footer>${footer}</footer>` : null}
      </div>
    </div>`;
}

/**
 * A clock that advances on its own.
 *
 * The console had no interval anywhere in it: every number on screen moved only
 * when the server said something, so a phase thinking quietly for four minutes
 * showed the same "started 3 minutes ago" the whole time and read as a page
 * that had stopped updating. It only runs while `active`, so a finished run
 * costs nothing and a frozen one — whose clock is genuinely not running —
 * stays where it stopped.
 */
export function useNow(active, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/* ---------------- formatting ---------------- */

/** `12:04` / `1:12:04` — a running clock, at the precision a clock implies. */
export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const UNITS = [
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
  [604_800_000, 'week'],
  [2_629_800_000, 'month'],
  [31_557_600_000, 'year'],
];

export function relativeTime(ms) {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  for (let i = 0; i < UNITS.length; i++) {
    const [size, name] = UNITS[i];
    const next = UNITS[i + 1]?.[0] ?? Infinity;
    if (delta < next) {
      const value = Math.round(delta / size);
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

export function shortDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/** 310000 → "310K" — weights are always tokens. */
export function weight(tokens) {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export function countdown(untilMs) {
  if (!untilMs) return '';
  const delta = untilMs - Date.now();
  if (delta <= 0) return 'expired';
  const minutes = Math.round(delta / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h left` : `${minutes}m left`;
}
