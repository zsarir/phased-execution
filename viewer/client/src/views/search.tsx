/**
 * Full-text search across every plan, phase block and handoff body.
 *
 * Two things changed in the port. The debounce moved out of a `useEffect` that
 * owned its own request, its own error and its own in-flight flag — the query
 * layer already does all three, so what is left here is the 180 ms delay and
 * nothing else. And every hit is a real link: the old view rendered them as
 * `<button onClick=navigate>`, which meant no middle-click, no open-in-new-tab,
 * and nothing to read in the status bar before committing to a jump.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { useSearch } from '@/lib/queries';
import { navigate } from '@/router';
import { Banner, Card, Chip, Empty, Skeleton, Spinner } from '@/components/ui';
import { handoffHref, phaseHref, planHref } from '@shared/routes.js';
import type { SearchHit } from '@/lib/api';
import { Page } from './_page';

const KIND_LABEL: Record<string, string> = {
  plan: 'plan',
  phase: 'phase',
  handoff: 'handoff',
  document: 'document',
};

/** How long to sit still before asking. Long enough not to search every letter. */
const DEBOUNCE_MS = 180;

/** Where a hit goes — the one place that decision is made. */
export function hrefFor(hit: Pick<SearchHit, 'kind' | 'slug' | 'phase'>): string {
  if (hit.kind === 'handoff' && hit.phase != null) return handoffHref(hit.slug, hit.phase);
  if (hit.kind === 'phase' && hit.phase != null) return phaseHref(hit.slug, hit.phase);
  return planHref(hit.slug, 'overview');
}

/**
 * The matched terms, marked.
 *
 * Built by splitting rather than by injecting HTML: the snippet is repository
 * text and the terms are whatever was typed, so the one thing this must never
 * do is hand either to a parser. `<mark>` is a real element in a React tree,
 * not a string.
 */
function Snippet({ text, terms }: { text: string; terms: string[] }) {
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
    <span className="text-sm text-ink-muted">
      {parts.map((part, i) => (typeof part === 'string'
        ? <span key={i}>{part}</span>
        : <mark key={i} className="rounded-sm bg-action/25 px-0.5 text-ink">{part.mark}</mark>))}
    </span>
  );
}

export default function SearchView({ route }: { route: { query: Record<string, string> } }) {
  const initial = route.query.q ?? '';
  const [value, setValue] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  // The one thing this view is for. Focusing it on open is safe here in a way
  // it never is on a list: this page has no other purpose.
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  // The URL carries the term so a search can be linked to and survives a reload.
  useEffect(() => {
    const text = debounced.trim();
    navigate(text ? `search?q=${encodeURIComponent(text)}` : 'search', { replace: true });
  }, [debounced]);

  const { data: result, isFetching, error } = useSearch(debounced);

  const terms = useMemo(
    () => debounced.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 1),
    [debounced],
  );

  const tooShort = debounced.trim().length < 2;
  const settling = value !== debounced;

  return (
    <Page
      title="Search"
      subtitle="Every plan section, phase block and handoff body — file paths, commit shas, exit criteria and gotchas included."
      actions={result && !tooShort
        ? <Chip mono>{result.total} hits in {result.groups.length} plans</Chip>
        : undefined}
    >
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2 focus-within:border-action">
        <SearchIcon className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <input
          ref={input}
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="cart api · a1b2c3d · packages/web/src · exit criteria"
          aria-label="Search plans and handoffs"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
        />
        {(isFetching || settling) && !tooShort && <Spinner />}
      </div>

      {error && <Banner severity="error">{String((error as Error).message ?? error)}</Banner>}

      {tooShort && (
        <Empty
          title="Search the whole library"
          body="Two characters is enough to start. Every term has to appear in the same section for it to match."
        />
      )}

      {!tooShort && !result && isFetching && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      )}

      {!tooShort && result && !result.groups.length && !isFetching && (
        <Empty
          title={`Nothing matches “${debounced.trim()}”`}
          body="Every term has to appear in the same section. Try one word fewer."
        />
      )}

      {!tooShort && result && result.groups.length > 0 && (
        <div className="flex flex-col gap-3">
          {result.groups.map((group) => (
            <Card key={group.slug}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-3 py-2">
                <a href={planHref(group.slug)} className="font-mono text-xs text-ink hover:text-action">
                  {group.slug}
                </a>
                <span className="truncate text-2xs text-ink-faint">{group.title}</span>
              </div>
              <ul>
                {group.hits.map((hit, i) => (
                  <li key={`${hit.section}-${i}`} className="border-b border-rule/60 last:border-b-0">
                    <a
                      href={hrefFor(hit)}
                      className="block px-3 py-2 hover:bg-surface-raised focus-visible:bg-surface-raised"
                    >
                      <div className="text-2xs tracking-wide text-ink-faint uppercase">
                        {KIND_LABEL[hit.kind] ?? hit.kind} · {hit.section}
                      </div>
                      <Snippet text={hit.snippet} terms={terms} />
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
