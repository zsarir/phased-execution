/**
 * A plan as a table row — the comparing layout.
 *
 * Every plan on one screen, sortable by the column you are asking about. The
 * card (`card.tsx`) is the browsing layout; both read the same `PlanRow` and
 * the same chips from `row.tsx`.
 */

import { TBody, TD, TH, THead, TR, Table, TableWrap } from '@/components/ui';
import { Lock } from 'lucide-react';
import { etaLabel, etaTitle, relativeTime } from '@/lib/format';
import { closedTitle } from '@/lib/closure';
import { cn } from '@/lib/cn';
import { phaseHref, planHref } from '@shared/routes.js';
import { SORTS, concerns, type PlanRow, type SortId } from './model';
import { ConcernChip, NeedsYouChip, RunChip, Track, repoLabel } from './row';

/** Which sort each sortable column drives. A column with no entry is not sortable. */
const COLUMN_SORT: Record<string, SortId> = {
  Plan: 'name',
  Done: 'progress',
  Ready: 'ready',
  Health: 'attention',
  Activity: 'activity',
};

function SortableTH({
  label,
  sortId,
  onSort,
  className,
}: {
  label: string;
  sortId: SortId;
  onSort: (id: SortId) => void;
  className?: string;
}) {
  const target = COLUMN_SORT[label];
  if (!target) return <TH className={className}>{label}</TH>;

  const active = sortId === target;
  return (
    <TH
      className={className}
      // Every order but Name runs biggest-first, and saying so is the difference
      // between a screen reader announcing the column and announcing the sort.
      aria-sort={active ? (target === 'name' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(target)}
        className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-action')}
        title={SORTS.find((s) => s.id === target)?.blurb}
      >
        {label}
        <span aria-hidden className={cn('text-2xs', !active && 'opacity-0')}>
          {target === 'name' ? '↑' : '↓'}
        </span>
      </button>
    </TH>
  );
}

export function PlanTable({
  rows,
  sortId,
  onSort,
}: {
  rows: PlanRow[];
  sortId: SortId;
  onSort: (id: SortId) => void;
}) {
  const th = (label: string, className?: string) => (
    <SortableTH key={label} label={label} sortId={sortId} onSort={onSort} className={className} />
  );

  return (
    <TableWrap>
      <Table>
        <THead>
          <TR>
            {th('Plan')}
            <TH className="w-32">Track</TH>
            {th('Done', 'text-right')}
            {th('Ready', 'text-right')}
            <TH className="text-right">Left</TH>
            <TH>Repos</TH>
            {th('Health')}
            <TH>Run</TH>
            {th('Activity')}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.slug}>
              {/* The table had NO closed marker at all. Every other signal it
                  shows is one closure suppresses — Ready reads `—`, Health is
                  blank, Left is `—` — so a closed plan rendered as a live plan
                  with nothing to do, which is the one reading that is worse
                  than either truth. The badge rides with the name because that
                  is the cell the eye lands on, and it is what the card has
                  always had. */}
              <TD className="max-w-64">
                <a href={planHref(row.slug)} className="block min-w-0 hover:text-action">
                  <span className={cn('flex min-w-0 items-center gap-1.5', row.isClosed && 'text-ink-muted')}>
                    <span className="truncate">{row.title}</span>
                    {row.isClosed && (
                      <span
                        title={closedTitle(row)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-rule bg-surface-raised px-1 py-px text-2xs font-medium uppercase tracking-wide text-ink-faint"
                      >
                        <Lock size={9} className="shrink-0" aria-hidden />
                        {row.status}
                      </span>
                    )}
                  </span>
                  {row.slug !== row.title && (
                    <span className="block truncate font-mono text-2xs text-ink-faint">{row.slug}</span>
                  )}
                </a>
              </TD>
              <TD>
                <Track row={row} />
              </TD>
              <TD className="whitespace-nowrap text-right font-mono tabular-nums">
                {row.phases ? `${row.done}/${row.phases}` : '—'}
              </TD>
              {/* Same rule as the card: a closed plan reads `—`, not a live
                  count in ready-amber linking into a phase nobody will run. */}
              <TD className="text-right font-mono tabular-nums">
                {!row.isClosed && row.readyPhases.length ? (
                  <a
                    href={phaseHref(row.slug, row.readyPhases[0])}
                    className="text-ready hover:text-action"
                    title={`Open phase ${row.readyPhases[0]}`}
                  >
                    {row.readyPhases.length}
                  </a>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </TD>
              {/* Sessions is the unit of work left; the estimate under it is
                  what that has been costing in wall-clock. Sorting still keys
                  off the session count — a time is a derived reading of it. */}
              <TD className="text-right font-mono tabular-nums text-ink-faint">
                {row.remainingSessions || '—'}
                {row.eta && (
                  <span className="block whitespace-nowrap" title={etaTitle(row.eta)}>
                    {etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}
                  </span>
                )}
              </TD>
              <TD className="max-w-40">
                <span
                  className="block truncate font-mono text-2xs text-ink-faint"
                  title={repoLabel(row.repos).title}
                >
                  {repoLabel(row.repos).text || '—'}
                </span>
              </TD>
              {/* Needs-you rides in the Health cell, ahead of the concern: it
                  is the same column's question — what is wrong here — and it
                  is the only answer that names a person rather than a state. */}
              <TD className="max-w-56">
                <span className="flex min-w-0 items-center gap-1.5">
                  <NeedsYouChip row={row} />
                  <ConcernChip row={row} />
                  {row.needsYou === 0 && concerns(row).filter((c) => c.key !== 'needs-you').length === 0 && (
                    <span className="text-ink-faint">—</span>
                  )}
                </span>
              </TD>
              <TD>
                <RunChip row={row} /> {!row.run && <span className="text-ink-faint">—</span>}
              </TD>
              <TD className="whitespace-nowrap text-2xs text-ink-faint">{relativeTime(row.activity)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}
