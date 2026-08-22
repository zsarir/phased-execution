/**
 * The mix — which repositories the work touches, which skills it uses, and
 * which models it is sized for.
 *
 * Three bar lists rather than three numbers, because every one of them is a
 * distribution whose SHAPE is the fact: "9 repos" says nothing, "two thirds of
 * every phase is in one repo" says that concurrency is not available here (the
 * scoped-concurrency rule — same repo ⇒ serialized). Skills and models read the
 * same way: a plan whose phases name no skill is one nobody has told what to
 * use, and a portfolio spread over four models is four different session
 * budgets.
 *
 * Each list is a handoff/plan field, so a missing one is a documentation gap
 * rather than a zero — the empty states say which.
 */

import { BarList } from '@/components/charts';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import type { Portfolio } from '@/lib/api';

export function MixPanel({ stats }: { stats: Portfolio }) {
  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Repos touched</CardTitle>
          <span className="text-2xs text-ink-faint">phases, by scope</span>
        </CardHeader>
        <CardBody>
          {stats.repos.length ? (
            <BarList items={stats.repos.map((row) => ({ name: row.repo, value: row.count }))} />
          ) : (
            <p className="text-sm text-ink-faint">
              No plan declares a Repos column. Every phase then reads as <code>all</code> and runs alone.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skills used</CardTitle>
          <span className="text-2xs text-ink-faint">from handoff frontmatter</span>
        </CardHeader>
        <CardBody>
          {stats.skills.length ? (
            <BarList items={stats.skills.map((row) => ({ name: row.skill, value: row.count }))} />
          ) : (
            <p className="text-sm text-ink-faint">No handoff records a skill yet.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Target models</CardTitle>
          <span className="text-2xs text-ink-faint">what each plan is sized for</span>
        </CardHeader>
        <CardBody>
          {stats.models.length ? (
            <BarList items={stats.models.map((row) => ({ name: row.model, value: row.count }))} />
          ) : (
            <p className="text-sm text-ink-faint">
              No plan names a target model in its <code>## Session budget</code>.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
