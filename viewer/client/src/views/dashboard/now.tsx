/**
 * The top of the dashboard: what is happening, and what is waiting on a person.
 *
 * These two are separated on purpose. "A run is going" is *information* — it
 * wants a clock and a link and nothing else. "A session is parked on a
 * permission card" is a *demand*, and a demand rendered in the same weight as
 * information is a demand nobody answers. So the live strip is calm and the
 * attention row is the only place on the page that may be amber.
 */

import { AlertTriangle, Bell, CircleDot, Hand, Lock, Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Card, Chip } from '@/components/ui';
import { useNow } from '@/lib/clock';
import { elapsed, money, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { planHref } from '@shared/routes.js';
import type { RunState } from '@/lib/api';
import { isLive } from '../run/defaults';

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

/** A run's status as a board word, so the dashboard and the run view agree. */
const RUN_WORD: Record<string, string> = {
  running: 'running',
  waiting: 'waiting on a limit',
  paused: 'paused',
  pausing: 'pausing',
  frozen: 'frozen',
  stopping: 'stopping',
  halted: 'halted',
  interrupted: 'interrupted',
  finished: 'finished',
};

export function LiveStrip({ runs }: { runs: RunState[] }) {
  const live = runs.filter((r) => isLive(r.status));
  // The clock ticks only while something is actually moving. A frozen session's
  // seconds are not passing in any sense the operator cares about.
  const now = useNow(live.some((r) => r.status === 'running'));

  if (!live.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {live.map((run) => {
        const started = run.child?.startedAt ? Date.parse(run.child.startedAt) : NaN;
        const running = run.status === 'running';
        return (
          <Card
            key={run.id}
            className={cn(
              'state-in-progress overflow-hidden border-progress/45',
              running && 'shadow-card',
            )}
          >
            <a
              href={planHref(run.slug, 'run')}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 hover:bg-surface-raised md:px-4"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <CircleDot size={15} className={cn('shrink-0 text-state', running && 'animate-pulse-soft')} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-display text-lg leading-tight">{run.slug}</span>
                  <span className="block truncate text-2xs text-ink-muted">
                    {run.activePhase != null ? `phase ${run.activePhase} · ` : ''}
                    {RUN_WORD[run.status] ?? run.status}
                    {run.model ? ` · ${run.model}` : ''}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {Number.isFinite(started) && (
                  <Chip mono tone="busy">{elapsed(now - started)}</Chip>
                )}
                <Chip mono>{money(run.spentUsd)}</Chip>
                <span className="text-2xs text-ink-faint">Watch</span>
              </span>
            </a>
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Attention
 * ------------------------------------------------------------------ */

export interface Demand {
  id: string;
  icon: ReactNode;
  label: string;
  detail: string;
  href: string;
  tone: 'action' | 'bad';
}

/**
 * Everything that is blocked on a person, in the order it costs to ignore.
 *
 * A permission card stops a session dead, so it leads. A halted run has already
 * stopped and will stay stopped. An expired lock is a phase nobody is working
 * that still looks taken. Health errors are last: they are wrong, but nothing
 * is waiting on them.
 */
export function demands({
  approvals,
  runs,
  unread,
  expiredLocks,
  errors,
}: {
  approvals: number;
  runs: RunState[];
  unread: number;
  expiredLocks: { slug: string; phase: number }[];
  errors: number;
}): Demand[] {
  const out: Demand[] = [];

  if (approvals > 0) {
    out.push({
      id: 'approvals',
      icon: <Hand size={15} aria-hidden />,
      label: plural(approvals, 'permission card'),
      detail: 'A session is parked until you answer.',
      href: '#/runs',
      tone: 'action',
    });
  }

  const halted = runs.filter((r) => r.status === 'halted' || r.status === 'interrupted');
  for (const run of halted) {
    out.push({
      id: `halt-${run.id}`,
      icon: <AlertTriangle size={15} aria-hidden />,
      label: `${run.slug} ${run.status}`,
      detail: run.halt?.reason ?? 'The run stopped before it finished.',
      href: planHref(run.slug, 'run'),
      tone: 'bad',
    });
  }

  if (expiredLocks.length) {
    out.push({
      id: 'locks',
      icon: <Lock size={15} aria-hidden />,
      label: `${plural(expiredLocks.length, 'stale claim')}`,
      detail: `${expiredLocks.map((l) => `${l.slug} P${l.phase}`).join(', ')} — the lease ran out, so the phase reads as taken but nobody is in it.`,
      href: '#/stats',
      tone: 'bad',
    });
  }

  if (unread > 0) {
    out.push({
      id: 'unread',
      icon: <Bell size={15} aria-hidden />,
      label: plural(unread, 'unread notification'),
      detail: 'Runs, gates and failures you have not looked at.',
      href: '#/notifications',
      tone: 'action',
    });
  }

  if (errors > 0) {
    out.push({
      id: 'errors',
      icon: <AlertTriangle size={15} aria-hidden />,
      label: plural(errors, 'plan error'),
      detail: 'A plan, handoff or index disagrees with the board.',
      href: '#/stats',
      tone: 'bad',
    });
  }

  return out;
}

export function AttentionRow({ items }: { items: Demand[] }) {
  if (!items.length) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={item.href}
            className={cn(
              'flex h-full items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
              item.tone === 'action'
                ? 'border-action/50 bg-action/8 hover:bg-action/14'
                : 'border-blocked/45 bg-blocked/8 hover:bg-blocked/14',
            )}
          >
            <span className={cn('mt-0.5 shrink-0', item.tone === 'action' ? 'text-action' : 'text-blocked')}>
              {item.icon}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{item.label}</span>
              {/* Clamped, because five of these unclamped is the whole first
                  screen of a phone spent on things the card already named. The
                  page they link to has the full text. */}
              <span className="line-clamp-2 block text-2xs text-ink-muted md:line-clamp-none">
                {item.detail}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * The quiet state
 * ------------------------------------------------------------------ */

/**
 * Nothing running and nothing waiting is the normal case, not an empty state.
 * It is also the moment the dashboard is most useful, so it answers the only
 * question left: what would you start?
 */
export function AllQuiet({
  next,
  allowRun,
}: {
  next?: { slug: string; phase: number; title?: string };
  allowRun: boolean;
}) {
  return (
    <Card className="state-ready flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 md:px-4">
      <span className="min-w-0 flex-1 basis-full sm:basis-0">
        <span className="block text-md">Nothing is running.</span>
        {next
          ? (
            <span className="line-clamp-2 block text-2xs text-ink-muted">
              The board&rsquo;s next move is{' '}
              <span className="text-ink">{next.slug} phase {next.phase}</span>
              {next.title ? ` — ${next.title}` : ''}.
            </span>
          )
          : <span className="block text-2xs text-ink-muted">Nothing is ready to start either.</span>}
      </span>
      {next && (
        <span className="flex shrink-0 gap-2">
          <Button size="sm" variant="action" asChild>
            <a href="#/ready">
              <Play size={13} aria-hidden />
              Open the board
            </a>
          </Button>
          {allowRun && (
            <Button size="sm" asChild>
              <a href={planHref(next.slug, 'run')}>Run it</a>
            </Button>
          )}
        </span>
      )}
    </Card>
  );
}
