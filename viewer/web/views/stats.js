/** Portfolio statistics: what exists, what is moving, and what is wrong. */

import { html, useState, useEffect, useMemo } from '../html.js';
import { api } from '../api.js';
import { navigate, planHref, phaseHref } from '../router.js';
import { Bars, Calendar, BarList, StackBar } from '../components/charts.js';
import { Tile, Chip, Spinner, Banner, Empty, weight, relativeTime, countdown } from '../components/ui.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function StatsView() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [severity, setSeverity] = useState('all');

  useEffect(() => {
    let live = true;
    api.stats()
      .then((result) => { if (live) setStats(result); })
      .catch((failure) => { if (live) setError(String(failure.message ?? failure)); });
    return () => { live = false; };
  }, []);

  const issues = useMemo(() => {
    if (!stats) return [];
    return [...stats.issues]
      .filter((issue) => severity === 'all' || issue.severity === severity)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.slug.localeCompare(b.slug));
  }, [stats, severity]);

  if (error) return html`<div class="page"><${Banner} kind="error">${error}</${Banner}></div>`;
  if (!stats) return html`<div class="page"><${Spinner} label="Reading every plan" /></div>`;

  const t = stats.totals;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of stats.issues) counts[issue.severity]++;

  return html`
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Portfolio · ${new Date(stats.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}</div>
          <h1>Statistics</h1>
        </div>
        <div class="row-wrap">
          <span class="chip plain">${t.plans} plans</span>
          <span class="chip plain">${t.documents} documents</span>
          ${t.orphans ? html`<span class="chip plain">${t.orphans} orphan folders</span>` : null}
        </div>
      </div>

      <div class="grid cols-4">
        <${Tile} label="Phases" figure=${t.phases} note=${`${t.done} done · ${t.percent}% of everything`} />
        <${Tile} label="Ready now" figure=${t.ready} accent=${t.ready > 0} note=${`${t.inProgress} in flight · ${t.waiting} waiting`} />
        <${Tile} label="Work left" figure=${weight(t.remainingWeight)} note=${`≈ ${t.remainingSessions} sessions across open plans`} />
        <${Tile}
          label="Errors"
          figure=${counts.error}
          note=${`${counts.warning} warning${counts.warning === 1 ? '' : 's'} · ${counts.info} note${counts.info === 1 ? '' : 's'}`} />
      </div>

      <div class="grid cols-2" style="margin-top:var(--s4)">
        <div class="card">
          <div class="card-head">
            <h3>Velocity</h3>
            <span class="faint" style="font-size:var(--text-xs)">phases completed per week · 26 weeks</span>
          </div>
          <div class="card-body">
            <${Bars} data=${stats.velocity} label="phases" />
            <div class="row" style="justify-content:space-between;margin-top:var(--s2)">
              <span class="faint mono" style="font-size:var(--text-xs)">${stats.velocity[0]?.week}</span>
              <span class="faint" style="font-size:var(--text-xs)">
                median gap between phases
                ${stats.medianCycleDays == null ? ' —'
                  : stats.medianCycleDays === 0 ? ' same day'
                    : ` ${stats.medianCycleDays}d`}
              </span>
              <span class="faint mono" style="font-size:var(--text-xs)">${stats.velocity.at(-1)?.week}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Completions by day</h3></div>
          <div class="card-body"><${Calendar} data=${stats.calendar} /></div>
        </div>
      </div>

      <div class="grid cols-3" style="margin-top:var(--s4)">
        <div class="card">
          <div class="card-head"><h3>Phase states</h3></div>
          <div class="card-body">
            <${StackBar} segments=${[
              { label: 'done', value: t.done, color: 'var(--line-done)' },
              { label: 'in progress', value: t.inProgress, color: 'var(--line-progress)' },
              { label: 'ready', value: t.ready, color: 'var(--line-ready)' },
              { label: 'blocked', value: t.stuck, color: 'var(--line-blocked)' },
              { label: 'waiting', value: t.waiting, color: 'var(--line-waiting)' },
            ]} />
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Plan status</h3></div>
          <div class="card-body">
            <${BarList} items=${stats.byStatus.map((row) => ({ name: row.status, value: row.count }))} />
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Phase sizes</h3></div>
          <div class="card-body">
            <${StackBar} segments=${stats.sizeMix.map((row, i) => ({
              label: row.size,
              value: row.count,
              color: ['var(--line-done)', 'var(--line-progress)', 'var(--line-gated)'][i],
            }))} />
            <div class="faint" style="font-size:var(--text-xs);margin-top:var(--s2)">
              S 15K · M 40K · L 90K working-set weight, from the skill's sizing.env
            </div>
          </div>
        </div>
      </div>

      <div class="grid cols-3" style="margin-top:var(--s4)">
        <div class="card">
          <div class="card-head"><h3>Repos touched</h3></div>
          <div class="card-body"><${BarList} items=${stats.repos.map((row) => ({ name: row.repo, value: row.count }))} /></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Skills used</h3></div>
          <div class="card-body">
            ${stats.skills.length
              ? html`<${BarList} items=${stats.skills.map((row) => ({ name: row.skill, value: row.count }))} />`
              : html`<span class="faint">No handoff records a skill yet.</span>`}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Target models</h3></div>
          <div class="card-body"><${BarList} items=${stats.models.map((row) => ({ name: row.model, value: row.count }))} /></div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:var(--s4)">
        <div class="card">
          <div class="card-head">
            <h3>Locks</h3>
            <span class="faint" style="font-size:var(--text-xs)">a claimed phase belongs to one session</span>
          </div>
          <div class="card-body">
            ${stats.activeLocks.length ? stats.activeLocks.map((lock) => html`
              <div class="row" key=${`${lock.slug}-${lock.phase}`} style="justify-content:space-between;padding:3px 0;gap:var(--s2)">
                <button class="chip plain" onClick=${() => navigate(phaseHref(lock.slug, lock.phase).slice(2))}>
                  ${lock.slug} P${lock.phase}
                </button>
                <span class="mono truncate faint" style="font-size:var(--text-xs);flex:1">${lock.owner}</span>
                ${lock.expired
                  ? html`<${Chip} kind="lock expired">expired</${Chip}>`
                  : html`<${Chip} kind="lock">${countdown(lock.leaseUntil)}</${Chip}>`}
              </div>`)
              : html`<span class="faint">No phase is claimed.</span>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Busiest plans</h3>
            <span class="faint" style="font-size:var(--text-xs)">phases completed</span>
          </div>
          <div class="card-body">
            <${BarList} items=${stats.busiest.map((row) => ({ name: row.slug, value: row.completions }))} />
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:var(--s4)">
        <div class="card-head">
          <h3>Health</h3>
          <div class="btn-group">
            ${[['all', `All ${stats.issues.length}`], ['error', `Errors ${counts.error}`], ['warning', `Warnings ${counts.warning}`], ['info', `Info ${counts.info}`]].map(([id, label]) => html`
              <button key=${id} class="btn small" aria-pressed=${String(severity === id)} onClick=${() => setSeverity(id)}>${label}</button>`)}
          </div>
        </div>
        <div class="card-body">
          ${issues.length ? issues.map((issue, i) => html`
            <div class=${`issue-row ${issue.severity}`} key=${i}>
              <span class="issue-kind">${issue.kind}</span>
              <span>
                <button class="chip plain" onClick=${() => navigate(
                  issue.phase ? phaseHref(issue.slug, issue.phase).slice(2) : planHref(issue.slug).slice(2),
                )}>${issue.slug}${issue.phase ? ` P${issue.phase}` : ''}</button>
                <span> ${issue.message}</span>
              </span>
            </div>`)
            : html`<${Empty} title="Nothing flagged" hint="Plans, handoffs, indexes and locks all agree." />`}
        </div>
      </div>

      ${stats.stalled.length ? html`
        <div class="card" style="margin-top:var(--s4)">
          <div class="card-head">
            <h3>Stalled plans</h3>
            <span class="faint" style="font-size:var(--text-xs)">ready work, untouched for a week or more</span>
          </div>
          <div class="card-body">
            ${stats.stalled.map((item) => html`
              <div class="row" key=${item.slug} style="justify-content:space-between;padding:3px 0">
                <button class="chip plain" onClick=${() => navigate(planHref(item.slug).slice(2))}>${item.slug}</button>
                <span class="faint" style="font-size:var(--text-xs)">P${item.ready.join(', P')} ready · idle ${item.days} days</span>
              </div>`)}
          </div>
        </div>` : null}
    </div>`;
}
