import { Chip, StateChip } from '@/components/ui';
import { MarkdownInline, plainText } from '@/components/markdown';
import { pad2 } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import { cn } from '@/lib/cn';
import type { PlanDetail } from '@/lib/api';

/**
 * Every phase, as one tall list — the view for a phone, where the departures
 * table's six columns cannot all be true at once.
 */
export function PhasesTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;

  return (
    <div className="flex flex-col gap-2">
      {detail.phases.map((phase) => (
        <a
          key={phase.phase}
          href={phaseHref(slug, phase.phase)}
          className={cn(
            'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2.5',
            'bg-surface transition-colors hover:border-rule-strong',
            phase.state === 'ready' ? 'border-action/45' : 'border-rule',
          )}
        >
          <span className="font-mono text-xl text-ink-faint">{pad2(phase.phase)}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">
              <MarkdownInline text={phase.title} />
            </span>
            <span className="block truncate text-2xs text-ink-faint">
              {phase.goal ? plainText(phase.goal).slice(0, 110) : (phase.row?.exitCriteria ?? '')}
            </span>
          </span>
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <StateChip state={phase.state} board />
            <Chip mono>{phase.size}</Chip>
            {phase.gated && <Chip tone="gate">gate</Chip>}
            {phase.handoff && <Chip title={`Handoff: ${phase.handoff.status}`}>H</Chip>}
          </span>
        </a>
      ))}
    </div>
  );
}
