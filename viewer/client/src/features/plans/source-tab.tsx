/**
 * The plan file — read two ways, in one tab.
 *
 * 3.0 folded `overview` and `raw` together. They were never two subjects: one
 * rendered the file's prose and its machine-read graph table, the other printed
 * the same file byte for byte, and a person who wanted to check what the engine
 * would parse had to try both tabs to find out which one showed it. One tab,
 * one switch.
 *
 * **`?view=raw` is why the switch is in the address.** `#/plan/x/raw` is in
 * bookmarks and in handoff prose; redirecting it to a tab that opens on the
 * prose would keep the link working and lose what it meant. The parameter is
 * the same device `?focus=` uses for Now's bands — deep-linkable, reloadable,
 * and composable with the overlays.
 */

import {
  Banner,
  Button,
  ButtonGroup,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  CopyButton,
  Empty,
  Skeleton,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { usePlanRaw } from '@/lib/queries';
import { countdown, pad2 } from '@/lib/format';
import { navigate, phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';
import { DepsCell, LockCell } from './phase-cells';

export type SourceView = 'reading' | 'raw';

/** Which reading this address asks for. Anything unknown is the prose one. */
export const sourceViewOf = (value: string | undefined): SourceView => (value === 'raw' ? 'raw' : 'reading');

export function SourceTab({ detail, view, slug }: { detail: PlanDetail; view: SourceView; slug: string }) {
  const switcher = (
    <ButtonGroup>
      <Button
        size="sm"
        aria-pressed={view === 'reading'}
        // Replaced, not pushed: flipping the switch is not a place you go, and
        // three flips should not be three presses of Back.
        onClick={() => navigate(`plan/${encodeURIComponent(slug)}/source`, { replace: true })}
      >
        Reading
      </Button>
      <Button
        size="sm"
        aria-pressed={view === 'raw'}
        onClick={() => navigate(`plan/${encodeURIComponent(slug)}/source?view=raw`, { replace: true })}
      >
        Markdown
      </Button>
    </ButtonGroup>
  );

  return view === 'raw' ? (
    <RawSource slug={slug} switcher={switcher} />
  ) : (
    <Reading detail={detail} switcher={switcher} />
  );
}

/* ---------------- the bytes ---------------- */

/** The plan file exactly as it is on disk — the thing every reading is a reading of. */
function RawSource({ slug, switcher }: { slug: string; switcher: React.ReactNode }) {
  const { data, error, isPending } = usePlanRaw(slug);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm normal-case">docs/plans/{slug}.md</CardTitle>
        <div className="flex items-center gap-2">
          {data != null && <CopyButton text={data} label="Copy markdown" />}
          {switcher}
        </div>
      </CardHeader>
      {error ? (
        <CardBody>
          <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
        </CardBody>
      ) : isPending || data == null ? (
        <CardBody>
          <Skeleton className="h-96" />
        </CardBody>
      ) : (
        <pre className="m-0 max-h-[70vh] overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {data}
        </pre>
      )}
    </Card>
  );
}

/* ---------------- the prose ---------------- */

/** The plan file's own words, its machine-read graph, its budget and its memory. */
function Reading({ detail, switcher }: { detail: PlanDetail; switcher: React.ReactNode }) {
  const plan = detail.plan;

  if (!plan) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">{switcher}</div>
        <Empty title="No plan file" body="This slug has handoffs but no plan in docs/plans." />
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-end lg:hidden">{switcher}</div>

        {plan.provenance && (
          <Card>
            <CardBody>
              <Markdown text={`> ${plan.provenance.replace(/\n/g, '\n> ')}`} />
            </CardBody>
          </Card>
        )}

        {plan.context && (
          <Card>
            <CardHeader>
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.context} />
            </CardBody>
          </Card>
        )}

        {plan.architecture && (
          <Card>
            <CardHeader>
              <CardTitle>Architecture</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.architecture} />
            </CardBody>
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
                      <TD className="text-ink">
                        <MarkdownInline text={row.title} />
                      </TD>
                      <TD>
                        {view ? (
                          <DepsCell slug={plan.slug} phase={view} />
                        ) : (
                          <span className="font-mono text-xs">{row.dependsOn.join(', ') || '—'}</span>
                        )}
                      </TD>
                      <TD>
                        <LockCell lock={view?.lock} />
                      </TD>
                      <TD className="font-mono text-xs">{row.parallelSafe || '—'}</TD>
                      <TD className="font-mono text-xs">{row.repos || '—'}</TD>
                      <TD className="text-xs">
                        <MarkdownInline text={row.exitCriteria} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
          {plan.callouts.length > 0 && (
            <CardBody className="border-t border-rule">
              {plan.callouts.map((line, i) => (
                <Markdown key={i} text={line} />
              ))}
            </CardBody>
          )}
        </Card>

        {plan.endToEnd && (
          <Card>
            <CardHeader>
              <CardTitle>End-to-end verification</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.endToEnd} />
            </CardBody>
          </Card>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="hidden justify-end lg:flex">{switcher}</div>

        <Card>
          <CardHeader>
            <CardTitle>Session budget</CardTitle>
          </CardHeader>
          <CardBody>
            <Markdown text={plan.sessionBudget.raw} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            {detail.memory && (
              <span className="font-mono text-2xs break-all text-ink-faint">{detail.memory.key}</span>
            )}
          </CardHeader>
          <CardBody className={detail.memory ? 'max-h-[32rem] overflow-auto overscroll-contain' : ''}>
            {detail.memory ? (
              <Markdown text={detail.memory.text} />
            ) : (
              <p className="text-sm text-ink-faint">
                No <code className="font-mono">{detail.summary.slug}</code> memory entry found in the Claude
                memory directories.
              </p>
            )}
          </CardBody>
        </Card>

        {detail.locks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Locks</CardTitle>
            </CardHeader>
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
