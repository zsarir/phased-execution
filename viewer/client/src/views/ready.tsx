import { usePlans } from '@/lib/queries';
import { Card, Chip, Empty, Skeleton, StateChip } from '@/components/ui';
import { phaseHref, planHref } from '@shared/routes.js';
import { Page } from './_page';

/** A phase entry as `/api/plans` reports it inside `ready`. */
interface ReadyPhase {
  phase?: number;
  n?: number;
  title?: string;
  gated?: boolean;
  size?: string;
}

/**
 * Every phase that could be started right now, across every plan — the queue the
 * whole console exists to keep honest. The richer version (batching advice, boot
 * prompts inline) is Phase 5.
 */
export default function ReadyView() {
  const { data: plans, isPending } = usePlans();

  if (isPending) {
    return (
      <Page title="Ready now">
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </Page>
    );
  }

  const rows = (plans ?? []).flatMap((plan) =>
    ((plan.ready ?? []) as ReadyPhase[]).map((entry) => ({ plan, entry })),
  );

  if (!rows.length) {
    return (
      <Page title="Ready now">
        <Empty
          title="Nothing is ready"
          body="Every phase is done, in progress, or waiting on a dependency that has not finished."
        />
      </Page>
    );
  }

  return (
    <Page title="Ready now" subtitle={`${rows.length} ${rows.length === 1 ? 'phase' : 'phases'} could start`}>
      <div className="flex flex-col gap-2">
        {rows.map(({ plan, entry }) => {
          const n = entry.phase ?? entry.n;
          return (
            <Card key={`${plan.slug}#${n}`} className="transition-colors hover:border-rule-strong">
              <a
                href={n == null ? planHref(plan.slug) : phaseHref(plan.slug, n)}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate">
                    <span className="font-mono text-2xs text-ink-faint">{plan.slug}</span>
                    {n != null && <span className="ml-2 font-display text-lg">Phase {n}</span>}
                  </div>
                  {entry.title && <div className="truncate text-sm text-ink-muted">{entry.title}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {entry.size && <Chip mono>{entry.size}</Chip>}
                  {entry.gated
                    ? <StateChip state="gated" label="gated" />
                    : <StateChip state="ready" />}
                </div>
              </a>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
