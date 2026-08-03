import { useConsoleState, usePlans } from '@/lib/queries';
import { Card, CardBody, CardHeader, CardTitle, Empty, Skeleton, StateChip, Tile } from '@/components/ui';
import { planHref } from '@shared/routes.js';
import { Page } from './_page';

/**
 * The board at a glance. Real counts in Phase 2 — the tiles are the second place
 * (after the plan list) that a `changed` event has to reach without a reload.
 * The dashboard's fuller shape is Phase 5.
 */
export default function DashboardView() {
  const { data: state } = useConsoleState();
  const { data: plans, isPending } = usePlans();

  const list = plans ?? [];
  const ready = list.reduce((n, p) => n + (p.ready?.length ?? 0), 0);
  const phases = list.reduce((n, p) => n + (p.phases ?? 0), 0);
  const planCount = list.filter((p) => p.kind === 'plan').length;
  const withReady = list.filter((p) => (p.ready?.length ?? 0) > 0);

  return (
    <Page
      title="Dashboard"
      subtitle={state?.root?.label ? `Source — ${state.root.label}` : undefined}
    >
      {isPending ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile label="Ready now" value={ready} state={ready > 0 ? 'state-ready' : undefined} />
          <Tile label="Plans" value={planCount} />
          <Tile label="Phases" value={phases} />
          <Tile label="Documents" value={list.length - planCount} />
        </div>
      )}

      <Card className="mt-4">
        <CardHeader><CardTitle>Ready to start</CardTitle></CardHeader>
        <CardBody className="p-0">
          {withReady.length === 0 ? (
            <Empty
              title="Nothing is ready"
              body="Every phase is done, in progress, or waiting on a dependency."
            />
          ) : (
            <ul className="divide-y divide-rule">
              {withReady.map((plan) => (
                <li key={plan.slug}>
                  <a
                    href={planHref(plan.slug)}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-raised"
                  >
                    <span className="min-w-0 truncate">{plan.title ?? plan.slug}</span>
                    {/* Without `shrink-0` the chip is a shrinkable flex item, and
                        its own `whitespace-nowrap` then overflows the box it was
                        squeezed into — the label reads as clipped, not wrapped. */}
                    <StateChip state="ready" label={`${plan.ready.length} ready`} className="shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </Page>
  );
}
