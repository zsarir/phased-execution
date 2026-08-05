import {
  Card, CardBody, CardHeader, CardTitle, Chip, Empty,
  Table, TableWrap, TBody, TD, TH, THead, TR,
} from '@/components/ui';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { countdown, pad2 } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';
import { DepsCell, LockCell } from './phase-cells';

/** The plan file itself: its prose, the machine-read graph table, its memory. */
export function OverviewTab({ detail }: { detail: PlanDetail }) {
  const plan = detail.plan;

  if (!plan) {
    return (
      <Empty
        title="No plan file"
        body="This slug has handoffs but no plan in docs/plans."
      />
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        {plan.provenance && (
          <Card>
            <CardBody>
              <Markdown text={`> ${plan.provenance.replace(/\n/g, '\n> ')}`} />
            </CardBody>
          </Card>
        )}

        {plan.context && (
          <Card>
            <CardHeader><CardTitle>Context</CardTitle></CardHeader>
            <CardBody><Markdown text={plan.context} /></CardBody>
          </Card>
        )}

        {plan.architecture && (
          <Card>
            <CardHeader><CardTitle>Architecture</CardTitle></CardHeader>
            <CardBody><Markdown text={plan.architecture} /></CardBody>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Phase graph</CardTitle>
            <span className="text-xs text-ink-faint">the machine-read table</span>
          </CardHeader>
          <TableWrap className="rounded-none border-x-0 border-t">
            <Table>
              <THead>
                <TR>
                  <TH className="w-12">#</TH>
                  <TH>Title</TH>
                  <TH className="w-40">Depends on</TH>
                  {/* Joined in from the phase view: the graph table is what the
                      engine reads, and who holds a row is the one fact about it
                      that is not in the plan file. */}
                  <TH className="w-40">Lock</TH>
                  <TH className="w-32">Parallel-safe</TH>
                  <TH className="w-36">Repos</TH>
                  <TH>Exit criteria</TH>
                </TR>
              </THead>
              <TBody>
                {plan.graph.map((row) => {
                  const view = detail.phases.find((p) => p.phase === row.phase);
                  return (
                  <TR key={row.phase} className="relative">
                    <TD className="font-mono">
                      <a
                        href={phaseHref(plan.slug, row.phase)}
                        className="rounded-sm after:absolute after:inset-0 after:content-['']"
                      >
                        {row.phase}
                      </a>
                    </TD>
                    <TD className="text-ink"><MarkdownInline text={row.title} /></TD>
                    <TD>
                      {view
                        ? <DepsCell slug={plan.slug} phase={view} />
                        : <span className="font-mono text-xs">{row.dependsOn.join(', ') || '—'}</span>}
                    </TD>
                    <TD><LockCell lock={view?.lock} /></TD>
                    <TD className="font-mono text-xs">{row.parallelSafe || '—'}</TD>
                    <TD className="font-mono text-xs">{row.repos || '—'}</TD>
                    <TD className="text-xs"><MarkdownInline text={row.exitCriteria} /></TD>
                  </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
          {plan.callouts.length > 0 && (
            <CardBody className="border-t border-rule">
              {plan.callouts.map((line, i) => <Markdown key={i} text={line} />)}
            </CardBody>
          )}
        </Card>

        {plan.endToEnd && (
          <Card>
            <CardHeader><CardTitle>End-to-end verification</CardTitle></CardHeader>
            <CardBody><Markdown text={plan.endToEnd} /></CardBody>
          </Card>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card>
          <CardHeader><CardTitle>Session budget</CardTitle></CardHeader>
          <CardBody><Markdown text={plan.sessionBudget.raw} /></CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            {detail.memory && (
              <span className="font-mono text-2xs break-all text-ink-faint">{detail.memory.key}</span>
            )}
          </CardHeader>
          <CardBody className={detail.memory ? 'max-h-[32rem] overflow-auto overscroll-contain' : ''}>
            {detail.memory
              ? <Markdown text={detail.memory.text} />
              : (
                <p className="text-sm text-ink-faint">
                  No <code className="font-mono">{detail.summary.slug}</code> memory entry found in the
                  Claude memory directories.
                </p>
              )}
          </CardBody>
        </Card>

        {detail.locks.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Locks</CardTitle></CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {detail.locks.map((lock) => (
                <div key={lock.phase} className="flex items-center justify-between gap-2 text-sm">
                  <Chip mono>P{pad2(lock.phase ?? 0)}</Chip>
                  <span className="min-w-0 truncate font-mono text-xs text-ink-muted">{lock.owner}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {lock.expired ? 'expired' : countdown(lock.leaseUntil)}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
