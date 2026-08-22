/**
 * How long is left — the estimate, and what it is standing on.
 *
 * An ETA with no basis is a guess wearing a number. Every figure here carries
 * the `EtaBasis` that produced it — `plan` (this plan's own completed phases),
 * `portfolio` (pooled across every plan, used until a plan has evidence of its
 * own) and `heuristic` (the shipped constants, i.e. nobody has finished
 * anything yet) — because the same "≈ 3 days" means three different things
 * depending on which one it is, and only one of them is worth planning around.
 *
 * The server owns the arithmetic (`analysis/stats.ts`). This panel never
 * computes a duration: a client that did would drift from the lane ETAs on Now
 * and the plan ETA on the Route tab, and three surfaces disagreeing about when
 * something finishes is worse than one surface saying it does not know.
 */

import { Card, CardBody, CardHeader, CardTitle, Empty, KeyValue, Tile } from '@/components/ui';
import { plural, weight } from '@/lib/format';
import type { EtaEstimate, Portfolio } from '@/lib/api';
import { recentRate } from './portfolio';

/** What a basis actually claims, in a sentence. */
const BASIS_NOTE: Record<string, string> = {
  plan: 'measured from this plan’s own completed phases.',
  portfolio: 'pooled across every plan — this one has not finished enough phases to speak for itself.',
  heuristic: 'the shipped constants. Nothing has completed yet, so this is a placeholder, not a forecast.',
};

export function EtaPanel({
  stats,
  mediumWeight,
  plan,
  planEta,
}: {
  stats: Portfolio;
  mediumWeight: number | undefined;
  plan?: string;
  planEta?: EtaEstimate | null;
}) {
  const t = stats.totals;
  const rate = stats.rate;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Work left"
          value={weight(t.remainingWeight)}
          hint={`across ${plural(t.plans - t.closed, 'open plan')}`}
        />
        <Tile label="Sessions left" value={t.remainingSessions} hint="at this model’s session budget" />
        <Tile
          label="Ready now"
          value={t.ready}
          state={t.ready > 0 ? 'state-ready' : undefined}
          hint={`${t.inProgress} in flight`}
        />
        <Tile
          label="Median gap"
          value={
            stats.medianCycleDays == null
              ? '—'
              : stats.medianCycleDays === 0
                ? 'same day'
                : `${stats.medianCycleDays}d`
          }
          hint="between one phase and the next"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{plan ? `${plan} — estimate` : 'Portfolio estimate'}</CardTitle>
          <span className="text-2xs text-ink-faint">the server’s arithmetic, never the client’s</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {plan ? (
            planEta ? (
              <KeyValue
                items={[
                  ['Estimate', planEta.label],
                  ['Phases left', `${planEta.remainingPhases} · ${weight(planEta.remainingWeight)}`],
                  ['Basis', `${planEta.basis} — ${BASIS_NOTE[planEta.basis] ?? 'unknown'}`],
                  ['Samples', `${plural(planEta.samples, 'completed phase')} behind the rate`],
                ]}
              />
            ) : (
              <Empty
                title="No estimate for this plan"
                body="Every phase is done, or this console’s server predates the per-plan ETA."
              />
            )
          ) : rate && rate.basis !== 'heuristic' ? (
            <KeyValue
              items={[
                [
                  'Recent rate',
                  `${recentRate(rate, mediumWeight).replace(/^ · recent rate ≈ /, '') || 'unknown'}`,
                ],
                ['Basis', `${rate.basis} — ${BASIS_NOTE[rate.basis] ?? 'unknown'}`],
                ['Samples', `${plural(rate.samples, 'completed phase')}`],
                [
                  'Spread',
                  rate.spread > 0
                    ? `×${rate.spread.toFixed(1)} between the fastest and slowest — the wider this is, the less an average means`
                    : '—',
                ],
              ]}
            />
          ) : (
            <Empty
              title="No measured rate yet"
              body="Estimates fall back to the shipped constants until phases start completing."
            />
          )}
          <p className="text-2xs text-ink-faint">
            A phase&rsquo;s own estimate is on its row; a run&rsquo;s is on the run page; a lane&rsquo;s is on
            Now. All four read the same rate.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
