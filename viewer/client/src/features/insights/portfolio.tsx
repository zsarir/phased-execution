/**
 * The portfolio panel — what exists, and what is wrong with it.
 *
 * The census half of Insights: how the phases are distributed across states and
 * sizes, which plans are busiest, what is claimed, what the engine flagged, and
 * what has ready work nobody has touched. Ported from `views/stats.tsx` (2.x
 * `#/stats`), which was ALL of Insights in one scroll; the trend, money, ETA
 * and mix halves are now their own panels, so this one answers only "what is
 * the shape of the work, and is any of it broken".
 *
 * Every navigable thing is a link. The 2.x view rendered plan references and
 * issue rows as `<button onClick=navigate>`, so a page whose entire purpose is
 * "which of these should I look at next" could not be opened in a second tab.
 */

import { useMemo, useState } from 'react';
import { plural } from '@/lib/format';
import { countdown } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import { Button, ButtonGroup, Card, CardBody, CardHeader, CardTitle, Chip, Empty } from '@/components/ui';
import { BarList, StackBar, type ChartTone } from '@/components/charts';
import { ReleaseAllStaleButton, ReleaseStaleButton } from '@/components/release-lock';
import { classifyIssue } from '@/lib/recovery';
import type { HealthIssue, Portfolio } from '@/lib/api';
import { RecoveryActions } from '@/components/recovery-actions';

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** An issue's severity, as a chip tone. Never amber — amber means actionable. */
const SEVERITY_TONE = { error: 'bad', warning: 'warn', info: 'neutral' } as const;

/** Phase sizes, in the order the engine declares them. */
const SIZE_TONE: ChartTone[] = ['done', 'running', 'waiting'];

type Severity = 'all' | HealthIssue['severity'];

/**
 * How fast a phase has actually been going, in the only unit anyone says aloud.
 *
 * A rate in milliseconds per unit of weight is the right thing to store and an
 * unreadable thing to print, so it is multiplied back up by an M phase's weight
 * — the size the sizing constants are anchored on. Empty string rather than a
 * placeholder when there is no evidence: this rides on the end of a hint that
 * already says something, and `· unknown` is worse than silence.
 */
export function recentRate(rate: Portfolio['rate'], mediumWeight = 40_000): string {
  if (!rate || rate.basis === 'heuristic' || !(rate.ratePerWeight > 0)) return '';
  const minutes = Math.round((rate.ratePerWeight * mediumWeight) / 60_000);
  if (!minutes) return '';
  return ` · recent rate ≈ ${minutes} min per M phase`;
}

