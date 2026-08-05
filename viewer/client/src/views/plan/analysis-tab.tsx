import {
  Card, CardBody, CardHeader, CardTitle, Chip, CopyButton, KeyValue, Tile,
  Table, TableWrap, TBody, TD, TH, THead, TR,
} from '@/components/ui';
import { pad2, plural, weight } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { phaseHref } from '@shared/routes.js';
import { cn } from '@/lib/cn';
import type { PlanDetail } from '@/lib/api';

const SEVERITY_TONE = {
  error: 'border-blocked/50 text-blocked',
  warning: 'border-action/50 text-action',
  info: 'border-rule text-ink-muted',
} as const;

/** A phase number as a link, for the places analysis names one. */
function P({ slug, phase }: { slug: string; phase: number }) {
  return (
    <a
      href={phaseHref(slug, phase)}
      className="inline-flex items-center rounded-sm border border-rule px-1.5 py-0.5 text-2xs text-ink-muted hover:border-rule-strong hover:text-ink"
    >
      P{phase}
    </a>
  );
}

/** Where the work is, what is holding it up, and what the terminal would say. */
export function AnalysisTab({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const slug = s.slug;

  const completions = detail.handoffs
    .filter((handoff) => handoff.completed)
    .sort((a, b) => String(a.completed).localeCompare(String(b.completed)));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile label="Progress" value={`${s.percent}%`} hint={`${s.done} of ${s.phases} phases`} />
        <Tile
          label="Work left"
          value={weight(s.remainingWeight)}
          hint={`≈ ${plural(s.remainingSessions, 'session')} at ${weight(s.budget)}`}
        />
        <Tile
          label="Critical path"
          value={String(s.criticalPath.length)}
          hint={s.criticalPath.length
            ? `P${s.criticalPath.join(' → P')} · min ${plural(s.minimumSessions, 'session')}`
            : 'nothing left'}
        />
        <Tile
          label="Ready now"
          value={String(s.ready.length)}
          state={s.ready.length > 0 ? 'state-ready' : undefined}
          hint={s.nextBest ? `best next: P${s.nextBest.phase} (unblocks ${s.nextBest.unblocks})` : 'none'}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Where the work is</CardTitle></CardHeader>
          <CardBody>
            <KeyValue
              items={[
                ['Bottleneck', s.bottleneck
                  ? (
                    <span>
                      <P slug={slug} phase={s.bottleneck.phase} /> holds up{' '}
                      {plural(s.bottleneck.blocks, 'phase')}
                    </span>
                  )
                  : 'nothing is blocking'],
                ['Critical path', s.criticalPath.length
                  ? (
                    <div className="flex flex-wrap gap-1">
                      {s.criticalPath.map((phase) => <P key={phase} slug={slug} phase={phase} />)}
                    </div>
                  )
                  : null],
                ['Repos touched', s.repos.join(' · ') || null],
                ['In progress', s.inProgress.length ? `P${s.inProgress.join(', P')}` : 'none'],
                ['Blocked', s.stuck.length ? `P${s.stuck.join(', P')}` : 'none'],
                ['Median gap between phases',
                  s.medianGapDays != null ? plural(s.medianGapDays, 'day') : null],
                ['Span', s.spanDays != null
                  ? `${plural(s.spanDays, 'day')} from first to last completion`
                  : null],
                ['Last completed', s.lastCompleted],
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Health</CardTitle>
            <span className="text-xs text-ink-faint">{detail.lint?.summary ?? ''}</span>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {s.issues.length
              ? s.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      'shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs whitespace-nowrap',
                      SEVERITY_TONE[issue.severity],
                    )}
                  >
                    {issue.kind}
                  </span>
                  <span className="min-w-0 text-ink-muted">
                    {issue.message}
                    {issue.phase != null && <> <P slug={slug} phase={issue.phase} /></>}
                  </span>
                </div>
              ))
              : isClosed(s)
                // The card is honest either way, but not with the same sentence.
                // On a closed plan the engine has stopped raising the progress
                // issues (stale handoff, missing handoff, index drift, a QA
                // fail); claiming everything "agrees" would be asserting a check
                // that was never run.
                ? (
                  <span className="text-sm text-ink-faint">
                    Nothing structural to flag. This plan is closed, so progress issues — a stale
                    or missing handoff, index drift, a recorded QA failure — are no longer raised.
                  </span>
                )
                : <span className="text-sm text-ink-faint">Nothing to flag — plan, handoffs and index agree.</span>}
          </CardBody>
        </Card>
      </div>

      {completions.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Completion timeline</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-1.5">
            {completions.map((handoff) => (
              <div key={handoff.phase} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 font-mono text-xs text-ink-faint">{handoff.completed}</span>
                <Chip mono>P{pad2(handoff.phase)}</Chip>
                <span className="min-w-0 truncate text-ink-muted">{handoff.title}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {detail.qa.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>QA status</CardTitle>
            <span className="text-xs text-ink-faint">regime: {s.qaMode}</span>
          </CardHeader>
          <TableWrap className="rounded-none border-0 border-t border-rule">
            <Table>
              <THead>
                <TR><TH className="w-20">Phase</TH><TH className="w-28">Result</TH><TH>Report</TH></TR>
              </THead>
              <TBody>
                {detail.qa.map((row) => (
                  <TR key={row.phase}>
                    <TD className="font-mono">{row.phase}</TD>
                    <TD>
                      <Chip tone={row.result === 'fail' ? 'bad' : 'neutral'}>{row.result}</Chip>
                    </TD>
                    <TD className="font-mono text-xs break-all">{row.report ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What the terminal shows</CardTitle>
          <CopyButton text={detail.boardText} label="Copy board" />
        </CardHeader>
        <pre className="m-0 overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {detail.boardText}
        </pre>
      </Card>
    </div>
  );
}
