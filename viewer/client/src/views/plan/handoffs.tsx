import {
  Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip, CopyButton, Empty, Skeleton, StateChip,
  Table, TableWrap, TBody, TD, TH, THead, TR,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useHandoff } from '@/lib/queries';
import { pad2 } from '@/lib/format';
import { handoffHref, phaseHref } from '@shared/routes.js';
import { handoffState } from './phase-panel';
import type { PlanDetail } from '@/lib/api';

/** Every handoff written for this plan, newest information first-hand. */
export function HandoffsTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;

  if (!detail.handoffs.length) {
    return (
      <Empty
        title="No handoffs yet"
        body="A handoff is written at the end of each phase — that is what lets the next session start cold."
      />
    );
  }

  const indexRows = new Map(detail.index.map((row) => [row.phase, row]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Handoffs</CardTitle>
        <span className="text-xs text-ink-faint">
          {detail.handoffs.length} of {detail.summary.phases} phases
        </span>
      </CardHeader>
      <TableWrap className="rounded-none border-0 border-t border-rule">
        <Table>
          <THead>
            <TR>
              <TH className="w-14">#</TH>
              <TH>Title</TH>
              <TH className="w-28">Status</TH>
              <TH className="w-28">Completed</TH>
              <TH className="w-32">Skills</TH>
              <TH className="w-16">Size</TH>
              <TH className="w-28">Index row</TH>
            </TR>
          </THead>
          <TBody>
            {detail.handoffs.map((handoff) => (
              <TR key={handoff.phase} className="relative">
                <TD className="font-mono">
                  <a
                    href={handoffHref(slug, handoff.phase)}
                    className="rounded-sm after:absolute after:inset-0 after:content-['']"
                  >
                    {pad2(handoff.phase)}
                  </a>
                </TD>
                <TD className="text-ink">{handoff.title}</TD>
                <TD>
                  <StateChip state={handoffState(handoff.status)} label={handoff.status} />
                </TD>
                <TD className="font-mono text-xs">{handoff.completed ?? '—'}</TD>
                <TD className="font-mono text-2xs text-ink-faint">
                  {handoff.skillsUsed.join(', ') || '—'}
                </TD>
                <TD className="font-mono text-xs">{Math.round(handoff.bytes / 1024)}K</TD>
                <TD>
                  {indexRows.has(handoff.phase)
                    ? <span className="text-xs text-ink-faint">{indexRows.get(handoff.phase)!.status}</span>
                    : <Chip tone="warn">missing</Chip>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </Card>
  );
}

/** One handoff, rendered whole — it is the baton, so nothing is summarised. */
export function HandoffPanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const { data: handoff, error, isPending } = useHandoff(slug, phase);

  if (error) {
    return <Banner severity="error">{String((error as Error).message ?? error)}</Banner>;
  }

  if (isPending || !handoff) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader className="flex-wrap">
          <div className="min-w-0">
            <CardTitle className="normal-case">
              Phase {handoff.phase} — {handoff.title}
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StateChip state={handoffState(handoff.status)} label={handoff.status} />
              {handoff.completed && <Chip mono>{handoff.completed}</Chip>}
              {handoff.dependsOn.length > 0 && (
                <Chip mono>depends on P{handoff.dependsOn.join(', P')}</Chip>
              )}
              {handoff.blocks.length > 0 && <Chip mono>blocks P{handoff.blocks.join(', P')}</Chip>}
              {handoff.skillsUsed.map((skill) => <Chip key={skill} mono>{skill}</Chip>)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild size="sm">
              <a href={phaseHref(slug, handoff.phase)}>Phase</a>
            </Button>
            <CopyButton text={handoff.body} label="Copy markdown" />
          </div>
        </CardHeader>
        <CardBody>
          <Markdown text={handoff.body} />
        </CardBody>
      </Card>

      {handoff.keyFiles?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Key files</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-0.5">
            {handoff.keyFiles.map((file) => (
              <code key={file} className="font-mono text-xs break-all text-ink-muted">{file}</code>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