export function PortfolioPanel({
  stats,
  allowWrites,
  closedSlugs,
}: {
  stats: Portfolio;
  allowWrites: boolean;
  closedSlugs: ReadonlySet<string>;
}) {
  const [severity, setSeverity] = useState<Severity>('all');
  // Debris does not count. A lapsed lease on a closed plan blocks nothing —
  // `phase-lock.sh conflicts` skips it — so folding it into this number would
  // put an amber "N leases ran out" band and a Release-all button in front of
  // the operator for a chore that does not exist.
  const expiredLocks = stats.activeLocks.filter((lock) => lock.expired && !lock.closed).length;

  const counts = useMemo(() => {
    const out = { error: 0, warning: 0, info: 0 };
    for (const issue of stats.issues) out[issue.severity]++;
    return out;
  }, [stats]);

  const issues = useMemo(
    () =>
      [...stats.issues]
        .filter((issue) => severity === 'all' || issue.severity === severity)
        .sort(
          (a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
            a.slug.localeCompare(b.slug),
        ),
    [stats, severity],
  );

  const t = stats.totals;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Phase states</CardTitle>
          </CardHeader>
          <CardBody>
            <StackBar
              segments={[
                { label: 'done', value: t.done, tone: 'done' },
                { label: 'running', value: t.inProgress, tone: 'running' },
                { label: 'next up', value: t.ready, tone: 'queued' },
                { label: 'needs you', value: t.stuck, tone: 'needs-you' },
                { label: 'waiting', value: t.waiting, tone: 'waiting' },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan status</CardTitle>
            {/* The one place the split is worth stating outright. Every other
                number on this page is already gated on it silently, and "23 of
                86 are open" is the sentence that explains why "ready now" is
                so much smaller than "phases". */}
            <span className="text-2xs text-ink-faint">
              {t.plans - t.closed} open · {t.closed} closed
            </span>
          </CardHeader>
          <CardBody>
            <BarList items={stats.byStatus.map((row) => ({ name: row.status, value: row.count }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Phase sizes</CardTitle>
          </CardHeader>
          <CardBody>
            <StackBar
              segments={stats.sizeMix.map((row, i) => ({
                label: row.size,
                value: row.count,
                tone: SIZE_TONE[i] ?? 'waiting',
              }))}
            />
            <p className="mt-2 text-2xs text-ink-faint">
              S 15K · M 40K · L 90K working-set weight, from the skill&rsquo;s sizing.env
            </p>
          </CardBody>
        </Card>
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Locks</CardTitle>
            <span className="text-2xs text-ink-faint">a claimed phase belongs to one session</span>
          </CardHeader>
          <CardBody>
            {stats.activeLocks.length ? (
              <div className="flex flex-col gap-2">
                <ul className="flex flex-col gap-1">
                  {stats.activeLocks.map((lock) => (
                    <li key={`${lock.slug}-${lock.phase}`} className="flex items-center gap-2">
                      <a
                        href={phaseHref(lock.slug, lock.phase)}
                        className="shrink-0 font-mono text-2xs text-ink hover:text-action"
                      >
                        {lock.slug} P{lock.phase}
                      </a>
                      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
                        {lock.owner}
                      </span>
                      {/* Three readings, not two. A lapsed lease on a CLOSED plan
                          is debris: `phase-lock.sh conflicts` skips it, so it
                          blocks nobody and painting it `bad` would be inventing a
                          chore. Still listed and still releasable — this card is
                          the lock inventory — just not shouted about. */}
                      {lock.closed ? (
                        <Chip title="This plan is closed, so the lock is leftover debris — phase-lock.sh skips it and it blocks no session. Releasing it is tidying, not a fix.">
                          debris
                        </Chip>
                      ) : lock.expired ? (
                        <Chip
                          tone="bad"
                          title="The lease ran out and nobody renewed it — the session is gone. Safe to release (Plans page offers it), and a takeover recovery may claim the phase."
                        >
                          expired
                        </Chip>
                      ) : (
                        <Chip
                          tone="busy"
                          title="A live lease — a session is (or very recently was) working this phase. Never release a live lease."
                        >
                          {countdown(lock.leaseUntil)}
                        </Chip>
                      )}
                      {/* The owner is right there in the row and the server
                          reads it from the file — nobody retypes it. */}
                      {lock.expired && (
                        <ReleaseStaleButton
                          slug={lock.slug}
                          phase={lock.phase}
                          allowWrites={allowWrites}
                          label="Release"
                        />
                      )}
                    </li>
                  ))}
                </ul>
                {expiredLocks > 1 && (
                  <div className="flex items-center gap-2 border-t border-rule pt-2">
                    <span className="flex-1 text-2xs text-ink-faint">
                      {plural(expiredLocks, 'lease')} ran out — the phases read as taken and nobody is in
                      them.
                    </span>
                    <ReleaseAllStaleButton count={expiredLocks} allowWrites={allowWrites} />
                  </div>
                )}
              </div>
            ) : (
              <span className="text-sm text-ink-faint">No phase is claimed.</span>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Busiest plans</CardTitle>
            <span className="text-2xs text-ink-faint">phases completed</span>
          </CardHeader>
          <CardBody>
            <BarList
              items={stats.busiest.map((row) => ({ name: row.slug, value: row.completions }))}
              tone="done"
            />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Health</CardTitle>
          <ButtonGroup>
            {(
              [
                ['all', `All ${stats.issues.length}`],
                ['error', `Errors ${counts.error}`],
                ['warning', `Warnings ${counts.warning}`],
                ['info', `Info ${counts.info}`],
              ] as [Severity, string][]
            ).map(([id, label]) => (
              <Button key={id} size="sm" aria-pressed={severity === id} onClick={() => setSeverity(id)}>
                {label}
              </Button>
            ))}
          </ButtonGroup>
        </CardHeader>
        <CardBody>
          {issues.length ? (
            <ul className="flex flex-col gap-1.5">
              {issues.map((issue, i) => (
                <li key={`${issue.slug}-${issue.kind}-${i}`} className="flex flex-wrap items-baseline gap-2">
                  <Chip tone={SEVERITY_TONE[issue.severity]} title={issue.message}>
                    {issue.kind}
                  </Chip>
                  <a
                    href={issue.phase ? phaseHref(issue.slug, issue.phase) : planHref(issue.slug)}
                    className="font-mono text-2xs text-ink hover:text-action"
                  >
                    {issue.slug}
                    {issue.phase ? ` P${issue.phase}` : ''}
                  </a>
                  {closedSlugs.has(issue.slug) && (
                    <Chip title="This plan is closed. What is left here is structural — the engine kept it and demoted it, so it is a record, not a job.">
                      closed
                    </Chip>
                  )}
                  <span className="min-w-0 flex-1 text-sm text-ink-muted">{issue.message}</span>
                  {/* Per ROW, not per card: this list mixes plans, and a repair
                      session works on one. The row is the only place that knows
                      which plan the operator meant.

                      No closure check here, deliberately. `healthIssues()`
                      demotes every issue on a closed plan to `info`, and
                      `classifyIssue()` offers a repair only for `error` and
                      `warning` — so the severity already is the gate, and it is
                      the same one the server would enforce anyway (`plan-repair`
                      409s on a closed plan). A second check here would be dead
                      code that silently diverges the day the issue kinds move. */}
                  <RepairIssue issue={issue} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="Nothing flagged"
              body={
                severity === 'all'
                  ? 'Plans, handoffs, indexes and locks all agree.'
                  : `No ${severity}-level issues. Other severities may still have some.`
              }
            />
          )}
        </CardBody>
      </Card>

      {stats.stalled.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Stalled plans</CardTitle>
            <span className="text-2xs text-ink-faint">ready work, untouched for a week or more</span>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-1">
              {stats.stalled.map((item) => (
                <li key={item.slug} className="flex flex-wrap items-baseline justify-between gap-2">
                  <a href={planHref(item.slug)} className="font-mono text-2xs text-ink hover:text-action">
                    {item.slug}
                  </a>
                  <span className="text-2xs text-ink-faint">
                    P{item.ready.join(', P')} ready · idle {plural(item.days, 'day')}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/**
 * "Repair with AI", on the row that names the problem.
 *
 * Offered for errors and warnings, not for info: an expired lock or a missing
 * INDEX line has a one-click deterministic remedy elsewhere on this page, and
 * spending a session on it would be the console recommending the expensive
 * option for the cheap problem.
 *
 * Scoped to the issue's own phase when it has one, so a repair session is told
 * about the disagreement in front of it rather than every issue in the plan.
 */
function RepairIssue({ issue }: { issue: HealthIssue }) {
  const kind = classifyIssue(issue);
  if (!kind) return null;
  return (
    <RecoveryActions
      target={{ slug: issue.slug, ...(issue.phase != null ? { phase: issue.phase } : {}) }}
      ctx={{ planIssues: true }}
      max={1}
    />
  );
}
