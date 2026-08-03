import { FileText } from 'lucide-react';
import { useConsoleState, usePlans } from '@/lib/queries';
import { Card, Chip, Empty, Skeleton, StateChip } from '@/components/ui';
import { NewPlanButton } from '@/components/write-menu';
import { planHref } from '@shared/routes.js';
import { Page } from './_page';

/**
 * The plan list.
 *
 * Real data in Phase 2 on purpose: it is the screen the SSE→Query bridge is
 * verified against. Touch a plan file on disk, the server emits `changed`, and
 * this list refetches without a reload — that is exit criterion 2, and a
 * placeholder could not demonstrate it. The plan *detail* surface (tabs, the
 * route map, handoffs, markdown) is Phase 3.
 */
export default function PlansView() {
  const { data: plans, isPending, error } = usePlans();
  const { data: state } = useConsoleState();
  const newPlan = <NewPlanButton allowWrites={Boolean(state?.allowWrites)} />;

  if (error) {
    return (
      <Page title="Plans">
        <Empty title="Could not load plans" body={String((error as Error).message ?? error)} />
      </Page>
    );
  }

  if (isPending) {
    return (
      <Page title="Plans">
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
      </Page>
    );
  }

  const list = plans ?? [];
  if (!list.length) {
    return (
      <Page title="Plans" actions={newPlan}>
        <Empty
          icon={<FileText size={22} />}
          title="No plans here"
          body="This directory has no docs/plans/*.md yet."
          action={newPlan}
        />
      </Page>
    );
  }

  return (
    <Page title="Plans" subtitle={`${list.length} in this source`} actions={newPlan}>
      <div className="flex flex-col gap-2">
        {list.map((plan) => {
          const ready = plan.ready?.length ?? 0;
          const done = typeof plan.done === 'number' ? plan.done : undefined;
          return (
            <Card key={plan.slug} className="transition-colors hover:border-rule-strong">
              <a
                href={planHref(plan.slug)}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate font-display text-lg">{plan.title ?? plan.slug}</div>
                  <div className="truncate font-mono text-2xs text-ink-faint">{plan.slug}</div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {done != null && <Chip mono>{done}/{plan.phases} done</Chip>}
                  {done == null && <Chip mono>{plan.phases} phases</Chip>}
                  {ready > 0
                    ? <StateChip state="ready" label={`${ready} ready`} />
                    : <StateChip state="waiting" label="none ready" />}
                </div>
              </a>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
