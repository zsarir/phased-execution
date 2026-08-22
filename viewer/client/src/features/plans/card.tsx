/**
 * A plan as a card — the browsing layout.
 *
 * One plan at a time, with room for its ready phases as their own tap targets
 * and for what is waiting on a person. The table (`list.tsx`) is the comparing
 * layout; both read the same `PlanRow` and the same chips from `row.tsx`, so
 * they cannot disagree — what differs is only how much room each fact gets.
 */

import { Card, Chip, StateChip } from '@/components/ui';
import { etaLabel, etaTitle, relativeTime } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import { concerns, type PlanRow } from './model';
import { ClosedChip, ConcernChip, NeedsYouChip, RunChip, Track, repoLabel, restingReason } from './row';

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
          {/* First, and ahead of the run badge: a person being asked outranks a
              process reporting. */}
          <NeedsYouChip row={row} />
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
