/**
 * The section drawn as a line — stations on a track, one per card.
 *
 * The guide was the one page in this console that ignored the language the rest
 * of it is built in. Everywhere else a plan is a transit network: phases are
 * stations, dependencies are track, a board says Departed / Boarding / Held.
 * Here the same idea does a second job — the sections that ARE a sequence get
 * drawn as one, and the reader can see how many stops are left before they
 * commit to reading.
 *
 * Only sections whose content is genuinely ordered get this (`kind: 'route'`).
 * A line diagram over the Reference glossary would assert a sequence that is not
 * there, which is worse than no diagram.
 *
 * HTML and not SVG, unlike `components/dag.tsx`. That map earns a viewBox
 * because a plan graph has real two-dimensional topology; a straight line does
 * not. As markup this gets text wrapping, real buttons, real focus rings and
 * 44px tap targets for nothing, and it reflows on a phone instead of needing a
 * second layout.
 *
 * The filled/ringed distinction is the one carried over from `concepts.md`'s
 * legend, which used two emoji: a solid station is work the machine does, a
 * ringed one is work that waits for you. `--line-done` and `--line-gated` are
 * reused rather than invented — `gated` already means "a person must decide" in
 * the engine's own vocabulary, so the colour is already true.
 */

import type { GuideCard } from './split';

export function RouteStrip({
  cards,
  activeId,
  onPick,
}: {
  cards: readonly GuideCard[];
  activeId?: string;
  onPick: (id: string) => void;
}) {
  if (cards.length < 2) return null;

  return (
    <nav aria-label="Stops in this section" className="guide-strip">
      <ol>
        {cards.map((card, i) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onPick(card.id)}
              aria-current={card.id === activeId ? 'true' : undefined}
              data-actor={card.actor ?? 'none'}
            >
              <span className="guide-strip-rail" aria-hidden>
                <i className="guide-strip-dot" />
              </span>
              {/*
                Numbered by POSITION, never from the prose. The headings used to
                carry their own ordinals — `Stop 2½ ·`, `Step 4 ·` — which is a
                number two places have to agree on, and they stopped agreeing the
                moment the guide was split across tabs (a reader landing on
                Autopilot met "Stop 6" with stops 1–5 on other pages). The strip
                counts what is actually there.
              */}
              <span className="guide-strip-num">{i + 1}</span>
              <span className="guide-strip-label">{card.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="guide-strip-key">
        <span data-actor="machine"><i className="guide-strip-dot" aria-hidden /> the machine does this</span>
        <span data-actor="person"><i className="guide-strip-dot" aria-hidden /> you do this</span>
      </p>
    </nav>
  );
}
