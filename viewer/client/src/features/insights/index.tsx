/**
 * Insights — the destination.
 *
 * 2.x `#/stats` was one scroll of thirteen cards titled *Statistics*, and the
 * plan page had a seventh tab called *Analysis* that computed some of the same
 * numbers again for one plan. 3.0 makes them one surface with a scope: bare
 * `#/insights` is the portfolio, `#/insights?plan=<slug>` is one plan, and the
 * retired `#/plan/:slug/analysis` redirects here carrying its slug (see
 * `LEGACY_PLAN_TABS`).
 *
 * Five panels, each answering a different question and none repeating another:
 *
 *   **How long is left** (`eta`)          — the estimate and the basis under it
 *   **What it costs** (`cost-vs-caps`)    — settled today against the day cap
 *   **How fast** (`velocity`)             — the trend and its texture
 *   **What shape** (`portfolio`)          — states, sizes, locks, health
 *   **On what** (`model`)                 — repos, skills, target models
 *
 * The order is deliberate: the two questions an operator actually arrives with
 * are *when will this be done* and *what is it costing*, and both used to be
 * below the fold under three charts.
 *
 * The plan scope is honest about what it can narrow. `/api/stats` is a
 * portfolio aggregate with no per-plan breakdown, so a scoped view shows what
 * genuinely IS plan-scoped — the plan's own ETA, its runs' spend, its QA
 * reports, its locks and its issues — and says so, rather than re-labelling
 * portfolio-wide charts with a plan's name.
 */

import { useMemo } from 'react';
import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import { Page } from '@/components/page';
import { Banner, Card, CardBody, CardHeader, CardTitle, Chip, Empty, Skeleton } from '@/components/ui';
import { plural } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { planHref, handoffHref } from '@shared/routes.js';
import { useConsoleState, usePlan, usePlans, useSpend, useStats } from '@/lib/queries';
import { PortfolioPanel } from './portfolio';
import { VelocityPanel } from './velocity';
import { CostVsCapsPanel } from './cost-vs-caps';
import { EtaPanel } from './eta';
import { MixPanel } from './model';

export default function InsightsView({ route }: ViewProps) {
  const plan = route.query.plan || undefined;
  const { data: stats, isPending, error } = useStats();
  const { data: state } = useConsoleState();
  const { data: spend } = useSpend();
  const { data: plans } = usePlans();
  const { data: detail } = usePlan(plan);
  const allowWrites = Boolean(state?.allowWrites);

  // Which slugs are closed, so an issue row can say so and can stop offering a
  // repair the server would refuse anyway (`plan-repair` 409s on a closed
  // plan). `/api/plans` rather than a new wire field: every other page has
  // already fetched it, so this is a cache read.
  const closedSlugs = useMemo(
    () => new Set((plans ?? []).filter((p) => isClosed(p)).map((p) => p.slug)),
    [plans],
  );

  if (error) {
    return (
      <Page title="Insights">
        <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
      </Page>
    );
  }

  if (isPending || !stats) {
    return (
      <Page title="Insights" subtitle="Reading every plan">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </Page>
    );
  }

  const t = stats.totals;
  const generated = new Date(stats.generatedAt).toISOString().slice(0, 16).replace('T', ' ');

  return (
    <Page
      title="Insights"
      subtitle={`${plan ? plan : 'Portfolio'} · ${generated}`}
      actions={
        <>
          <label htmlFor="insights-plan" className="sr-only">
            Scope to a plan
          </label>
          <select
            id="insights-plan"
            value={plan ?? ''}
            onChange={(event) =>
              navigate(
                event.target.value ? `insights?plan=${encodeURIComponent(event.target.value)}` : 'insights',
              )
            }
            className="min-h-(--tap-min) w-full max-w-56 min-w-0 rounded border border-rule bg-ground px-2 text-sm text-ink"
          >
            <option value="">Every plan</option>
            {(plans ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
          </select>
          <Chip mono>{plural(t.plans, 'plan')}</Chip>
          {t.orphans > 0 && (
            <Chip mono tone="warn">
              {plural(t.orphans, 'orphan folder')}
            </Chip>
          )}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Section title="How long is left">
          <EtaPanel
            stats={stats}
            mediumWeight={state?.sizing?.M}
            plan={plan}
            planEta={plan ? (detail?.eta?.plan ?? null) : undefined}
          />
        </Section>

        <Section title="What it costs">
          <CostVsCapsPanel spend={spend} plan={plan} />
        </Section>

        {plan ? (
          <Section title="This plan’s record">
            <PlanRecord slug={plan} qa={detail?.qa ?? []} />
          </Section>
        ) : null}

        <Section title="How fast">
          <VelocityPanel stats={stats} />
        </Section>

        <Section title="What shape the work is in">
          {plan && (
            <p className="mb-3 text-2xs text-ink-faint">
              Portfolio-wide. <code>/api/stats</code> aggregates across every plan and does not break these
              down per plan —{' '}
              <a href={planHref(plan, 'phases')} className="text-action underline">
                {plan}&rsquo;s own phases
              </a>{' '}
              are on its plan page.
            </p>
          )}
          <PortfolioPanel stats={stats} allowWrites={allowWrites} closedSlugs={closedSlugs} />
        </Section>

        <Section title="On what">
          <MixPanel stats={stats} />
        </Section>
      </div>
    </Page>
  );
}

/**
 * A titled band. `<h2>` because the page's `<h1>` is *Insights* — a screen
 * reader walking headings then gets the five questions as the outline.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `insights-${title.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="mb-3 font-display text-xl leading-none text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The plan-scoped record — where the QA reports finally have a home.
 *
 * Phase 9 retired the Analysis tab and found these homeless: `PlanDetail.qa`
 * carries a report PATH per phase and no surface rendered it, so a verdict an
 * operator could act on was a file only somebody who already knew the
 * convention could find. Every row links to the phase; a row with a report
 * links to the file too.
 */
function PlanRecord({
  slug,
  qa,
}: {
  slug: string;
  qa: { phase: number; result: string; report?: string }[];
}) {
  const TONE: Record<string, 'ok' | 'bad' | 'neutral'> = { pass: 'ok', fail: 'bad', waived: 'neutral' };
  return (
    <Card>
      <CardHeader>
        <CardTitle>QA verdicts</CardTitle>
        <span className="text-2xs text-ink-faint">from test-status.md</span>
      </CardHeader>
      <CardBody>
        {qa.length ? (
          <ul className="flex min-w-0 flex-col gap-1">
            {qa.map((row) => (
              <li key={row.phase} className="flex flex-wrap items-baseline gap-2">
                <a
                  href={handoffHref(slug, row.phase)}
                  className="shrink-0 font-mono text-2xs text-ink hover:text-action"
                >
                  P{row.phase}
                </a>
                <Chip tone={TONE[row.result] ?? 'neutral'}>{row.result}</Chip>
                {row.report ? (
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint"
                    title={row.report}
                  >
                    {row.report}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 text-2xs text-ink-faint">no report file</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title="QA is off for this plan"
            body="QA subagents are opt-in. Nothing here means nothing was asked for — not that anything failed."
          />
        )}
      </CardBody>
    </Card>
  );
}
