/**
 * One guide card — a `<details>` wearing a Card's clothes.
 *
 * Native rather than an accordion component, for the reason the rest of this
 * codebase already uses `<details>` in five places: it brings keyboard
 * activation, the right semantics and find-in-page for no bytes at all, against
 * a 300 KB gzipped entry budget that a new dependency would eat into.
 *
 * The body is ALWAYS mounted, never `{open && …}`. Three reasons, all learned:
 * the guide's own tests query the DOM for tables and code inside a section, so
 * conditional rendering would make them depend on collapse state; Cmd-F has to
 * find text in a card you have not opened yet; and the status-word decoration
 * then runs exactly once per card, at mount, with no re-entry to reason about.
 *
 * A card's title can itself be a status word — `troubleshooting` has a card per
 * resting state — so it goes through the same `decorateStatusWord` the prose
 * does. That is why `halted` in a heading is painted like `halted` in a table.
 */

import { ChevronRight, Link2 } from 'lucide-react';
import { cardClass } from '@/components/ui';
import { cn } from '@/lib/cn';
import { navigate } from '@/app/router';
import { decorateStatusWord } from '@/components/ui/status-badge';
import { StatusProse } from './prose';
import type { GuideCard as Card } from './split';

export function GuideCard({
  card,
  sectionId,
  open,
  onToggle,
}: {
  card: Card;
  sectionId: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const worn = decorateStatusWord(card.title);

  return (
    <details
      id={`card-${card.id}`}
      className={cn(cardClass, 'group/card scroll-mt-4 overflow-hidden')}
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-start gap-2 px-4 py-3',
          'transition-colors duration-fast ease-transit hover:bg-surface-raised',
          '[@media(hover:none)]:min-h-(--tap-min)',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          size={15}
          aria-hidden
          className="mt-1 shrink-0 text-ink-faint transition-transform duration-fast ease-transit group-open/card:rotate-90"
        />

        {card.marker && (
          <span className="mt-0.5 shrink-0 font-mono text-2xs tracking-wide text-ink-faint uppercase">
            {card.marker.word} {card.marker.n}
          </span>
        )}

        <h3 className={cn('min-w-0 flex-1 font-display text-lg leading-snug', worn && 'font-mono')}>
          {worn ? (
            <span className={worn.className} title={worn.title}>
              {card.title}
            </span>
          ) : (
            card.title
          )}
        </h3>

        {/*
          A permalink, not an in-page anchor: `#card-x` IS a route to a hash
          router, which is the bug the tabbed guide was built to fix. And the
          click must be stopped dead — inside a `<summary>`, following the link
          would otherwise also toggle the card shut behind you.
        */}
        <a
          href={`#/guide/${sectionId}?card=${card.id}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate(`guide/${sectionId}?card=${card.id}`);
          }}
          title="Link to this card"
          aria-label={`Link to ${card.title}`}
          className="mt-1 shrink-0 rounded-sm p-1 text-ink-faint opacity-0 transition-opacity duration-fast focus-visible:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Link2 size={14} aria-hidden />
        </a>
      </summary>

      <div className="border-t border-rule px-4 py-3">
        <StatusProse text={card.body} />
      </div>
    </details>
  );
}
