/**
 * The journal: the run's audit trail, filterable and deep-linkable.
 *
 * The console shows what the SESSION said. The journal shows what the RUNNER
 * did — boarded a phase, verified it, parked it, climbed a rung, noticed a
 * stall, ingested a ruling — and it is the only one of the two that survives
 * the process. When a run did something surprising three hours ago, this is
 * the record that still has it; the console's buffer is long gone.
 *
 * ## Two renderings, because a phone must not nest a scroller
 *
 * Above the shell breakpoint the list is virtualized in its own bounded
 * scroller (`DataList`) — the desktop journal is a panel among panels and a
 * page that grows to five thousand rows is not readable.
 *
 * On a phone the shell owns the ONE scroller, and a second one inside it is
 * the thing that makes a page impossible to flick past. So the phone gets a
 * bounded PAGE instead of a bounded viewport: the newest `PAGE` entries in
 * ordinary flow, with an explicit "older" step. The DOM stays small for the
 * same reason virtualization keeps it small, without a nested scroll region.
 *
 * ## Every line has an address
 *
 * `seq` is per run and monotonic, so `?j=<seq>` names one entry for as long as
 * the run exists — a real permalink, unlike the console's `?line=`, which can
 * only promise as long as the buffer holds. A linked entry is scrolled to,
 * highlighted, and shown even when the current filter would hide it: a link
 * that silently resolved to nothing because a filter was set is worse than no
 * link.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataList,
  Empty,
  Input,
  RelativeTime,
} from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import { scrollIntoScroller } from '@/lib/scroll';
import type { JournalEntry } from '@/lib/api';

/** The query key a journal permalink rides on. */
export const JOURNAL_PARAM = 'j';

/** How many entries a phone renders before asking. */
export const PAGE = 100;

/** The entry a permalink names, or null. */
export function linkedSeq(hash: string = window.location.hash): number | null {
  const query = hash.split('?')[1];
  if (!query) return null;
  const raw = new URLSearchParams(query).get(JOURNAL_PARAM);
  const seq = raw == null ? NaN : Number(raw);
  return Number.isFinite(seq) ? seq : null;
}

/** The same address with `?j=<seq>` on it. */
export function journalHref(seq: number, hash: string = window.location.hash): string {
  const [path, query] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query ?? '');
  params.set(JOURNAL_PARAM, String(seq));
  return `#${path}?${params.toString()}`;
}

/**
 * One entry's searchable text: the event name, the phase, and the flattened
 * data. Kept out of the component because it runs once per entry per keystroke
 * and is the only thing in here worth memoising.
 */
