/**
 * Markdown rendering for plan and handoff bodies.
 *
 * The files are local and written by agents, but they are still untrusted input
 * to a browser. Parsed HTML goes into a `<template>` first — its content is an
 * inert fragment, so images do not load and no handler can fire — then it is
 * swept for scripts, event attributes and unsafe URLs, and only the survivors
 * are moved into the live document.
 *
 * ---- Why this is a port and not a rewrite ----
 *
 * `sweep()` below is `web/components/markdown.js` verbatim: the same FORBIDDEN
 * list, the same attribute rules, the same protocol allowlist, the same
 * `target=_blank rel=noopener` on every link. A sanitizer is the one place in a
 * rewrite where "cleaner" is worth nothing and "identical" is worth everything —
 * every difference is a hole nobody meant to open. `react-markdown` was
 * considered and rejected for the same reason: it would swap a reviewed
 * sanitizer for a different one to gain nothing this app needs.
 *
 * React does not render the result — `replaceChildren` does. That is deliberate:
 * `dangerouslySetInnerHTML` would hand the *unswept* string to the live document
 * and sanitize nothing, and a React tree built from parsed nodes would be a
 * second parser to keep in step with the first.
 */

import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_PROTOCOL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const FORBIDDEN = /^(script|style|iframe|object|embed|form|input|button|link|meta|base|svg|math)$/i;

/**
 * Strip everything that could execute or navigate somewhere unsafe.
 *
 * Exported so the hostile-fixture test can call it on a fragment directly,
 * rather than asserting against rendered output and hoping the render path was
 * the one that mattered.
 */
export function sweep(root: ParentNode): void {
  for (const node of root.querySelectorAll('*')) {
    if (FORBIDDEN.test(node.tagName)) {
      node.remove();
      continue;
    }
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
export function toFragment(markdown: string, inline = false): DocumentFragment {
  const template = document.createElement('template');
  const source = String(markdown);
  // `async: false` is what narrows marked's return type to a string; the option
  // is already the default, so this changes nothing but the types.
  template.innerHTML = inline
    ? marked.parseInline(source, { async: false })
    : marked.parse(source, { async: false });
  sweep(template.content);
  return template.content;
}

function useRendered(text: string | undefined, inline: boolean) {
  const ref = useRef<HTMLElement>(null);
  const fragment = useMemo(() => (text ? toFragment(text, inline) : null), [text, inline]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!fragment) {
      node.replaceChildren();
      return;
    }
    // A fragment is emptied by the first `replaceChildren` that consumes it, so
    // the memoised one is cloned rather than spent — otherwise a re-render with
    // the same text (a theme flip, a parent state change) blanks the block.
    node.replaceChildren(fragment.cloneNode(true));
  }, [fragment]);

  return ref;
}

export interface MarkdownProps {
  text?: string;
  className?: string;
}

/** Block markdown — headings, lists, tables, fenced code. */
export function Markdown({ text, className }: MarkdownProps) {
  const ref = useRendered(text, false);
  if (!text) return null;
  return <div className={cn('md', className)} ref={ref as React.RefObject<HTMLDivElement>} />;
}

/** Inline markdown (a table cell, a one-line goal) without block spacing. */
export function MarkdownInline({ text, className }: MarkdownProps) {
  const ref = useRendered(text, true);
  if (!text) return null;
  return <span className={cn('md-inline', className)} ref={ref as React.RefObject<HTMLSpanElement>} />;
}

/**
 * Markdown with the emphasis characters removed instead of interpreted — for the
 * places a goal or an exit criterion has to fit one line of a table cell, where
 * `**bold**` reads as literal asterisks and a real `<strong>` reads as shouting.
 *
 * It LIVES in `@/lib/plain-text` and is re-exported here so that every caller
 * that only wants text can import it without dragging `marked` into its chunk —
 * which is the whole Now page. Existing importers are unchanged.
 */
export { plainText } from '@/lib/plain-text';
