/**
 * The fleet: every run, and what it actually did.
 *
 * ## The signature
 *
 * Each row carries a **strip of phase outcomes** — one segment per phase the run
 * touched, painted done / running / failed / parked / skipped. It is drawn from
 * `RunState.phases`, which `/api/runs` has always sent and no page has ever
 * read. Eight green and one red is a different run from one green and eight
 * grey, and the status word `halted` cannot tell them apart.
 *
 * ## Expanding a row
 *
 * The same payload holds, per phase, the attempts, the cost, the turns, the
 * wall-clock, the model it ran on and the session's own closing words. That is
 * the whole account of a run, and until now reading any of it meant leaving the
 * page. A row opens into it, and nothing is fetched to do so — the expander is
 * pure disclosure of bytes already in the cache.
 *
 * ## Why a table and not cards
 *
 * Runs are compared, not browsed. Cost against cost, duration against duration:
 * that is a column job. `TableWrap` owns the horizontal scroll, so a nine-column
 * table never pushes a phone sideways.
 */

import { useState } from 'react';
import { ChevronRight, Radio } from 'lucide-react';
import {
  Button, Chip, TBody, TD, TH, THead, TR, Table, TableWrap, Tile,
} from '@/components/ui';
import { LoadMeter, RunStrip } from '@/components/charts';
import { duration, money, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { planHref } from '@shared/routes.js';
import type { ChipProps } from '@/components/ui';
import type { PhaseRecord } from '@/lib/api';
import { RUN_TONE } from '../run/header';
import { PROFILE_LABEL } from '../run/defaults';
import { fleetTotals, groupRows, type RunRow } from './model';

/**
 * How many rows before the table stops being a table.
 *
 * A source with a year of autopilot behind it has hundreds of runs, and the
 * hundredth finished one answers nothing. The cut is always announced — a list
 * that quietly truncates reads as "that is everything".
 */
const SHOW_LIMIT = 40;

const PHASE_TONE: Record<string, ChipProps['tone']> = {
  done: 'ok',
  running: 'busy',
  verifying: 'busy',
  failed: 'bad',
  interrupted: 'stuck',
  parked: 'gate',
  gated: 'gate',
  'awaiting-verification': 'warn',
};

/* ------------------------------------------------------------------ *
 * The counters
 * ------------------------------------------------------------------ */

/**
 * The fleet's own numbers.
 *
 * They live here rather than on the dashboard because they are about runs, not
 * about plans: what the autopilot has spent and how long it has worked has no
 * other home in the console. Every one of them describes the *filtered* set, so
 * a total can never sit above a list it does not account for.
 */
export function FleetTiles({ rows }: { rows: RunRow[] }) {
  const totals = fleetTotals(rows);
  return (
    <section aria-label="What the fleet is doing" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile
        label="In flight"
        value={totals.live}
        state={totals.live ? 'state-in-progress' : undefined}
        hint={totals.live ? 'spending money right now' : 'nothing is running'}
      />
      <Tile
        label="Waiting on you"
        value={totals.attention}
        state={totals.attention ? 'state-ready' : undefined}
        hint={totals.attention ? 'stopped until someone moves it' : 'nothing is parked'}
      />
      <Tile label="Spent" value={money(totals.spent)} hint="across the runs shown" />
      <Tile
        label="Time on task"
        value={totals.worked ? duration(totals.worked) : '—'}
        hint={`${totals.shown} run${totals.shown === 1 ? '' : 's'} shown`}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * One phase of one run
 * ------------------------------------------------------------------ */

function PhaseLine({ phase }: { phase: PhaseRecord }) {
  const facts = [
    phase.attempts > 1 ? `${phase.attempts} attempts` : null,
    phase.costUsd ? money(phase.costUsd) : null,
    phase.turns ? `${phase.turns} turns` : null,
    phase.durationMs ? duration(phase.durationMs) : null,
    phase.actualModel ?? phase.model,
    phase.effort,
  ].filter(Boolean) as string[];

  const verify = phase.verification;

  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-l-2 border-rule py-1 pl-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-2xs tabular-nums text-ink-faint">P{phase.phase}</span>
        <Chip tone={PHASE_TONE[phase.status] ?? 'neutral'}>{phase.status}</Chip>
        <span className="min-w-0 truncate font-mono text-2xs text-ink-faint">{facts.join(' · ')}</span>
      </div>
      {verify && !verify.ok && (
        <p className="text-2xs text-blocked">verification: {verify.reason}</p>
      )}
      {/* The session's closing words. When a phase exits clean and changes
          nothing, this is the only account of why. */}
      {(phase.note || phase.said) && (
        <p className="line-clamp-2 text-2xs text-ink-muted">{phase.note ?? phase.said}</p>
      )}
    </li>
  );
}

/** What a resolved run says about itself, wherever it is rendered. */
function ResolvedNote({ row }: { row: RunRow }) {
  if (!row.resolution) return null;
  return (
    <span className="block truncate text-2xs text-ink-faint" title={row.resolution.reason}>
      resolved · {row.resolution.reason}
      {row.resolution.note ? ` — ${row.resolution.note}` : ''}
    </span>
  );
}

function RunDetail({
  row,
  columns,
  onWatch,
  watching,
  onResolve,
  allowRun,
  busy,
}: {
  row: RunRow;
  columns: number;
  onWatch: (row: RunRow) => void;
  watching: boolean;
  onResolve?: (row: RunRow, resolve: boolean) => void;
  allowRun: boolean;
  busy: boolean;
}) {
  const settings = [
    `${row.model}${row.effort ? ` · ${row.effort}` : ''}`,
    row.autonomy,
    PROFILE_LABEL[row.profile as keyof typeof PROFILE_LABEL]?.split(' — ')[0] ?? row.profile,
    row.budgetUsd ? `budget ${money(row.budgetUsd)}` : 'no run budget',
    row.retries ? `${row.retries} retries` : null,
    row.failures ? `${row.failures}/${row.maxFailures} consecutive failures` : null,
  ].filter(Boolean) as string[];

  return (
    <TR>
      <TD colSpan={columns} className="bg-ground/40">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-mono text-2xs text-ink-faint">{settings.join(' · ')}</span>
          <div className="ml-auto flex shrink-0 gap-1.5">
            {/* Only a stopped run has a card to dismiss; a finished or running
                one was never asking for anything. */}
            {onResolve && (row.status === 'halted' || row.status === 'interrupted') && (
              <Button
                size="sm"
                disabled={!allowRun || busy}
                title={allowRun
                  ? undefined
                  : 'Runs are disabled. Restart the console with --allow-run to change a run record.'}
                onClick={() => onResolve(row, !row.resolution)}
              >
                {row.resolution ? 'Put the card back' : 'Dismiss'}
              </Button>
            )}
            <Button size="sm" onClick={() => onWatch(row)} aria-pressed={watching}>
              <Radio size={13} aria-hidden />
              {watching ? 'In the console' : 'Show in console'}
            </Button>
            <Button size="sm" asChild>
              <a href={planHref(row.slug, 'run')}>Open the autopilot</a>
            </Button>
          </div>
        </div>

        {row.resolution && (
          <p className="mt-1.5 text-2xs text-ink-muted">
            This run stopped asking for anyone{' '}
            {row.resolution.auto
              ? 'because the board moved past it'
              : `when ${row.resolution.by ?? 'someone'} dismissed it`}
            {' '}— {row.resolution.reason}
            {row.resolution.note ? ` (${row.resolution.note})` : ''}. Its record is untouched.
          </p>
        )}

        {row.phases.length
          ? <ul className="mt-2 flex flex-col gap-1">{row.phases.map((p) => <PhaseLine key={p.phase} phase={p} />)}</ul>
          : (
            <p className="mt-2 text-2xs text-ink-faint">
              This run recorded no phases — it stopped before the first one started.
            </p>
          )}
      </TD>
    </TR>
  );
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

const COLUMNS = 9;

function FleetRows({
  rows,
  open,
  onToggle,
  onWatch,
  watchingId,
  onResolve,
  allowRun,
  busyId,
}: {
  rows: RunRow[];
  open: Set<string>;
  onToggle: (id: string) => void;
  onWatch: (row: RunRow) => void;
  watchingId?: string;
  onResolve?: (row: RunRow, resolve: boolean) => void;
  allowRun: boolean;
  busyId?: string;
}) {
  return (
    <TBody>
      {rows.map((row) => {
        const expanded = open.has(row.id);
        return [
          <TR key={row.id} className={cn(row.live && 'bg-progress/6')}>
            <TD className="w-8 pr-0">
              <button
                type="button"
                onClick={() => onToggle(row.id)}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} the phases of run ${row.id}`}
                className="grid size-6 place-items-center rounded text-ink-faint hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
              >
                <ChevronRight
                  size={14}
                  aria-hidden
                  className={cn('transition-transform', expanded && 'rotate-90')}
                />
              </button>
            </TD>
            <TD className="max-w-48">
              <a href={planHref(row.slug, 'run')} className="block truncate text-ink hover:text-action">
                {row.slug}
              </a>
            </TD>
            <TD><code className="font-mono text-2xs text-ink-faint">{row.id}</code></TD>
            <TD>
              <Chip
                tone={RUN_TONE[row.status as keyof typeof RUN_TONE]}
                dot={row.live}
                className={cn(row.live && 'animate-pulse-soft')}
              >
                {row.status}
              </Chip>
            </TD>
            <TD className="w-36">
              {row.phases.length
                ? (
                  <span className="flex items-center gap-2">
                    <RunStrip
                      className="min-w-16 flex-1"
                      phases={row.phases.map((p) => ({
                        phase: p.phase,
                        status: p.status,
                        detail: [
                          p.attempts > 1 ? `${p.attempts} attempts` : null,
                          p.costUsd ? money(p.costUsd) : null,
                        ].filter(Boolean).join(' · '),
                      }))}
                    />
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
                      {row.phasesDone}/{row.phases.length}
                    </span>
                  </span>
                )
                : <span className="text-2xs text-ink-faint">no phases</span>}
            </TD>
            <TD className="w-28">
              <LoadMeter
                fraction={row.spendFraction}
                label={money(row.spentUsd)}
                description={row.budgetUsd
                  ? `${money(row.spentUsd)} of a ${money(row.budgetUsd)} run budget`
                  : `${money(row.spentUsd)}, no run budget set`}
                tone={row.overBudget ? 'blocked' : 'progress'}
              />
            </TD>
            <TD className="whitespace-nowrap font-mono text-2xs tabular-nums text-ink-faint">
              {row.workedMs ? duration(row.workedMs) : '—'}
            </TD>
            <TD className="max-w-56">
              <span
                className={cn(
                  'block truncate text-2xs',
                  // A resolved run's halt reason is history, not a warning — it
                  // reads in the muted voice even when it says "halted".
                  row.outcome === 'halted' && !row.resolution ? 'text-blocked' : 'text-ink-muted',
                )}
                title={row.reason}
              >
                {row.reason}
              </span>
              <ResolvedNote row={row} />
            </TD>
            <TD className="whitespace-nowrap text-2xs text-ink-faint">{relativeTime(row.updatedAt)}</TD>
          </TR>,
          expanded && (
            <RunDetail
              key={`${row.id}-detail`}
              row={row}
              columns={COLUMNS}
              onWatch={onWatch}
              watching={watchingId === row.id}
              onResolve={onResolve}
              allowRun={allowRun}
              busy={busyId === row.id}
            />
          ),
        ];
      })}
    </TBody>
  );
}

export function Fleet({
  rows,
  grouped,
  onWatch,
  watchingId,
  onResolve,
  allowRun = false,
  busyId,
}: {
  rows: RunRow[];
  grouped: boolean;
  onWatch: (row: RunRow) => void;
  watchingId?: string;
  onResolve?: (row: RunRow, resolve: boolean) => void;
  allowRun?: boolean;
  busyId?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [all, setAll] = useState(false);

  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const shown = all ? rows : rows.slice(0, SHOW_LIMIT);
  const groups = groupRows(shown, grouped);

  const head = (
    <THead>
      <TR>
        {/* Not "Phases" — that is the strip column four along, and two headers
            reading the same word is two columns a screen reader cannot tell
            apart. */}
        <TH className="w-8"><span className="sr-only">Expand</span></TH>
        <TH>Plan</TH>
        <TH>Run</TH>
        <TH>Status</TH>
        <TH>Phases</TH>
        <TH>Spent</TH>
        <TH>Worked</TH>
        <TH>Why</TH>
        <TH>Updated</TH>
      </TR>
    </THead>
  );

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.key || 'all'}>
          {grouped && (
            <h3 className="mb-1 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
              <a href={planHref(group.key, 'run')} className="hover:text-action">{group.key}</a>
              <span className="font-mono tabular-nums">{group.rows.length}</span>
            </h3>
          )}
          <TableWrap>
            <Table>
              {head}
              <FleetRows
                rows={group.rows}
                open={open}
                onToggle={toggle}
                onWatch={onWatch}
                watchingId={watchingId}
                onResolve={onResolve}
                allowRun={allowRun}
                busyId={busyId}
              />
            </Table>
          </TableWrap>
        </div>
      ))}

      {rows.length > SHOW_LIMIT && (
        <div className="flex items-center gap-2 text-2xs text-ink-faint">
          {all
            ? <>Showing all {rows.length}.</>
            : <>Showing the {SHOW_LIMIT} most relevant of {rows.length}.</>}
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {all ? `Show only ${SHOW_LIMIT}` : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}