export function entryText(entry: JournalEntry): string {
  const data = entry.data ? Object.entries(entry.data).map(([k, v]) => `${k} ${stringify(v)}`).join(' ') : '';
  return `${entry.event} ${entry.phase != null ? `phase ${entry.phase}` : ''} ${data}`.toLowerCase();
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * The filter, as a pure function — what a test asserts without rendering.
 *
 * `linked` is always kept: see the header. An empty needle keeps everything,
 * so the caller never has to special-case it.
 */
export function filterEntries(
  entries: readonly JournalEntry[],
  needle: string,
  linked: number | null,
): JournalEntry[] {
  if (!needle) return [...entries];
  const q = needle.toLowerCase();
  return entries.filter((entry) => entry.seq === linked || entryText(entry).includes(q));
}

export function Journal({
  entries,
  className,
}: {
  entries: readonly JournalEntry[];
  className?: string;
}) {
  const phone = usePhone();
  const [needle, setNeedle] = useState('');
  const [page, setPage] = useState(1);
  const [linked, setLinked] = useState<number | null>(() => linkedSeq());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => setLinked(linkedSeq());
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Newest first: a journal is read from the end, and "scroll to the bottom to
  // see what just happened" is the thing every log viewer gets wrong.
  const shown = useMemo(
    () => filterEntries(entries, needle, linked).sort((a, b) => b.seq - a.seq),
    [entries, needle, linked],
  );
  const visible = phone ? shown.slice(0, page * PAGE) : shown;

  useEffect(() => {
    if (linked == null || !box.current) return;
    const el = box.current.querySelector(`[data-seq="${linked}"]`);
    // Desktop: the `DataList` scroller. Phone: the shell's one scroller, since
    // the phone rendering deliberately nests none. `scrollIntoScroller` finds
    // whichever it is and moves only that.
    if (el) scrollIntoScroller(el);
  }, [linked, visible.length]);

  const row = (entry: JournalEntry) => (
    <JournalRow entry={entry} linked={linked === entry.seq} onLink={setLinked} />
  );

  return (
    <Card className={className}>
      <CardHeader className="flex-wrap items-baseline gap-2">
        <CardTitle>Journal</CardTitle>
        <span className="grow text-2xs text-ink-faint">
          What the runner did — {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {needle && shown.length !== entries.length ? `, ${shown.length} shown` : ''}
        </span>
        <Input
          value={needle}
          aria-label="Filter the journal"
          placeholder="Filter…"
          className="h-7 w-40 text-2xs"
          onChange={(event) => {
            setNeedle(event.currentTarget.value);
            setPage(1);
          }}
        />
      </CardHeader>
      <CardBody>
        <div ref={box}>
        {visible.length === 0 ? (
          <Empty
            title={needle ? 'Nothing matches that' : 'No journal yet'}
            body={
              needle
                ? 'The journal holds what the runner did — boarded, verified, parked, recovered. Try the phase number, or an event name like "phase.stall".'
                : 'A run writes one line here for every decision it makes. It survives the process, which is what makes it the record worth reading when something happened hours ago.'
            }
          />
        ) : phone ? (
          <>
            <ol className="flex flex-col divide-y divide-rule">
              {visible.map((entry) => (
                <li key={entry.seq}>{row(entry)}</li>
              ))}
            </ol>
            {visible.length < shown.length && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 w-full"
                onClick={() => setPage((n) => n + 1)}
              >
                Show {Math.min(PAGE, shown.length - visible.length)} older
              </Button>
            )}
          </>
        ) : (
          <DataList
            items={visible}
            role="log"
            label="Run journal"
            keyOf={(entry) => entry.seq}
            estimateRowHeight={38}
            rowClassName="border-b border-rule"
            renderRow={(entry) => row(entry)}
          />
        )}
        </div>
      </CardBody>
    </Card>
  );
}

function JournalRow({
  entry,
  linked,
  onLink,
}: {
  entry: JournalEntry;
  linked: boolean;
  onLink: (seq: number) => void;
}) {
  const at = Date.parse(entry.time);
  const detail = entry.data ? summarise(entry.data) : '';
  return (
    <div
      data-seq={entry.seq}
      className={cn(
        'grid grid-cols-[auto_1fr] items-baseline gap-x-2 px-1 py-1.5 text-2xs',
        linked && 'rounded bg-accent/10 shadow-[inset_2px_0_0_0_var(--accent)]',
      )}
    >
      <button
        type="button"
        className="cursor-pointer font-mono text-ink-faint tabular-nums hover:underline"
        title="Copy a link to this entry"
        onClick={() => {
          void navigator.clipboard?.writeText(
            new URL(journalHref(entry.seq), window.location.href).toString(),
          );
          onLink(entry.seq);
        }}
      >
        #{entry.seq}
      </button>
      <div className="min-w-0">
        <span className="font-mono font-semibold text-ink">{entry.event}</span>
        {entry.phase != null && <span className="ml-1.5 text-ink-faint">phase {entry.phase}</span>}
        {Number.isFinite(at) && (
          <span className="ml-1.5 text-ink-faint">
            <RelativeTime at={at} />
          </span>
        )}
        {detail && <p className="mt-0.5 break-words font-mono text-ink-muted">{detail}</p>}
      </div>
    </div>
  );
}

/** `key=value` pairs, bounded — a journal line is a summary, not a payload dump. */
function summarise(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => `${key}=${stringify(value).slice(0, 120)}`)
    .join('  ');
}

export default Journal;
