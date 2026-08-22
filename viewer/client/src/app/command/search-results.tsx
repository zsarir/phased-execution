import { useMemo } from 'react';
import { Chip, CommandGroup, CommandItem, Spinner } from '@/components/ui';
import { usePlans, useSearch } from '@/lib/queries';
import { closedTitle, isClosed } from '@/lib/closure';
import { handoffHref, phaseHref, planHref } from '@/app/routes';
import type { SearchHit } from '@/lib/api';

/**
 * The full-text leg of the palette — every plan section, phase block and
 * handoff body, from `/api/search`.
 *
 * Ported from the retired `views/search.tsx`, which was a whole destination for
 * a thing you always want *from* somewhere else. Two of its three jobs moved
 * into the palette unchanged (the 180 ms debounce, the marked snippet); the
 * third — being a page — is what it lost.
 *
 * **cmdk and server results.** cmdk scores every item against what has been
 * typed, which is exactly wrong for rows the server already matched: it would
 * filter the search results by the search term a second time, and a hit whose
 * *snippet* matched but whose title did not would vanish. The fix is the
 * documented one — give each row a `value` that begins with the query, so it
 * always scores — with the row's own index appended to keep values unique,
 * because cmdk keys its selection on `value`.
 */

const KIND_LABEL: Record<string, string> = {
  plan: 'plan',
  phase: 'phase',
  handoff: 'handoff',
  document: 'document',
};

/** Where a hit goes — the one place that decision is made. */
export function hrefFor(hit: Pick<SearchHit, 'kind' | 'slug' | 'phase'>): string {
  if (hit.kind === 'handoff' && hit.phase != null) return handoffHref(hit.slug, hit.phase);
  if (hit.kind === 'phase' && hit.phase != null) return phaseHref(hit.slug, hit.phase);
  // The prose reading of the plan file — where a text hit that is neither a
  // phase nor a handoff actually is. (This was `overview` until Phase 9 folded
  // that tab and `raw` into one; `LEGACY_PLAN_TABS` keeps the old address
  // working, but a live link should name the live tab.)
  return planHref(hit.slug, 'source');
}

/**
 * The matched terms, marked.
 *
 * Built by splitting rather than by injecting HTML: the snippet is repository
 * text and the terms are whatever was typed, so the one thing this must never
 * do is hand either to a parser. `<mark>` is a real element in a React tree,
 * not a string.
 */
export function Snippet({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    if (!terms.length) return [text];
    const pattern = new RegExp(
      `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
      'ig',
    );
    const out: (string | { mark: string })[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      out.push({ mark: match[0] });
      last = match.index + match[0].length;
      // A zero-length match would spin here forever.
      if (match[0] === '') pattern.lastIndex++;
      // A pathological term set against a long snippet is not worth rendering.
      if (out.length > 40) break;
    }
    out.push(text.slice(last));
    return out;
  }, [text, terms]);

  return (
    <span className="block truncate text-2xs text-ink-muted">
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <mark key={i} className="rounded-xs bg-action/25 px-0.5 text-ink">
            {part.mark}
          </mark>
        ),
      )}
    </span>
  );
}

/** How many hits the palette shows before it stops being a palette. */
const MAX_HITS = 12;

export function SearchResults({ query, onPick }: { query: string; onPick: (href: string) => void }) {
  const text = query.trim();
  const { data, isFetching } = useSearch(text);

  // The search index is built from file text and knows nothing about a plan's
  // status, so closure is joined on here from the plan list the palette has
  // already fetched. Search deliberately KEEPS closed plans — an abandoned plan
  // is often exactly what you are looking for, and a search that hides history
  // is a search you stop trusting. But a result with no marker reads as live
  // work, so the badge is the price of keeping the row. Order is left alone:
  // relevance is the only ranking a search should have.
  const { data: plans } = usePlans();
  const closed = useMemo(
    () => new Map((plans ?? []).filter((p) => isClosed(p)).map((p) => [p.slug, p])),
    [plans],
  );

  const terms = useMemo(
    () =>
      text
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1),
    [text],
  );

  // Two characters is the server's own floor (`useSearch` is disabled below it),
  // so there is nothing to say and nothing being asked.
  if (text.length < 2) return null;

  const hits = (data?.groups ?? []).flatMap((group) =>
    group.hits.map((hit) => ({ hit, title: group.title, slug: group.slug })),
  );

  if (!hits.length) {
    return isFetching ? (
      <CommandGroup heading="In the documents">
        <CommandItem value={`${text} searching`} disabled>
          <Spinner />
          <span className="text-ink-muted">Searching every plan and handoff…</span>
        </CommandItem>
      </CommandGroup>
    ) : null;
  }

  return (
    <CommandGroup
      heading={`In the documents${data && data.total > hits.length ? ` (${data.total} hits)` : ''}`}
    >
      {hits.slice(0, MAX_HITS).map(({ hit, slug }, i) => (
        <CommandItem
          key={`${slug}-${hit.section}-${i}`}
          value={`${text} ${slug} ${hit.section} ${i}`}
          onSelect={() => onPick(hrefFor(hit))}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-2xs text-ink-faint">{slug}</span>
              {closed.has(slug) && <Chip title={closedTitle(closed.get(slug))}>closed</Chip>}
              <span className="truncate text-2xs tracking-wide text-ink-faint uppercase">
                {KIND_LABEL[hit.kind] ?? hit.kind} · {hit.section}
              </span>
            </span>
            <Snippet text={hit.snippet} terms={terms} />
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
