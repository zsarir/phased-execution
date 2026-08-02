/**
 * Markdown rendering for plan and handoff bodies.
 *
 * The files are local and written by agents, but they are still untrusted
 * input to a browser. Parsed HTML goes into a `<template>` first — its content
 * is an inert fragment, so images do not load and no handler can fire — then
 * it is swept for scripts, event attributes and unsafe URLs, and only the
 * survivors are moved into the live document.
 */

import { marked } from 'marked';
import { html, useMemo, useRef, useEffect } from '../html.js';

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_PROTOCOL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const FORBIDDEN = /^(script|style|iframe|object|embed|form|input|button|link|meta|base|svg|math)$/i;

function sweep(root) {
  for (const node of root.querySelectorAll('*')) {
    if (FORBIDDEN.test(node.tagName)) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset') {
        node.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !ALLOWED_PROTOCOL.test(attribute.value.trim())) {
        node.removeAttribute(attribute.name);
      }
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/** Parse markdown to an inert, swept DocumentFragment. */
function toFragment(markdown, inline) {
  const template = document.createElement('template');
  template.innerHTML = inline ? marked.parseInline(String(markdown)) : marked.parse(String(markdown));
  sweep(template.content);
  return template.content;
}

function useRendered(text, inline) {
  const ref = useRef(null);
  const fragment = useMemo(() => (text ? toFragment(text, inline) : null), [text, inline]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!fragment) { node.replaceChildren(); return; }
    node.replaceChildren(fragment.cloneNode(true));
  }, [fragment]);

  return ref;
}

export function Markdown({ text, className = 'md' }) {
  const ref = useRendered(text, false);
  if (!text) return null;
  return html`<div class=${className} ref=${ref}></div>`;
}

/** Inline markdown (a table cell, a one-line goal) without block spacing. */
export function MarkdownInline({ text }) {
  const ref = useRendered(text, true);
  if (!text) return null;
  return html`<span class="md-inline" ref=${ref}></span>`;
}
