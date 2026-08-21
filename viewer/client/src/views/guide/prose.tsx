/**
 * Guide markdown, with every status word dressed as its real badge.
 *
 * Markdown cannot colour `halted` the way the app paints it, and a glossary in
 * plain text asks the reader to imagine the mapping. After the sanitizer has
 * filled the DOM, every inline-code or bold token that IS a status word —
 * including the departures spellings, Departed / Boarding / Held — gets the
 * exact class and hover title its chip carries, from the same tone maps the
 * chips read. Unknown words are left alone.
 *
 * The ordering invariant is why this is ONE component rather than a `<Markdown>`
 * beside an effect: `Markdown` fills the DOM in an effect, and this reads that
 * DOM in an effect. React runs a child's effects before its parent's, in every
 * commit and both StrictMode passes — so co-locating them makes the order true
 * however and whenever a card mounts. As siblings, the decoration would race the
 * render it depends on.
 *
 * One of these per card, not one per section: each walk is scoped to its own
 * subtree instead of re-walking all of `reference.md`, and a card that ever
 * mounts late still decorates itself. The walk only writes where
 * `decorateStatusWord` returns a match, so running it twice is a no-op.
 */

import { useEffect, useRef } from 'react';
import { Markdown } from '@/components/markdown';
import { decorateStatusWord } from '@/components/ui/status-badge';

export function StatusProse({ text, className }: { text?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll('code, strong')) {
      const worn = decorateStatusWord(el.textContent ?? '');
      if (!worn) continue;
      el.className = worn.className;
      el.setAttribute('title', worn.title);
    }
  }, [text]);

  if (!text?.trim()) return null;
  return (
    <div ref={ref}>
      <Markdown text={text} className={className} />
    </div>
  );
}
