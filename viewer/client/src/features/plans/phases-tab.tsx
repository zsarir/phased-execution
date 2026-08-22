/**
 * Every phase of a plan, grouped by what it wants from you.
 *
 * It used to be one flat list in plan order, which is the order a plan is
 * WRITTEN in and never the order it is read in: the phase that is blocked on a
 * person sat wherever its number put it, under thirty finished ones. The five
 * groups are `features/runs`' — the same `PHASE_GROUPS`, the same `groupRows`,
 * so "Needs you" cannot come to mean two different things on two pages — with
 * Done collapsed by default and the choice remembered.
 *
 * Three things are shared with the run page rather than rebuilt:
 *
 *   - **`PhaseDrawer`** — the same panel against the same endpoint. It fetches
 *     its own diagnosis and rulings when opened; nothing is threaded in.
 *   - **`EvidenceLine`** — claimed versus evidenced. A `done` row that nothing
 *     on disk backs is the single most useful thing this list can say, and on
 *     the plan page it was not said at all.
 *   - **`ScopeChips` / `DepsCell` / `LockChip` / `FlagsCell`** — what it
 *     touches, what it waits on, who holds it, what is unusual about it.
 *
 * A row is a CARD, not a table row: this is the phone rendering of the route
 * tab as well as the tab in its own right, and the departures board's eight
 * columns cannot all be true at 390 px.
 */

import { Chip, StateChip } from '@/components/ui';
import { MarkdownInline, plainText } from '@/components/markdown';
import { ScopeChips } from '@/components/scope-chips';
import { EvidenceLine } from '@/features/runs/phase-row';
import { PhaseDrawer } from '@/features/runs/phase-drawer';
import { groupRows } from '@/features/runs/phase-table';
import { usePrefs } from '@/lib/prefs';
import { pad2 } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import { scopeOfRow } from '@shared/scope.js';
import { cn } from '@/lib/cn';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { DepsCell, FlagsCell, LockChip } from './phase-cells';

/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
const scopeOf = scopeOfRow as (cell: string | undefined) => string[];

/**
 * One phase, with everything that decides whether it can move.
 *
 * The card is a link and the drawer is a `<details>` INSIDE it, which needs
 * saying because it looks like a mistake: the anchor covers the card's head
 * only (`::after` on the number), never the whole card, so opening the drawer
 * is not also a navigation. The old phone list stretched one anchor over
 * everything, which is why there was nowhere to put a control.
 */
function PhaseCard({ slug, phase }: { slug: string; phase: PhaseView }) {
  return (
    <div
      className={cn(
        'relative rounded-lg border bg-surface px-3 py-2.5 transition-colors hover:border-rule-strong',
        phase.state === 'ready' ? 'border-action/45' : 'border-rule',
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
        <a href={phaseHref(slug, phase.phase)} className="rounded-sm font-mono text-xl text-ink-faint">
          {pad2(phase.phase)}
        </a>
        <div className="min-w-0">
          <a href={phaseHref(slug, phase.phase)} className="block truncate font-medium text-ink">
            <MarkdownInline text={phase.title} />
          </a>
          <span className="block truncate text-2xs text-ink-faint">
            {phase.goal ? plainText(phase.goal).slice(0, 110) : (phase.row?.exitCriteria ?? '')}
          </span>
          {/* What the phase touches — the fact that decides what may run
              beside it, same chips as the run table. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ScopeChips tokens={scopeOf(phase.row?.repos)} />
            {/* Unlinked: the deps are named, not navigated — the row's own
                anchors are the number and the title. */}
            <DepsCell slug={slug} phase={phase} linked={false} />
          </span>
          {/* Claimed versus evidenced. Renders nothing at all on a console
              whose server does not send `proof`, which is the honest answer:
              a tick there would be a claim this build cannot make. */}
          {phase.proof && <EvidenceLine proof={phase.proof} />}
        </div>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <StateChip state={phase.state} board />
          <Chip mono>{phase.size}</Chip>
          <LockChip lock={phase.lock} compact />
          <FlagsCell slug={slug} phase={phase} linked={false} />
        </span>
      </div>
      {/* The drawer, unchanged from the run page. It costs a `git status` and
          two script runs, so it asks for nothing until it is opened. */}
      <PhaseDrawer slug={slug} phase={phase.phase} />
    </div>
  );
}

export function PhasesTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const [prefs, setPrefs] = usePrefs();
  // The COLLAPSED ids, not the open ones — the run page's rule, for the same
  // reason: a group added later opens by default rather than hiding itself.
  const collapsed = prefs.planPhasesCollapsed ?? ['done'];

  return (
    <div className="flex flex-col gap-3">
      {groupRows(detail.phases).map((group) => {
        const shut = collapsed.includes(group.id);
        return (
          <section key={group.id}>
            <button
              type="button"
              aria-expanded={!shut}
              className="mb-1.5 flex w-full cursor-pointer items-baseline gap-2 text-left"
              onClick={() =>
                setPrefs({
                  planPhasesCollapsed: shut
                    ? collapsed.filter((id) => id !== group.id)
                    : [...collapsed, group.id],
                })
              }
            >
              <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">
                {shut ? '▸' : '▾'}
              </span>
              <strong className="text-2xs uppercase tracking-[0.14em]">{group.label}</strong>
              <span className="font-mono text-2xs tabular-nums text-ink-faint">{group.rows.length}</span>
              <span className="truncate text-2xs text-ink-faint">{group.hint}</span>
            </button>
            {!shut && (
              <div className="flex flex-col gap-2">
                {group.rows.map((phase) => (
                  <PhaseCard key={phase.phase} slug={slug} phase={phase} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
