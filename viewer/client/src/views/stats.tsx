/**
 * Portfolio statistics: what exists, what is moving, and what is wrong.
 *
 * Ported from `web/views/stats.js`. The charts are restyled rather than
 * redesigned (see `components/charts.tsx`); what changed here is that every
 * navigable thing is a link. The old view rendered plan references and issue
 * rows as `<button onClick=navigate>`, so a page whose entire purpose is "which
 * of these should I look at next" could not be opened in a second tab.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useConsoleState, useSessions, useStats } from '@/lib/queries';
import { countdown, plural, weight } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import {
  Banner, Button, ButtonGroup, Card, CardBody, CardHeader, CardTitle, Chip, Empty, Skeleton, Tile,
} from '@/components/ui';
import { BarList, Bars, Calendar, StackBar, type ChartTone } from '@/components/charts';
import { ReleaseAllStaleButton, ReleaseStaleButton } from '@/components/release-lock';
import { classifyIssue, liveRecovery } from '@/lib/recovery';
import { startRecovery } from '@/lib/start-recovery';
import type { HealthIssue, Portfolio, TerminalSession } from '@/lib/api';
import { Page } from './_page';

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** An issue's severity, as a chip tone. Never amber — amber means actionable. */
const SEVERITY_TONE = { error: 'bad', warning: 'warn', info: 'neutral' } as const;

/** Phase sizes, in the order the engine declares them. */
const SIZE_TONE: ChartTone[] = ['done', 'progress', 'gated'];

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
export function recentRate(
  rate: Portfolio['rate'],
  mediumWeight = 40_000,
): string {
  if (!rate || rate.basis === 'heuristic' || !(rate.ratePerWeight > 0)) return '';
  const minutes = Math.round((rate.ratePerWeight * mediumWeight) / 60_000);
  if (!minutes) return '';
  return ` · recent rate ≈ ${minutes} min per M phase`;
}

