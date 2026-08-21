/**
 * A plan, twice: as a card and as a table row.
 *
 * ## The signature
 *
 * Every plan carries a **full-width track** — its phases as one bar, painted
 * done / in progress / stuck / ready and then the length still to be laid. Sixty
 * -five of them stacked is sixty-five parallel lines of different fill, and the
 * shape of the estate is legible before a single word is read: which plans are
 * nearly home, which are one amber notch away from moving, which are a long grey
 * run nobody has started.
 *
 * It costs nothing. `ui/progress.tsx` takes exactly the four counts
 * `/api/plans` already sends, so the whole picture is drawn from the list
 * payload — no per-plan detail fetch, no fan-out, honest at any length. The
 * dashboard's `RouteStrip` draws a segment per phase and is the better picture,
 * but it needs the plan detail; six of those is a reasonable trade for a teaser
 * and sixty-five is not.
 *
 * ## Two layouts, one vocabulary
 *
 * The card is for browsing — one plan at a time, with room for its ready phases
 * as their own tap targets. The table is for comparing — every plan on one
 * screen, sortable by the column you are asking about. Both read the same
 * `PlanRow`, so they cannot disagree; what differs is only how much room each
 * fact gets.
 */

import { AlertTriangle, Lock } from 'lucide-react';
import {
  Card,
  Chip,
  StateChip,
  StatusBadge,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/components/ui';
import { Progress } from '@/components/ui';
import { etaLabel, etaTitle, relativeTime } from '@/lib/format';
import { closedTitle } from '@/lib/closure';
import { cn } from '@/lib/cn';
import { phaseHref, planHref } from '@shared/routes.js';
import { runStatusTitle, runUiState } from '@/lib/status-vocab';
import { SORTS, concerns, type PlanRow, type SortId } from './model';

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/** What the autopilot is doing to this plan, when it has ever done anything. */
export function RunChip({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.run) return null;
  const { status, activePhase } = row.run;
  return (
    <a href={planHref(row.slug, 'run')} className={cn('shrink-0 rounded-sm', className)}>
      <StatusBadge
        state={runUiState(status)}
        label={`${status}${activePhase != null ? ` P${activePhase}` : ''}`}
        mono
        pulse={status === 'running'}
        title={runStatusTitle(status)}
      />
    </a>
  );
}

/** The track. Rendered only for something that has phases — a document has none. */
function Track({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.phases) {
    return <span className={cn('text-2xs text-ink-faint', className)}>no phases</span>;
  }
  // On a closed plan only `done` is painted. The engine still reports which
  // phases *would* be ready, in progress or stuck, but those are readings of
  // live work: an amber "ready" notch on an abandoned plan is the track saying
  // "this one could move today", which is the single thing closure denies. What
  // is left reads as unlaid grey — which is exactly what it is.
  const live = !row.isClosed;
  return (
    <Progress
      className={className}
      total={row.phases}
      done={row.done}
      inProgress={live ? row.inProgress.length : 0}
      ready={live ? row.readyPhases.length : 0}
      stuck={live ? row.stuck.length : 0}
    />
  );
}

/**
 * Repos, at the length a row can carry.
 *
 * One plan in this source names fourteen — a hundred and seventy-eight
 * characters, which as one truncated line reads `all · aws · customer-app · doc…`
 * and tells you nothing the first name did not. Two and a count is the same fact
 * at a size that fits; the full list is the `title`.
 */
export function repoLabel(repos: string[]): { text: string; title: string } {
  const title = repos.join(' · ');
  if (repos.length <= 3) return { text: title, title };
  return { text: `${repos.slice(0, 2).join(' · ')} +${repos.length - 2}`, title };
}

/**
 * The plan's own status word, and — when it is terminal — the fact that this
 * makes the plan closed.
 *
 * One chip, not two. The status word IS the more useful label (`abandoned`
 * says something `CLOSED` does not), so closure is carried by the padlock and
 * the tooltip rather than by a second chip repeating the first in capitals.
 * Non-terminal words (`proposal`, `backlog`) keep the plain rendering.
 */
function ClosedChip({ row }: { row: PlanRow }) {
  if (!row.isClosed) {
    return (
      <Chip title={"The plan's own frontmatter status — set by hand when a plan is finished or shelved."}>
        {row.status}
      </Chip>
    );
  }
  return (
    // `PlanRow` already carries `status`, `closedOn` and `closedReason`, which
    // is all `closedTitle` reads — no adapter needed.
    <Chip title={closedTitle(row)}>
      <Lock size={11} className="shrink-0" aria-hidden />
      {row.status}
    </Chip>
  );
}

/** The one thing most wrong with this plan, when something is. */
function ConcernChip({ row }: { row: PlanRow }) {
  const [worst] = concerns(row);
  if (!worst) return null;
  return (
    <Chip tone={worst.tone === 'bad' ? 'bad' : 'warn'} className="min-w-0 max-w-full">
      {worst.tone === 'bad' ? (
        <AlertTriangle size={11} className="shrink-0" aria-hidden />
      ) : (
        <Lock size={11} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{worst.text}</span>
    </Chip>
  );
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export function PlanCard({ row, index }: { row: PlanRow; index: number }) {
  // A closed plan shows no ready chips. Each chip is a link straight into a
  // phase captioned "P4 ready", and `readyPhases` stays populated on a closed
  // plan by design — so without this the list is the ready board's defect again,
  // one card at a time. `restingReason()` takes the space and says what actually
  // happened instead.
  const ready = row.isClosed ? [] : row.readyPhases;

  return (
    <Card
      className="animate-fade p-3 transition-colors hover:border-rule-strong"
      // Capped so a long list does not spend two seconds arriving.
      style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <a href={planHref(row.slug)} className="min-w-0 flex-1 hover:text-action">
          <span className="block truncate font-display text-lg leading-snug">{row.title}</span>
          {/* A plan with no `# title` heading gets its slug as the title from
              the server, and printing that twice is a row that reads
              `sa-robot-types-parity` `sa-robot-types-parity`. */}
          {row.slug !== row.title && (
            <span className="block truncate font-mono text-2xs text-ink-faint">{row.slug}</span>
          )}
        </a>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {!row.isPlan && <Chip>{row.kind === 'orphan-handoffs' ? 'handoffs only' : row.kind}</Chip>}
          {row.isPlan && row.status !== 'active' && row.status !== 'unknown' && <ClosedChip row={row} />}
          <RunChip row={row} />
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2.5">
        <Track row={row} className="flex-1" />
        {row.phases > 0 && (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
            {row.done}/{row.phases} · {row.percent}%
          </span>
        )}
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {ready.length > 0 ? (
          ready.slice(0, 4).map((phase) => (
            <a key={phase} href={phaseHref(row.slug, phase)} className="rounded-sm">
              <StateChip
                state="ready"
                label={`P${phase} ready`}
                mono
                className="hover:bg-action/12 [@media(hover:none)]:min-h-(--tap-min)"
              />
            </a>
          ))
        ) : (
          <span className="text-2xs text-ink-faint">{restingReason(row)}</span>
        )}
        {ready.length > 4 && <span className="text-2xs text-ink-faint">+{ready.length - 4} more</span>}

        {/* `max-w-full` and no `shrink-0`: the wrapper has to be allowed to
            give way, or the `truncate` inside it has nothing to truncate
            against and a plan naming fourteen repos pushes the card 700px
            past the viewport. */}
        <span className="ml-auto flex min-w-0 max-w-full items-center gap-2 text-2xs text-ink-faint">
          {row.repos.length > 0 && (
            <span className="min-w-0 truncate font-mono" title={repoLabel(row.repos).title}>
              {repoLabel(row.repos).text}
            </span>
          )}
          {row.eta && (
            <span className="shrink-0 whitespace-nowrap" title={etaTitle(row.eta)}>
              {etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}
            </span>
          )}
          <span className="shrink-0 whitespace-nowrap">{relativeTime(row.activity)}</span>
        </span>
      </div>

      {concerns(row).length > 0 && (
        <div className="mt-2 flex min-w-0">
          <ConcernChip row={row} />
        </div>
      )}
    </Card>
  );
}

/** Why a plan has nothing ready — five different facts, not one empty state. */
function restingReason(row: PlanRow): string {
  // Closure comes FIRST, and says how much never got done. An abandoned plan
  // with four phases left is not "every phase is done" and it is not "waiting on
  // another" — it is stopped, and the number is the only part of that a row can
  // usefully carry. `isComplete` cannot answer this: it is true of a finished
  // plan and false of an abandoned one, and both are closed.
  if (row.isClosed) {
    const left = Math.max(0, row.phases - row.done);
    if (!left) return `${row.status} — every phase is done`;
    return `${row.status} — ${left} of ${row.phases} phases never ran`;
  }
  if (row.isComplete) return 'every phase is done';
  if (row.inProgress.length) return `phase ${row.inProgress.join(', ')} in progress`;
  if (row.stuck.length) return `phase ${row.stuck.join(', ')} is stuck`;
  if (!row.phases) return 'a document, not a phased plan';
  return 'nothing ready — every remaining phase waits on another';
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

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
              <TD className="max-w-56">
                <ConcernChip row={row} />{' '}
                {concerns(row).length === 0 && <span className="text-ink-faint">—</span>}
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
