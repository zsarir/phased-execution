/**
 * Full-text search across plans and handoffs.
 *
 * Documents are sections, not files, so a hit can be linked to the part of the
 * plan it came from. The index is a plain token → postings map rebuilt for a
 * plan whenever its files change; at this corpus size (~14 MB of markdown)
 * that costs milliseconds.
 */

import type { PlanRecord } from './store.ts';

export type SearchDoc = {
  id: number;
  slug: string;
  kind: 'plan' | 'phase' | 'handoff' | 'document';
  /** Section or phase heading this text came from. */
  section: string;
  phase?: number;
  title: string;
  text: string;
};

export type SearchHit = {
  slug: string;
  kind: SearchDoc['kind'];
  section: string;
  phase?: number;
  title: string;
  score: number;
  snippet: string;
};

export type SearchResult = {
  query: string;
  total: number;
  groups: { slug: string; title: string; hits: SearchHit[] }[];
};

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'are', 'was']);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}/g) ?? [];
}

export class SearchIndex {
  private docs: SearchDoc[] = [];
  private postings = new Map<string, Set<number>>();
  private bySlug = new Map<string, number[]>();
  private nextId = 0;

  rebuild(records: PlanRecord[]): void {
    this.docs = [];
    this.postings.clear();
    this.bySlug.clear();
    this.nextId = 0;
    for (const record of records) this.addRecord(record);
  }

  /** Replace one plan's documents in place. */
  update(record: PlanRecord): void {
    const ids = this.bySlug.get(record.slug) ?? [];
    for (const id of ids) {
      const doc = this.docs[id];
      if (!doc) continue;
      for (const token of new Set(tokenize(`${doc.title} ${doc.section} ${doc.text}`))) {
        this.postings.get(token)?.delete(id);
      }
      // Tombstone: keep the slot so ids stay stable.
      this.docs[id] = { ...doc, text: '', title: '', section: '' };
    }
    this.bySlug.set(record.slug, []);
    this.addRecord(record);
  }

  private addRecord(record: PlanRecord): void {
    const plan = record.plan;
    const title = plan?.title ?? record.slug;
    const kind: SearchDoc['kind'] = plan?.phased ? 'plan' : 'document';

    if (plan) {
      for (const section of plan.sections) {
        this.add({ slug: record.slug, kind, section: section.title, title, text: section.body });
      }
      for (const detail of Object.values(plan.phases)) {
        this.add({
          slug: record.slug, kind: 'phase', phase: detail.phase,
          section: `Phase ${detail.phase} — ${detail.title}`, title, text: detail.raw,
        });
      }
    }

    for (const handoff of record.handoffs) {
      this.add({
        slug: record.slug, kind: 'handoff', phase: handoff.phase,
        section: `Handoff ${String(handoff.phase).padStart(2, '0')} — ${handoff.title}`,
        title, text: handoff.body,
      });
    }
  }

  private add(doc: Omit<SearchDoc, 'id'>): void {
    if (!doc.text.trim()) return;
    const id = this.nextId++;
    const full: SearchDoc = { ...doc, id };
    this.docs[id] = full;

    const ids = this.bySlug.get(doc.slug) ?? [];
    ids.push(id);
    this.bySlug.set(doc.slug, ids);

    for (const token of new Set(tokenize(`${doc.title} ${doc.section} ${doc.text}`))) {
      let set = this.postings.get(token);
      if (!set) { set = new Set(); this.postings.set(token, set); }
      set.add(id);
    }
  }

  search(query: string, limit = 60): SearchResult {
    const terms = tokenize(query).filter((t) => !STOP.has(t));
    if (!terms.length) return { query, total: 0, groups: [] };

    let candidates: Set<number> | null = null;
    for (const term of terms) {
      const exact = this.postings.get(term);
      const matched = exact ?? this.prefixMatch(term);
      if (!matched.size) return { query, total: 0, groups: [] };
      candidates = candidates ? intersect(candidates, matched) : matched;
      if (!candidates.size) return { query, total: 0, groups: [] };
    }

    const hits: SearchHit[] = [];
    for (const id of candidates ?? []) {
      const doc = this.docs[id];
      if (!doc?.text) continue;
      const haystack = doc.text.toLowerCase();
      let score = 0;
      for (const term of terms) score += occurrences(haystack, term);
      if (doc.kind === 'phase' || doc.kind === 'handoff') score += 1;
      hits.push({
        slug: doc.slug, kind: doc.kind, section: doc.section, phase: doc.phase,
        title: doc.title, score, snippet: snippet(doc.text, terms),
      });
    }

    hits.sort((a, b) => b.score - a.score);
    const capped = hits.slice(0, limit);

    const groups = new Map<string, { slug: string; title: string; hits: SearchHit[] }>();
    for (const hit of capped) {
      const group = groups.get(hit.slug) ?? { slug: hit.slug, title: hit.title, hits: [] };
      group.hits.push(hit);
      groups.set(hit.slug, group);
    }

    return {
      query,
      total: hits.length,
      groups: [...groups.values()].sort((a, b) => b.hits[0].score - a.hits[0].score),
    };
  }

  private prefixMatch(term: string): Set<number> {
    const out = new Set<number>();
    if (term.length < 3) return out;
    for (const [token, ids] of this.postings) {
      if (token.startsWith(term)) for (const id of ids) out.add(id);
    }
    return out;
  }

  get size(): number { return this.docs.filter(Boolean).length; }
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  const out = new Set<number>();
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1 && count < 50) { count++; index = haystack.indexOf(term, index + term.length); }
  return count;
}

function snippet(text: string, terms: string[], width = 180): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) { at = lower.indexOf(term); if (at !== -1) break; }
  if (at === -1) at = 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const raw = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${start + width < text.length ? '…' : ''}`;
}
