import {
  Card, CardBody, CardHeader, CardTitle, Chip, StateChip,
  Table, TableWrap, TBody, TD, TH, THead, TR,
} from '@/components/ui';
import { RouteMap } from '@/components/dag';
import { MarkdownInline, plainText } from '@/components/markdown';
import { PromptCard } from '@/components/prompt-card';
import { RouteCards } from './route-cards';
import { api } from '@/lib/api';
import { boardStateTitle } from '@/lib/status-vocab';
import { keys } from '@/lib/queries';
import { pad2, weight } from '@/lib/format';
import { navigate, phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';

/**
 * The departures board.
 *
 * Every row is a link. The old client made the whole `<tr>` clickable with an
 * `onClick` and no tabindex, so the board was navigable with a mouse and with
 * nothing else — no keyboard, no screen reader, no open-in-new-tab. The phase
 * number is the real anchor and its `::after` covers the row, which keeps one
 * focusable element per row instead of six.
 */
function DeparturesBoard({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departures</CardTitle>
        <span className="text-xs text-ink-faint">
          {detail.phases.length} phases · open a row for the full phase
        </span>
      </CardHeader>
      <TableWrap className="rounded-none border-0 border-t border-rule">
        <Table>
          <THead>
            <TR>
              <TH className="w-14">#</TH>
              <TH>Phase</TH>
              <TH className="w-24">Status</TH>
              <TH className="w-14">Size</TH>
              <TH className="w-36">Repos</TH>
              <TH className="w-48">Notes</TH>
            </TR>
          </THead>
          <TBody>
            {detail.phases.map((phase) => (
              <TR
                key={phase.phase}
                className={phase.state === 'ready' ? 'relative state-ready' : 'relative'}
              >
                <TD className="font-mono text-lg text-ink-faint">
                  <a
                    href={phaseHref(slug, phase.phase)}
                    className="rounded-sm after:absolute after:inset-0 after:content-['']"
                  >
                    {pad2(phase.phase)}
                  </a>
                </TD>
                <TD>
                  <div className="font-medium text-ink">
                    <MarkdownInline text={phase.title} />
                  </div>
                  {phase.state === 'waiting' && phase.analysis?.dependsOn.length ? (
                    <div className="text-2xs text-ink-faint">
                      needs {phase.analysis.dependsOn.map((d) => `P${d}`).join(' · ')}
                    </div>
                  ) : phase.goal ? (
                    <div className="line-clamp-2 max-w-[46ch] text-2xs text-ink-faint">
                      {plainText(phase.goal)}
                    </div>
                  ) : null}
                </TD>
                <TD><StateChip state={phase.state} board /></TD>
                <TD><Chip mono>{phase.size}</Chip></TD>
                <TD className="font-mono text-2xs text-ink-faint">{phase.row?.repos ?? '—'}</TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {phase.gated && <Chip tone="gate" title={boardStateTitle('gated')}>gated</Chip>}
                    {phase.lock && !phase.lock.expired && (
                      <Chip tone="busy" title={phase.lock.owner}>locked</Chip>
                    )}
                    {phase.lock?.expired && (
                      <Chip tone="warn" title={phase.lock.owner}>stale lock</Chip>
                    )}
                    {phase.qa && phase.qa.result !== 'waived' && (
                      <Chip tone={phase.qa.result === 'fail' ? 'bad' : 'neutral'}>
                        QA {phase.qa.result}
                      </Chip>
                    )}
                    {phase.analysis?.onCriticalPath && (
                      <Chip title="On the longest remaining chain">critical</Chip>
                    )}
                    {phase.handoff && (
                      <Chip title={`Handoff: ${phase.handoff.status}`}>handoff</Chip>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </Card>
  );
}

export function RouteTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const ready = detail.summary.ready;
  const doneNumbers = detail.phases.filter((p) => p.state === 'done').map((p) => p.phase);
  const lastDone = doneNumbers.length ? Math.max(...doneNumbers) : null;

  return (
    <div className="flex flex-col gap-3">
      <RouteCards detail={detail} />

      <RouteMap
        route={detail.route}
        batches={detail.batches}
        budget={detail.summary.budget}
        onSelect={(phase) => navigate(phaseHref(slug, phase))}
      />

      {detail.batches?.groups?.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Suggested sessions</CardTitle>
            <span className="text-xs text-ink-faint">
              from <code className="font-mono">phase-graph.sh --session-plan</code> · budget{' '}
              {weight(detail.summary.budget)}
            </span>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-1.5">
            {detail.batches.groups.map((group) => (
              <Chip key={group.index} title={group.note ?? ''}>
                <b>S{group.index}</b>&nbsp;{group.phases.map((p) => `P${p}`).join(' + ')}
                &nbsp;<span className="text-ink-faint">{group.weight}</span>
                {group.gated ? ' · gated' : ''}
              </Chip>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <DeparturesBoard detail={detail} />

      {ready.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {ready.map((phase) => (
            <PromptCard
              key={phase}
              title={`Boot prompt — phase ${phase}`}
              queryKey={keys.prompt(slug, phase)}
              load={() => api.prompt(slug, phase)}
            />
          ))}
        </div>
      )}

      {lastDone != null && (
        <PromptCard
          title={`End-of-phase banner — after phase ${lastDone}`}
          note="board · batching advice · every ready prompt"
          collapsed
          queryKey={keys.nextPrompt(slug, lastDone)}
          load={() => api.nextPrompt(slug, lastDone)}
        />
      )}
    </div>
  );
}
