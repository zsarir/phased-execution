/**
 * Cost against the caps — the money question, in the two units it has.
 *
 * **Settled today vs the day cap** is the cap's own arithmetic: it is the
 * figure `nextRung` refuses a rung against (`ladderPerDayUsd`), so it is the
 * one that can stop the autopilot. **Per run against its budget** is where the
 * money is going right now. They are deliberately not interchangeable — the
 * Runs fleet keeps both tiles for the same reason.
 *
 * The 7-day series is drawn as two stacked segments per day because settled
 * spend and ladder spend are governed differently: the first is whatever the
 * runs cost, the second is what recovery cost on top, and a week where the
 * second half grows is a week the console is spending more on repair than on
 * work. One combined bar hides exactly that.
 */

import { BarList } from '@/components/charts';
import { Card, CardBody, CardHeader, CardTitle, Empty, Meter, MoneyAmount, Tile } from '@/components/ui';
import { money } from '@/lib/format';
import { planHref } from '@shared/routes.js';
import type { SpendView } from '@/lib/api';

export function CostVsCapsPanel({ spend, plan }: { spend: SpendView | undefined; plan?: string }) {
  if (!spend) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost against the caps</CardTitle>
        </CardHeader>
        <CardBody>
          <Empty
            title="No spend report"
            body="This console's server predates GET /api/spend, or nothing has cost anything yet."
          />
        </CardBody>
      </Card>
    );
  }

  const today = spend.today;
  // The cap counts BOTH: what the runs settled and what the ladder spent
  // climbing. Reading only the first is what made "$76 of $600" look safe on a
  // day the recovery ladder had spent most of it.
  const spentToday = today.settledUsd + today.ladderUsd;
  const cap = today.capUsd;
  const runs = plan ? spend.runs.filter((run) => run.slug === plan) : spend.runs;
  const seriesTotal = spend.series.reduce((sum, day) => sum + day.settledUsd + day.ladderUsd, 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Settled today" value={money(today.settledUsd)} hint="what the runs cost" />
        <Tile label="Ladder today" value={money(today.ladderUsd)} hint="what recovery cost on top" />
        <Tile
          label="Day cap"
          value={cap == null ? 'none' : money(cap)}
          state={cap != null && spentToday >= cap ? 'state-blocked' : undefined}
          hint={cap == null ? 'set one in Settings ▸ Automation' : `${money(spentToday)} spent`}
        />
        <Tile label="Last 7 days" value={money(seriesTotal)} hint="settled + ladder" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Today against the cap</CardTitle>
          <span className="text-2xs text-ink-faint">the figure a rung is refused against</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {cap == null ? (
            <p className="text-sm text-ink-muted">
              No day cap is set, so nothing refuses a rung on cost. Settings ▸ Automation ▸ the ladder is
              where one goes.
            </p>
          ) : (
            <Meter
              label="Spent today against the day cap"
              value={spentToday}
              max={cap}
              valueText={`${money(spentToday)} of ${money(cap)}`}
              tone="running"
            >
              <span className="text-2xs text-ink-faint">
                {spentToday >= cap
                  ? 'At the cap — the ladder will refuse the next rung until midnight.'
                  : `${money(cap - spentToday)} left today.`}
              </span>
            </Meter>
          )}

          {spend.series.length > 0 && (
            <div className="border-t border-rule pt-3">
              <BarList
                items={spend.series.map((day) => ({
                  name: day.day,
                  value: Math.round((day.settledUsd + day.ladderUsd) * 100) / 100,
                }))}
              />
              <p className="mt-2 text-2xs text-ink-faint">
                Settled plus ladder, per day. A day whose bar is mostly ladder is a day spent on repair.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runs against their budgets</CardTitle>
          {plan && <span className="text-2xs text-ink-faint">{plan} only</span>}
        </CardHeader>
        <CardBody>
          {runs.length ? (
            <ul className="flex min-w-0 flex-col gap-1">
              {runs.map((run) => (
                <li key={run.runId} className="flex min-w-0 items-center gap-2">
                  <a
                    href={planHref(run.slug, 'run')}
                    className="min-w-0 flex-1 truncate text-sm text-ink hover:text-action"
                  >
                    {run.slug}
                  </a>
                  <MoneyAmount usd={run.spentUsd} against={run.budgetUsd} className="text-sm" />
                  <span className="shrink-0 text-2xs text-ink-faint">
                    {run.budgetUsd == null ? 'no budget' : `of ${money(run.budgetUsd)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">
              {plan ? 'No run of this plan has cost anything yet.' : 'No run has cost anything yet.'}
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
