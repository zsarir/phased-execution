import { Banner, Chip, KeyValue, Progress, StateChip } from '@/components/ui';
import { MarkdownInline } from '@/components/markdown';
import { plural, weight } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';

/**
 * Who this plan is, how far along it is, and what is actionable right now.
 *
 * The ready chips are links, not decoration: "P3 ready" is the single most
 * clicked thing in the console, and in the old client it was a `<button>` that
 * called `navigate()` — invisible to a middle click, a long press, or anything
 * that wanted to open a phase in a second tab.
 */
export function PlanHeader({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const budget = detail.plan?.sessionBudget;

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-3xl leading-none">{s.title}</h1>
        {s.status && <Chip>{s.status}</Chip>}
        {s.kind !== 'plan' && (
          <Chip tone="warn">{s.kind === 'document' ? 'document' : 'orphan handoffs'}</Chip>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-2xs text-ink-faint">{s.slug}</span>
        {s.phases > 0 && (
          <>
            <span className="w-[min(20rem,40vw)]">
              <Progress
                total={s.phases}
                done={s.done}
                inProgress={s.inProgress.length}
                ready={s.ready.length}
                stuck={s.stuck.length}
              />
            </span>
            <span className="font-mono text-2xs text-ink-faint">
              {s.done}/{s.phases} · {s.percent}%
            </span>
          </>
        )}
        {s.ready.map((phase) => (
          <a
            key={phase}
            href={phaseHref(s.slug, phase)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-action/60 bg-action/12 px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap text-action hover:bg-action/20"
          >
            P{phase} ready
          </a>
        ))}
        {s.inProgress.map((phase) => (
          <StateChip key={phase} state="in-progress" board label={`P${phase} on track`} />
        ))}
      </div>

      <KeyValue
        className="sm:grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),auto))] sm:gap-x-6"
        items={[
          budget?.targetModel ? ['Model', <span className="font-mono">{budget.targetModel}</span>] : null,
          s.budget ? ['Budget', `${weight(s.budget)}/session`] : null,
          // The branch cell is prose from the plan's §Session budget line and
          // routinely contains backticks. The old client printed them raw
          // (`current branch \`main\` in both repos`); rendering it inline is
          // the same treatment the phase titles get.
          budget?.branch ? ['Branch', <MarkdownInline text={budget.branch} />] : null,
          ['QA', s.qaMode],
          s.remainingWeight
            ? ['Left', `${weight(s.remainingWeight)} ≈ ${plural(s.remainingSessions, 'session')}`]
            : null,
          detail.git?.sha
            ? ['Last commit', (
                <span>
                  <span className="font-mono">{detail.git.sha}</span>
                  {detail.git.relativeDate ? ` · ${detail.git.relativeDate}` : ''}
                  {detail.git.dirty ? <Chip tone="warn" className="ml-2">uncommitted</Chip> : null}
                </span>
              )]
            : null,
          budget?.skills?.length
            ? ['Skills', budget.skills.map((skill) => (
                <Chip key={skill} mono className="mr-1">{skill}</Chip>
              ))]
            : null,
        ]}
      />

      {s.engineError && <Banner severity="warn">Engine: {s.engineError}</Banner>}
      {detail.lint?.timedOut && <Banner severity="info">{detail.lint.summary}</Banner>}
      {detail.lint && !detail.lint.ok && (
        <Banner severity="error">
          <div className="min-w-0">
            <strong>{detail.lint.summary}</strong>
            <ul className="mt-1 list-disc pl-5">
              {detail.lint.issues.map((issue, i) => <li key={i}>{issue}</li>)}
            </ul>
          </div>
        </Banner>
      )}
    </div>
  );
}