export default function StatsView() {
  const { data: stats, isPending, error } = useStats();
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);
  const [severity, setSeverity] = useState<Severity>('all');
  const allowWrites = Boolean(state?.allowWrites);
  const allowAgent = Boolean(state?.allowAgent);
  const expiredLocks = (stats?.activeLocks ?? []).filter((lock) => lock.expired).length;

  const counts = useMemo(() => {
    const out = { error: 0, warning: 0, info: 0 };
    for (const issue of stats?.issues ?? []) out[issue.severity]++;
    return out;
  }, [stats]);

  const issues = useMemo(() => {
    if (!stats) return [];
    return [...stats.issues]
      .filter((issue) => severity === 'all' || issue.severity === severity)
      .sort((a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
        || a.slug.localeCompare(b.slug));
  }, [stats, severity]);

  if (error) {
    return (
      <Page title="Statistics">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  if (isPending || !stats) {
    return (
      <Page title="Statistics" subtitle="Reading every plan">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      </Page>
    );
  }

  const t = stats.totals;
  const generated = new Date(stats.generatedAt).toISOString().slice(0, 16).replace('T', ' ');

  return (
    <Page
      title="Statistics"
      subtitle={`Portfolio · ${generated}`}
      actions={
        <>
          <Chip mono>{plural(t.plans, 'plan')}</Chip>
          <Chip mono>{plural(t.documents, 'document')}</Chip>
          {t.orphans > 0 && <Chip mono tone="warn">{plural(t.orphans, 'orphan folder')}</Chip>}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Phases" value={t.phases} hint={`${t.done} done · ${t.percent}% of everything`} />
        <Tile
          label="Ready now"
          value={t.ready}
          state={t.ready > 0 ? 'state-ready' : undefined}
          hint={`${t.inProgress} in flight · ${t.waiting} waiting`}
        />
        {/* The page counted phases and never said how long one takes, which is
            the quantity every other figure on it is implicitly about. Stated per
            M phase because M is the unit the sizing constants are anchored on —
            "40K of weight" is the same number and means nothing out loud. */}
        <Tile
          label="Work left"
          value={weight(t.remainingWeight)}
          hint={`≈ ${plural(t.remainingSessions, 'session')} across open plans${recentRate(stats.rate, state?.sizing?.M)}`}
        />
        <Tile
          label="Errors"
          value={counts.error}
          state={counts.error > 0 ? 'state-blocked' : undefined}
          hint={`${plural(counts.warning, 'warning')} · ${plural(counts.info, 'note')}`}
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Velocity</CardTitle>
            <span className="text-2xs text-ink-faint">phases completed per week · 26 weeks</span>
          </CardHeader>
          <CardBody>
            <Bars data={stats.velocity} label="phases" />
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-2xs text-ink-faint">
              <span className="font-mono">{stats.velocity[0]?.week}</span>
              <span>
                median gap between phases{' '}
                {stats.medianCycleDays == null ? '—'
                  : stats.medianCycleDays === 0 ? 'same day'
                    : `${stats.medianCycleDays}d`}
              </span>
              <span className="font-mono">{stats.velocity.at(-1)?.week}</span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Completions by day</CardTitle></CardHeader>
          <CardBody><Calendar data={stats.calendar} /></CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Phase states</CardTitle></CardHeader>
          <CardBody>
            <StackBar
              segments={[
                { label: 'done', value: t.done, tone: 'done' },
                { label: 'in progress', value: t.inProgress, tone: 'progress' },
                { label: 'ready', value: t.ready, tone: 'ready' },
                { label: 'blocked', value: t.stuck, tone: 'blocked' },
                { label: 'waiting', value: t.waiting, tone: 'waiting' },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Plan status</CardTitle></CardHeader>
          <CardBody>
            <BarList items={stats.byStatus.map((row) => ({ name: row.status, value: row.count }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Phase sizes</CardTitle></CardHeader>
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

      <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Repos touched</CardTitle></CardHeader>
          <CardBody>
            <BarList items={stats.repos.map((row) => ({ name: row.repo, value: row.count }))} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Skills used</CardTitle></CardHeader>
          <CardBody>
            {stats.skills.length
              ? <BarList items={stats.skills.map((row) => ({ name: row.skill, value: row.count }))} />
              : <span className="text-sm text-ink-faint">No handoff records a skill yet.</span>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Target models</CardTitle></CardHeader>
          <CardBody>
            <BarList items={stats.models.map((row) => ({ name: row.model, value: row.count }))} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
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
                      {lock.expired
                        ? <Chip tone="bad">expired</Chip>
                        : <Chip tone="busy">{countdown(lock.leaseUntil)}</Chip>}
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
                      {plural(expiredLocks, 'lease')} ran out — the phases read as taken and nobody is in them.
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
            {([
              ['all', `All ${stats.issues.length}`],
              ['error', `Errors ${counts.error}`],
              ['warning', `Warnings ${counts.warning}`],
              ['info', `Info ${counts.info}`],
            ] as [Severity, string][]).map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                aria-pressed={severity === id}
                onClick={() => setSeverity(id)}
              >
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
                  <Chip tone={SEVERITY_TONE[issue.severity]}>{issue.kind}</Chip>
                  <a
                    href={issue.phase ? phaseHref(issue.slug, issue.phase) : planHref(issue.slug)}
                    className="font-mono text-2xs text-ink hover:text-action"
                  >
                    {issue.slug}{issue.phase ? ` P${issue.phase}` : ''}
                  </a>
                  <span className="min-w-0 flex-1 text-sm text-ink-muted">{issue.message}</span>
                  {/* Per ROW, not per card: this list mixes plans, and a repair
                      session works on one. The row is the only place that knows
                      which plan the operator meant. */}
                  <RepairIssue issue={issue} allowAgent={allowAgent} sessions={terminals?.sessions} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="Nothing flagged"
              body={severity === 'all'
                ? 'Plans, handoffs, indexes and locks all agree.'
                : `No ${severity}-level issues. Other severities may still have some.`}
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
    </Page>
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
function RepairIssue({
  issue,
  allowAgent,
  sessions,
}: {
  issue: HealthIssue;
  allowAgent: boolean;
  sessions?: readonly TerminalSession[];
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const kind = classifyIssue(issue);
  if (!kind) return null;

  const target = { slug: issue.slug, ...(issue.phase != null ? { phase: issue.phase } : {}) };
  const running = liveRecovery(sessions, target);
  if (running) {
    return (
      <Button size="sm" variant="default" asChild>
        <a href={`#/agent/${running.id}`}><Bot size={12} aria-hidden /> Repair running</a>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      disabled={!allowAgent || busy}
      title={allowAgent
        ? 'Opens a Claude session that repairs this until validate.sh passes.'
        : 'Agent sessions are disabled. Restart the console with --allow-agent.'}
      onClick={() => {
        setBusy(true);
        void startRecovery(client, { recoveryClass: kind, ...target })
          .finally(() => { setBusy(false); });
      }}
    >
      <Bot size={12} aria-hidden /> {busy ? 'Starting…' : 'Repair with AI'}
    </Button>
  );
}
