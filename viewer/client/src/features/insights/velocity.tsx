/**
 * Velocity — how fast phases have actually been landing, and on which days.
 *
 * Two charts that answer one question from two angles: the weekly bars are the
 * trend (is this speeding up or slowing down), the calendar is the texture (is
 * it steady, or four phases on one Saturday and nothing for a fortnight). The
 * median gap between phases sits between them because it is the number that
 * makes both readable — a bar of 5 means something different at a 1-day median
 * than at a 9-day one.
 */

import { Bars, Calendar } from '@/components/charts';
import { Card, CardBody, CardHeader, CardTitle, Empty } from '@/components/ui';
import type { Portfolio } from '@/lib/api';

export function VelocityPanel({ stats }: { stats: Portfolio }) {
  const landed = stats.velocity.reduce((sum, week) => sum + week.count, 0);
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Velocity</CardTitle>
          <span className="text-2xs text-ink-faint">phases completed per week · 26 weeks</span>
        </CardHeader>
        <CardBody>
          {landed ? (
            <>
              <Bars data={stats.velocity} label="phases" />
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-2xs text-ink-faint">
                <span className="font-mono">{stats.velocity[0]?.week}</span>
                <span>
                  median gap between phases{' '}
                  {stats.medianCycleDays == null
                    ? '—'
                    : stats.medianCycleDays === 0
                      ? 'same day'
                      : `${stats.medianCycleDays}d`}
                </span>
                <span className="font-mono">{stats.velocity.at(-1)?.week}</span>
              </div>
            </>
          ) : (
            <Empty
              title="No phase has completed in 26 weeks"
              body="A handoff with status: complete is what puts a bar here."
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Completions by day</CardTitle>
          <span className="text-2xs text-ink-faint">darker is more</span>
        </CardHeader>
        <CardBody>
          <Calendar data={stats.calendar} />
        </CardBody>
      </Card>
    </div>
  );
}
