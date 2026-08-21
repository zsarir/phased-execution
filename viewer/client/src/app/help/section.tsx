/**
 * One guide section, as cards on a line.
 *
 * The panel owns which cards are open rather than each card owning itself, so
 * "expand all" is one state change and a `?card=` deep link can seed the set
 * before anything renders.
 *
 * The opening policy is the editorial decision worth stating, because it is easy
 * to get backwards: **collapse is a small-screen affordance, not a way of
 * hiding content.** Putting half a desktop page behind chevrons re-creates the
 * confusion this refactor exists to cure — now you cannot even see what you do
 * not know to open. What cures confusion is chunking plus an index. What cures
 * a phone's scroll length is collapse. So:
 *
 *   desktop   every card open, except the bulky ones
 *   phone     the first card of the section open, the rest closed
 *   bulky     closed at both widths — a 27-line prompt is material you copy
 *   ?card=    forced open and scrolled to, at any width
 *
 * The phone rule counts cards, not groups. "The first card of each group" reads
 * better and is wrong: every guide file is flat today, so each group holds
 * exactly one card and the rule opens all thirteen — which is the wall this
 * refactor removed, restored on the smallest screen.
 *
 * `?card=` is deliberately NOT added to `shared/route-meta.js`. That file is
 * frozen vocabulary shared with the server's notification deep links, and
 * freezing card ids would freeze the prose they are derived from. An unknown
 * `?card=` is ignored and the section renders normally.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import { GuideCard } from './card';
import { RouteStrip } from './route-strip';
import { StatusProse } from './prose';
import { cardsOf, splitGuide, type GuideCard as GuideCardData, type GuideOutline } from './split';
import type { GuideSection } from './sections';

/**
 * Bring one card to the top of the pane it lives in — and of nothing else.
 *
 * `scrollIntoView` is banned app-wide for exactly this case: it walks every
 * scrollable ancestor, so a card deep-linked inside the help sheet also scrolls
 * the page behind it, and on a phone it scrolls the shell out from under the tab
 * bar. Finding the nearest ancestor that actually scrolls and setting its
 * `scrollTop` moves one container and leaves the rest of the app where it was.
 */
function reveal(id: string): void {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  let pane: HTMLElement | null = card.parentElement;
  while (pane && pane.scrollHeight <= pane.clientHeight) pane = pane.parentElement;
  if (!pane) return;
  const top = card.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  pane.scrollTo({ top, behavior: 'smooth' });
}

/** Which cards a fresh visit opens. */
function initialOpen(outline: GuideOutline, phone: boolean, wanted?: string): Set<string> {
  const all = cardsOf(outline);
  const open = new Set<string>();
  for (const [i, card] of all.entries()) {
    if (card.bulky) continue;
    if (!phone || i === 0) open.add(card.id);
  }
  // A deep link wins over both rules — including over `bulky`, because a link
  // to a card is a request to read that card.
  if (wanted) open.add(wanted);
  return open;
}

export function SectionPanel({ section, card: wanted }: { section: GuideSection; card?: string }) {
  const phone = usePhone();
  const outline = useMemo(() => splitGuide(section.body), [section.body]);
  const cards = useMemo(() => cardsOf(outline), [outline]);
  const known = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const target = wanted && known.has(wanted) ? wanted : undefined;

  const [open, setOpen] = useState(() => initialOpen(outline, phone, target));
  const seeded = useRef<string>('');

  // Re-seed when the section changes or the viewport crosses the shell
  // breakpoint. Keyed on both so that toggling a card does not get undone by a
  // re-render, which a bare `useEffect` on `outline` would do.
  const seed = `${section.id}:${phone}:${target ?? ''}`;
  useEffect(() => {
    if (seeded.current === seed) return;
    seeded.current = seed;
    setOpen(initialOpen(outline, phone, target));
  }, [seed, outline, phone, target]);

  // A deep-linked card is brought into view once it is open. `requestAnimation-
  // Frame` rather than a bare call: the card has just been told to open, and
  // scrolling to a zero-height `<details>` lands in the wrong place.
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => reveal(target));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const scrollTo = (id: string) => {
    setOpen((prev) => new Set(prev).add(id));
    requestAnimationFrame(() => reveal(id));
  };

  const allOpen = cards.every((c) => open.has(c.id));
  const route = section.kind === 'route';
  const banded = outline.groups.some((g) => g.banded);

  return (
    // Capped narrower than the page's own `--content-max`. A prose card 1500px
    // wide holding a 74ch column of text reads as a layout bug rather than as a
    // measure — and the reference tables, which are the widest thing here, fit
    // comfortably inside this.
    <div className="flex max-w-[68rem] flex-col gap-4">
      <p className="text-sm text-ink-muted">{section.lede}</p>

      {outline.intro && <StatusProse text={outline.intro} />}

      {route ? (
        <RouteStrip cards={cards} activeId={target} onPick={scrollTo} />
      ) : (
        <SectionIndex cards={cards} onPick={scrollTo} />
      )}

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(allOpen ? new Set() : new Set(cards.map((c) => c.id)))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>

      {/*
        A flat file renders as ONE list, so the route's track runs the whole
        section. Rendering a list per group looks equivalent and is not: every
        guide file is flat today, so each group holds a single card, and the
        track's "start below the first dot, stop at the last" rule collapses it
        to nothing on every card. Only a banded file gets a list per band, where
        a track per sub-journey is what you actually want.
      */}
      {banded ? (
        outline.groups.map((group) => (
          <section key={group.id} className="flex flex-col gap-3">
            {group.banded && (
              <div className="flex flex-col gap-2">
                <h2 className="font-display text-xl text-ink">{group.title}</h2>
                {group.intro && <StatusProse text={group.intro} />}
              </div>
            )}
            <CardList
              cards={group.cards}
              sectionId={section.id}
              route={route}
              open={open}
              setOpen={setOpen}
            />
          </section>
        ))
      ) : (
        <CardList cards={cards} sectionId={section.id} route={route} open={open} setOpen={setOpen} />
      )}
    </div>
  );
}

function CardList({
  cards,
  sectionId,
  route,
  open,
  setOpen,
}: {
  cards: readonly GuideCardData[];
  sectionId: string;
  route: boolean;
  open: Set<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
}) {
  return (
    <ol className={cn('flex list-none flex-col gap-3', route && 'guide-route')}>
      {cards.map((card) => (
        <li key={card.id}>
          {route && <span className="guide-stop" data-actor={card.actor ?? 'none'} aria-hidden />}
          <GuideCard
            card={card}
            sectionId={sectionId}
            open={open.has(card.id)}
            onToggle={(next) =>
              setOpen((prev) => {
                const copy = new Set(prev);
                if (next) copy.add(card.id);
                else copy.delete(card.id);
                return copy;
              })
            }
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * The lookup sections' index — the same job the route strip does, without
 * asserting an order that is not there. A glossary is not a journey.
 */
function SectionIndex({
  cards,
  onPick,
}: {
  cards: readonly { id: string; title: string }[];
  onPick: (id: string) => void;
}) {
  if (cards.length < 2) return null;
  return (
    <nav aria-label="In this section" className="flex flex-wrap gap-1.5">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          onClick={() => onPick(card.id)}
          className="rounded-full border border-rule px-2.5 py-1 text-2xs text-ink-muted transition-colors duration-fast ease-transit hover:border-rule-strong hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
        >
          {card.title}
        </button>
      ))}
    </nav>
  );
}
