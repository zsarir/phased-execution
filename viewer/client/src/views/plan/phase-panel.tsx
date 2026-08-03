import type { ReactNode } from 'react';
import {
  Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip, Empty, KeyValue, StateChip,
} from '@/components/ui';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { PromptCard } from '@/components/prompt-card';
import { api } from '@/lib/api';
import { keys, useGateStatus } from '@/lib/queries';
import { countdown, pad2, plural, weight } from '@/lib/format';
import { handoffHref, phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';

/** One labelled block of the plan's own prose. Absent fields render nothing. */
function Field({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <div>
      <h4 className="mb-1 font-display text-2xs uppercase tracking-wider text-ink-faint">{label}</h4>
      <Markdown text={text} />
    </div>
  );
}

/** A phase number as a chip-sized link — used for every dependency edge. */
function PhaseLink({ slug, phase, suffix }: { slug: string; phase: number; suffix?: ReactNode }) {
  return (
    <a
      href={phaseHref(slug, phase)}
      className="inline-flex items-center gap-1.5 rounded-sm border border-rule px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted hover:border-rule-strong hover:text-ink"
    >
      P{phase}{suffix}
    </a>
  );
}

export function PhasePanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const view = detail.phases.find((p) => p.phase === Number(phase));

  // Only asked when the plan declares a machine-checkable gate for this phase —
  // the engine shells out per call, and every other phase would ask for nothing.
  const { data: gate } = useGateStatus(slug, view?.phase, Boolean(view?.gateCheck));

  if (!view) {
    return (
      <Empty
        title={`No phase ${phase} in this plan`}
        body="The plan's graph has no row with that number."
      />
    );
  }

  const stateOf = (n: number) => detail.phases.find((p) => p.phase === n)?.state ?? 'unknown';

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <Card>
          <CardHeader className="flex-wrap">
            <div className="flex min-w-0 items-start gap-3">
              <span className="font-mono text-2xl leading-none text-ink-faint">{pad2(view.phase)}</span>
              <div className="min-w-0">
                <CardTitle className="text-lg normal-case">
                  <MarkdownInline text={view.title} />
                </CardTitle>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StateChip state={view.state} board />
                  <Chip mono>{view.size}</Chip>
                  <Chip mono>{weight(view.weight)}</Chip>
                  {view.model && <Chip mono>{view.model}</Chip>}
                  {view.effort && <Chip mono>effort {view.effort}</Chip>}
                  {view.gated && <Chip tone="gate">gated</Chip>}
                  {view.analysis?.onCriticalPath && <Chip>critical path</Chip>}
                </div>
              </div>
            </div>
            {view.handoff && (
              <Button asChild size="sm">
                <a href={handoffHref(slug, view.phase)}>Handoff</a>
              </Button>
            )}
          </CardHeader>

          <CardBody className="flex flex-col gap-4">
            <Field label="Goal" text={view.goal} />

            {view.gates && (
              <Banner severity="warn">
                <div className="min-w-0">
                  <strong>Gates must clear first.</strong>
                  <Markdown text={view.gates} />
                  {gate && (
                    <div className="mt-1 font-mono text-2xs">
                      gate-check: {gate.kind} — {gate.clear ? 'clear' : 'blocked'} {gate.detail}
                    </div>
                  )}
                </div>
              </Banner>
            )}

            <Field label="Read first" text={view.readFirst} />
            <Field label="Files" text={view.files} />
            <Field label="Steps" text={view.steps} />
            <Field label="Exit criteria" text={view.exitCriteria} />
            <Field label="Verification" text={view.verification} />
            <Field label="Handoff must record" text={view.handoffMustRecord} />

            {!view.goal && !view.exitCriteria && (
              <Banner severity="info">
                This phase has a graph row but no <code className="font-mono">### Phase {view.phase}</code>{' '}
                section in the plan.
              </Banner>
            )}
          </CardBody>
        </Card>

        {(view.state === 'ready' || view.state === 'in-progress') && (
          <PromptCard
            title={`Boot prompt — phase ${view.phase}`}
            queryKey={keys.prompt(slug, view.phase)}
            load={() => api.prompt(slug, view.phase)}
          />
        )}
        {detail.summary.qaMode === 'on' && view.state === 'done' && (
          <PromptCard
            title={`QA brief — phase ${view.phase}`}
            collapsed
            queryKey={keys.qaPrompt(slug, view.phase)}
            load={() => api.qaPrompt(slug, view.phase)}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card>
          <CardHeader><CardTitle>Dependencies</CardTitle></CardHeader>
          <CardBody>
            <KeyValue
              items={[
                ['Depends on', view.analysis?.dependsOn.length
                  ? (
                    <div className="flex flex-wrap gap-1">
                      {view.analysis.dependsOn.map((d) => (
                        <PhaseLink key={d} slug={slug} phase={d} suffix={` · ${stateOf(d)}`} />
                      ))}
                    </div>
                  )
                  : <span className="text-ink-faint">nothing — a root phase</span>],
                ['Unblocks', view.analysis?.dependents.length
                  ? (
                    <div className="flex flex-wrap gap-1">
                      {view.analysis.dependents.map((d) => <PhaseLink key={d} slug={slug} phase={d} />)}
                    </div>
                  )
                  : <span className="text-ink-faint">nothing downstream</span>],
                ['Downstream total', view.analysis?.transitiveDependents.length
                  ? `${plural(view.analysis.transitiveDependents.length, 'phase')} (${view.analysis.unblocks} still open)`
                  : null],
                ['Parallel-safe with',
                  view.row?.parallelSafe && view.row.parallelSafe !== '—' ? view.row.parallelSafe : null],
                ['Repos', view.row?.repos],
                ['Exit criteria (graph)', view.row?.exitCriteria],
              ]}
            />
          </CardBody>
        </Card>

        {view.lock && (
          <Card>
            <CardHeader><CardTitle>Lock</CardTitle></CardHeader>
            <CardBody>
              <KeyValue
                items={[
                  ['Owner', <span className="font-mono break-all">{view.lock.owner}</span>],
                  ['State', view.lock.expired
                    ? 'expired — another session may take it over'
                    : countdown(view.lock.leaseUntil)],
                ]}
              />
            </CardBody>
          </Card>
        )}

        {view.handoff && (
          <Card>
            <CardHeader>
              <CardTitle>Handoff</CardTitle>
              <Button asChild size="sm">
                <a href={handoffHref(slug, view.phase)}>Open</a>
              </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <KeyValue
                items={[
                  ['Status', <StateChip state={handoffState(view.handoff.status)} label={view.handoff.status} />],
                  ['Completed', view.handoff.completed],
                  ['Skills used', view.handoff.skillsUsed.join(', ')],
                  ['Prompts', view.handoff.prompts
                    ? plural(view.handoff.prompts, 'boot prompt')
                    : null],
                ]}
              />
              {view.handoff.outstanding && view.handoff.outstanding.toLowerCase() !== 'none' && (
                <div>
                  <h4 className="mb-1 font-display text-2xs uppercase tracking-wider text-ink-faint">
                    Outstanding
                  </h4>
                  <Markdown text={view.handoff.outstanding} />
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * A handoff's own status vocabulary, mapped onto the phase palette.
 *
 * `complete`/`blocked` are handoff words; `done`/`stuck` are what the map and
 * the chips paint. Keeping the mapping in one exported function is what stops
 * the handoffs table and the phase panel from drifting into two answers.
 */
export function handoffState(status: string): string {
  if (status === 'complete') return 'done';
  if (status === 'blocked') return 'stuck';
  return status;
}
