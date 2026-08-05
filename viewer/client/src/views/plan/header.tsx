import { Lock } from 'lucide-react';
import { Banner, Chip, KeyValue, Progress, StateChip } from '@/components/ui';
import { MarkdownInline } from '@/components/markdown';
import { WriteMenu } from '@/components/write-menu';
import { useConsoleState } from '@/lib/queries';
import { closedTitle, isClosed } from '@/lib/closure';
import { cn } from '@/lib/cn';
import { etaLabel, etaTitle, plural, weight } from '@/lib/format';
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
  const closed = isClosed(s);
  const { data: state } = useConsoleState();
  // The detail's own estimate, not the summary's: they are computed from the
  // same rate, but the detail's `remaining` respects a scoped run and this page
  // is where that difference would be visible.
  const eta = detail.eta?.plan ?? s.eta ?? null;

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className={cn('font-display text-3xl leading-none', closed && 'text-ink-muted')}>{s.title}</h1>
          {/* A closed plan gets a BADGE, not a chip.
              It used to be the status word wearing a small padlock, on the
              reasoning that `abandoned` says more than `CLOSED` and two chips
              for one fact stop a header being scannable. That reasoning was
              sound and still landed wrong: at chip size, beside a heading, next
              to the `document`/`orphan` chips, it read as one more piece of
              metadata — and closure is not metadata, it is the fact that
              changes how everything below it should be read. So: one badge,
              both words (`CLOSED · abandoned`), at a size that is seen before
              it is looked for. Non-terminal statuses keep the plain chip. */}
          {closed
            ? (
              <span
                title={closedTitle(s)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-rule-strong bg-surface-raised px-2 py-1 text-xs font-medium uppercase tracking-[0.12em] text-ink-muted"
              >
                <Lock size={13} className="shrink-0" aria-hidden />
                Closed
                {s.status && <span className="font-normal normal-case tracking-normal text-ink-faint">· {s.status}</span>}
              </span>
            )
            : s.status && <Chip>{s.status}</Chip>}
          {s.kind !== 'plan' && (
            <Chip tone="warn">{s.kind === 'document' ? 'document' : 'orphan handoffs'}</Chip>
          )}
        </div>
        {/* Renders nothing at all on a read-only console — the rail already
            says the session cannot write, and repeating it here is noise. */}
        <WriteMenu detail={detail} allowWrites={Boolean(state?.allowWrites)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-2xs text-ink-faint">{s.slug}</span>
        {s.phases > 0 && (
          <>
            {/* Only `done` is painted on a closed plan — the rest is grey.
                An amber ready notch means "this could move today", which is
                the one claim closure withdraws. Same rule as `plans/row.tsx`. */}
            <span className="w-[min(20rem,40vw)]">
              <Progress
                total={s.phases}
                done={s.done}
                inProgress={closed ? 0 : s.inProgress.length}
                ready={closed ? 0 : s.ready.length}
                stuck={closed ? 0 : s.stuck.length}
              />
            </span>
            <span className="font-mono text-2xs text-ink-faint">
              {s.done}/{s.phases} · {s.percent}%
              {closed && s.done < s.phases && ` · ${s.phases - s.done} never ran`}
            </span>
          </>
        )}
        {/* `summary.ready` stays populated on a closed plan (the engine reports
            what never got done), and these are action-coloured links straight
            into a phase. Suppressed here for the same reason the ready board
            drops the plan outright. */}
        {!closed && s.ready.map((phase) => (
          <a
            key={phase}
            href={phaseHref(s.slug, phase)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-action/60 bg-action/12 px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap text-action hover:bg-action/20"
          >
            P{phase} ready
          </a>
        ))}
        {!closed && s.inProgress.map((phase) => (
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
          // Weight and sessions are what is left to DO; the estimate beside them
          // is how long that has actually been taking. The two answer the
          // question people ask as one — "how much further" — and the page could
          // only ever say the first half of it.
          s.remainingWeight
            ? ['Left', (
                <span>
                  {weight(s.remainingWeight)} ≈ {plural(s.remainingSessions, 'session')}
                  {eta && (
                    <span className="text-ink-faint" title={etaTitle(eta)}>
                      {' · '}{etaLabel(eta.lowMs, eta.highMs, eta.basis)}
                    </span>
                  )}
                </span>
              )]
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

      {/* First banner, and `info` rather than `warn`: closure is not a problem
          to be fixed, it is the answer to "why is this plan quiet". Stating the
          reason here is the whole point of storing one — a closed plan with no
          explanation tells the next reader nothing, which is why the write verb
          refuses to close without it. */}
      {closed && (
        <Banner severity="info">
          <div className="min-w-0">
            <strong>
              Closed{s.status ? ` — ${s.status}` : ''}
              {s.closedOn ? ` on ${s.closedOn}` : ''}
            </strong>
            {s.closedReason ? <> — {s.closedReason}</> : null}
            <div className="mt-1 text-ink-faint">
              This plan reports no ready work, no warnings and no boot prompts, and it is left out
              of every portfolio total. Its board below is kept in full. Reopen it to undo all of
              that.
            </div>
          </div>
        </Banner>
      )}

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
