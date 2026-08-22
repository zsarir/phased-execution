/**
 * **Next up** — what to start, ranked, with the whole board one disclosure
 * away.
 *
 * ## Why the departures board is here and not on a page of its own
 *
 * `#/ready` and the dashboard's "the board's next move is…" line were two
 * implementations of ONE decision, and for a fortnight they recommended
 * different phases because only one of them had learned that a live claim is
 * a blocker. Two pages that answer the same question will always eventually
 * answer it differently. So the ranking, the hero and the row moved here whole
 * — this file is `views/ready/departure.tsx` under a new name — and `#/ready`
 * redirects to `#/now?focus=next`.
 *
 * ## What survives from the board, and what did not
 *
 * The transit reading survives: plans are lines, phases are stations, `pad2`
 * exists because a departures board writes phase 7 as `07`. **Leverage before
 * size** survives, because the cost of picking wrong is not a slow session, it
 * is a week of the board staying narrow. **A claim is a blocker** survives —
 * a phase another session holds sinks below every unclaimed one in every
 * order and is never the recommendation.
 *
 * What did not survive is the repo and plan `<select>` filters. A home page is
 * not a query tool, and a `<select>` sizes to its widest option — the one
 * interpolating a plan slug measured 423 px inside a 390 px phone (Phase 6).
 * Rank and the two boolean filters are what the DECISION needs; `#/plans` is
 * where "show me only this repo" lives.
 *
 * The boot prompt is fetched on click rather than on render. A prompt costs an
 * engine invocation, and a board of thirteen rows that each pre-fetched one
 * would shell out thirteen times to answer a question nobody asked.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, GitBranch, Lock, ShieldAlert } from 'lucide-react';
import { Button, Chip, CopyButton, StateChip } from '@/components/ui';
import { PromptCard } from '@/components/prompt-card';
import { plainText } from '@/lib/plain-text';
import { LoadMeter } from '@/components/charts';
import { api } from '@/lib/api';
import { keys, useConsoleState, useSessions } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { liveQa } from '@/lib/qa';
import { QaButton } from '@/components/qa-launcher';
import { countdown, pad2, plural, weight as fmtWeight } from '@/lib/format';
import { cn } from '@/lib/cn';
import { phaseHref, planHref } from '@shared/routes.js';
import {
  NO_FILTERS,
  RANKS,
  applyFilters,
  isClaimed,
  load,
  queueTotals,
  rank as rankBy,
  type Departure,
  type Filters,
  type RankId,
} from './model';
import { ForceReleaseButton, ReleaseStaleButton } from '@/components/release-lock';
import type { PlanSummaryFull } from '@/lib/api';

/** Fetch-then-copy, so a prompt costs an engine run only when it is wanted. */
function usePromptText(slug: string, phase: number) {
  const client = useQueryClient();
  return () =>
    client.fetchQuery({
      queryKey: keys.prompt(slug, phase),
      queryFn: () => api.prompt(slug, phase).then((text) => String(text).trim()),
    });
}

/* ------------------------------------------------------------------ *
 * The reasons — why this phase is worth starting, or why it is not
 * ------------------------------------------------------------------ */

/**
 * Every departure carries the same set of facts, and the ones worth saying
 * differ per row. Returning them as a list rather than rendering them inline is
 * what lets the hero read them as sentences and the row as chips without the
 * two drifting apart.
 *
 * **Blockers come first, and that ordering is load-bearing.** A row shows the
 * first two, so with "frees 3 phases" and "on the critical path" leading, the
 * one fact that should stop you — somebody else is holding this phase — was the
 * one that fell off the end. A reason not to start something outranks every
 * argument for starting it.
 */
export function reasons(d: Departure): { key: string; text: string; tone: 'good' | 'warn' | 'bad' }[] {
  const out: { key: string; text: string; tone: 'good' | 'warn' | 'bad' }[] = [];
  if (isClaimed(d.lock)) out.push({ key: 'lock', text: `claimed by ${d.lock!.owner}`, tone: 'bad' });
  if (d.qaFailed) out.push({ key: 'qa', text: 'QA failed here before', tone: 'bad' });
  if (d.gated) {
    out.push({
      key: 'gated',
      text:
        d.gateKind === 'ai'
          ? 'gated (ai) — the session clears it on boot'
          : d.gateKind === 'auto'
            ? 'gated — an automatic check must clear'
            : 'gated — a person must approve first',
      tone: 'warn',
    });
  }
  if (d.unblocks > 0)
    out.push({ key: 'unblocks', text: `frees ${plural(d.unblocks, 'phase')}`, tone: 'good' });
  if (d.onCriticalPath) out.push({ key: 'critical', text: 'on the critical path', tone: 'good' });
  if (d.idleDays >= 7)
    out.push({ key: 'idle', text: `untouched for ${plural(d.idleDays, 'day')}`, tone: 'warn' });
  return out;
}

const TONE_CHIP = { good: 'ok', warn: 'warn', bad: 'bad' } as const;

/* ------------------------------------------------------------------ *
 * The service number — the one piece of pure board typography
 * ------------------------------------------------------------------ */

function ServiceNumber({ phase, large = false }: { phase: number; large?: boolean }) {
  return (
    <span
      className={cn(
        'block shrink-0 text-center font-display leading-none tabular-nums text-state',
        large ? 'w-14 text-3xl' : 'w-9 text-xl',
      )}
      aria-hidden
    >
      {pad2(phase)}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Hero
 * ------------------------------------------------------------------ */

export function NextDeparture({ d, allowRun }: { d: Departure; allowRun: boolean }) {
  const claimed = isClaimed(d.lock);
  const meter = load(d.weight, d.budget);
  const promptText = usePromptText(d.slug, d.phase);

  return (
    <section
      className={cn(
        'animate-rise overflow-hidden rounded-lg border bg-surface shadow-card',
        // The recommendation is the one amber-bordered thing on the page. A
        // phase somebody else is holding is not a recommendation, so it keeps
        // the board's own state colour and loses the glow.
        claimed ? 'state-blocked border-rule' : 'state-ready border-action/45 shadow-action',
      )}
      aria-labelledby="next-departure"
    >
      <div className="flex items-stretch">
        <span className="w-1 shrink-0 bg-state" aria-hidden />
        <div className="min-w-0 flex-1 p-3 md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="next-departure" className="text-2xs font-medium uppercase tracking-[0.14em] text-state">
              {claimed ? 'Next departure — held' : 'Next departure'}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              {claimed &&
                (d.lock?.expired ? (
                  <ReleaseStaleButton slug={d.slug} phase={d.phase} label="Release the claim" />
                ) : (
                  <ForceReleaseButton slug={d.slug} phase={d.phase} lock={d.lock!} />
                ))}
              <StateChip state={claimed ? 'blocked' : 'ready'} board />
            </div>
          </div>

          <div className="mt-2 flex items-start gap-3">
            <ServiceNumber phase={d.phase} large />
            <div className="min-w-0 flex-1">
              <a
                href={phaseHref(d.slug, d.phase)}
                className="block font-display text-2xl leading-tight hover:text-action"
              >
                {/* Plan titles are markdown on disk — `**parallel-safe**` must
                    not reach the screen as asterisks. */}
                {d.title ? plainText(d.title) : `Phase ${d.phase}`}
              </a>
              <a
                href={planHref(d.slug)}
                className="mt-0.5 block truncate font-mono text-2xs text-ink-faint hover:text-action"
              >
                {d.slug}
              </a>
            </div>
          </div>

          <p className="mt-3 text-sm text-ink-muted">{sentence(d)}</p>

          <div className="mt-3 flex flex-col gap-2">
            {/* A meter with nothing to measure is worse than no meter: it
                implies the plan declared a size and this phase came out at
                zero. When there is no weight the row is simply absent. */}
            {meter.fraction != null && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="w-10 shrink-0 text-2xs uppercase tracking-wide text-ink-faint">Load</span>
                <LoadMeter
                  fraction={meter.fraction}
                  label={meter.short}
                  description={meter.long}
                  tone={meter.over ? 'failed' : 'running'}
                  className="max-w-80 min-w-40 flex-1"
                />
                {d.weight != null && d.budget > 0 && (
                  <span className="shrink-0 font-mono text-2xs text-ink-faint">
                    {fmtWeight(d.weight)} of {fmtWeight(d.budget)}
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {d.size && <Chip mono>{d.size}</Chip>}
              {d.repos.slice(0, 3).map((repo) => (
                <Chip key={repo} mono>
                  {repo}
                </Chip>
              ))}
              {d.model && <Chip mono>{d.model}</Chip>}
            </div>
          </div>

          {(d.branch || d.skills.length > 0) && (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
              {d.branch && (
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranch size={11} aria-hidden />
                  {/* A plan's Branch line is PROSE on disk — the live board
                      showed one as ``pe/x` in each code repo, plus one **draft
                      PR per repo**`, asterisks and backticks and all. */}
                  <span className="truncate">{plainText(d.branch)}</span>
                </span>
              )}
              {d.skills.length > 0 && <span>skills: {d.skills.join(', ')}</span>}
            </p>
          )}

          {claimed && (
            <p className="mt-3 flex items-start gap-2 rounded border border-blocked/40 bg-blocked/8 p-2 text-sm text-ink-muted">
              <Lock size={13} className="mt-0.5 shrink-0 text-blocked" aria-hidden />
              <span>
                <span className="text-ink">{d.lock!.owner}</span> holds this phase
                {d.lock!.leaseUntil ? ` — ${countdown(d.lock!.leaseUntil)}` : ''}. Booting a second session
                into it is how two agents overwrite each other.
              </span>
            </p>
          )}

          {d.gated && (
            <p className="mt-3 flex items-start gap-2 rounded border border-gated/40 bg-gated/8 p-2 text-sm text-ink-muted">
              <ShieldAlert size={13} className="mt-0.5 shrink-0 text-gated" aria-hidden />
              <span>{d.gates || 'This phase declares a gate. Clear it before the session starts.'}</span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <CopyButton
              text={promptText}
              size="md"
              variant={claimed ? 'default' : 'action'}
              label="Copy boot prompt"
              copiedLabel="Prompt copied"
            />
            <Button size="md" asChild>
              <a href={phaseHref(d.slug, d.phase)}>Open phase</a>
            </Button>
            {allowRun && (
              <Button size="md" asChild>
                <a href={planHref(d.slug, 'run')}>Run it unattended</a>
              </Button>
            )}
          </div>
        </div>
      </div>

      <PromptCard
        title={`Boot prompt — phase ${d.phase}`}
        queryKey={keys.prompt(d.slug, d.phase)}
        load={() => api.prompt(d.slug, d.phase)}
        note="paste into a fresh session"
        collapsed
        className="rounded-none border-0 border-t border-rule shadow-none"
      />
    </section>
  );
}

/** The recommendation, in words, because a row of chips is not an argument. */
function sentence(d: Departure): string {
  const parts: string[] = [];
  if (d.unblocks > 0) parts.push(`Starting it frees ${plural(d.unblocks, 'phase')}`);
  if (d.onCriticalPath) parts.push('it sits on the critical path');
  if (!parts.length) parts.push('Nothing else in the queue depends on it');
  if (d.idleDays >= 7) parts.push(`and this plan has been idle for ${plural(d.idleDays, 'day')}`);
  return `${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------ */

export function DepartureRow({ d, index }: { d: Departure; index: number }) {
  const [open, setOpen] = useState(false);
  const claimed = isClaimed(d.lock);
  const meter = load(d.weight, d.budget);
  const promptText = usePromptText(d.slug, d.phase);
  const why = reasons(d);
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);

  return (
    <li
      className={cn(
        'animate-fade overflow-hidden rounded border border-rule bg-surface transition-colors',
        'hover:border-rule-strong',
        claimed ? 'state-blocked opacity-75' : 'state-ready',
      )}
      // Staggering by index is the only motion on the board: it makes a re-rank
      // legible as a re-order rather than a flash of new content.
      style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
    >
      <div className="flex items-stretch">
        <span className="w-1 shrink-0 bg-state" aria-hidden />

        {/* One flex row that wraps into two on a phone. The order swaps so the
            title keeps the whole first line beside the actions, and the chips
            drop to a line of their own — a title truncated to "reading t…" to
            make room for a chip is a row that has stopped being useful. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2 md:flex-nowrap md:py-2.5 md:pl-3">
          <a
            href={phaseHref(d.slug, d.phase)}
            // The basis leaves exactly enough room for the two controls to stay
            // on the title's line; any wider and they wrap to a line of their own.
            // The touch floor is on the link rather than the row: the row is the
            // thing you tap, and at `text-md` on two lines it lands at 37px.
            className="order-1 flex min-w-0 flex-1 basis-[calc(100%-9rem)] items-center gap-2.5 hover:text-action md:basis-0 [@media(hover:none)]:min-h-(--tap-min)"
          >
            <ServiceNumber phase={d.phase} />
            <span className="min-w-0">
              <span className="block truncate text-md leading-snug">
                {d.title ? (
                  plainText(d.title)
                ) : d.enriched ? (
                  `Phase ${d.phase}`
                ) : (
                  <span className="text-ink-faint">reading the plan…</span>
                )}
              </span>
              <span className="block truncate font-mono text-2xs text-ink-faint">{d.slug}</span>
            </span>
          </a>

          {/* Wide: the load is a meter in its own column, all of them the same
              width so the bars line up down the board. Narrow: it becomes the
              size chip below, because a 40px bar is not a measurement. */}
          <LoadMeter
            fraction={meter.fraction}
            label={meter.short}
            description={meter.long}
            tone={meter.over ? 'failed' : 'running'}
            className="order-2 hidden w-32 shrink-0 md:flex"
          />

          <div className="order-4 flex basis-full flex-wrap items-center gap-1.5 md:order-3 md:basis-auto md:flex-nowrap">
            {d.size && (
              <Chip mono className="md:hidden">
                {d.size} · {meter.short}
              </Chip>
            )}
            {why.slice(0, 2).map((r) => (
              <Chip key={r.key} tone={TONE_CHIP[r.tone]}>
                {r.text}
              </Chip>
            ))}
          </div>

          <div className="order-3 ml-auto flex shrink-0 items-center gap-1 md:order-4">
            {/* Only where the board is already flagging one. This page ranks
                phases nobody has built yet, so a review has nothing to read on
                most rows — but "QA failed here before" was a warning with no
                remedy beside it, which is the one thing every card on this
                console is supposed to have. */}
            {d.qaFailed && (
              <QaButton
                label="Re-QA"
                target={{
                  slug: d.slug,
                  phase: d.phase,
                  ...(d.title ? { title: plainText(d.title) } : {}),
                  ...(d.model ? { model: d.model } : {}),
                  ...(d.effort ? { effort: d.effort } : {}),
                  qa: { result: 'fail' },
                  planSkills: d.skills ?? [],
                  planMcp: d.mcpServers ?? [],
                }}
                allowAgent={Boolean(state?.allowAgent)}
                allowWrites={Boolean(state?.allowWrites)}
                {...(liveQa(terminals?.sessions, { slug: d.slug, phase: d.phase })
                  ? { runningSessionId: liveQa(terminals?.sessions, { slug: d.slug, phase: d.phase })!.id }
                  : {})}
              />
            )}
            <CopyButton text={promptText} label="Prompt" copiedLabel="Copied" />
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-label={open ? 'Hide the boot prompt' : 'Show the boot prompt'}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown
                size={14}
                aria-hidden
                className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
              />
            </Button>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule bg-ground-deep/40 p-2">
          <PromptCard
            title={`Boot prompt — ${d.slug} phase ${d.phase}`}
            queryKey={keys.prompt(d.slug, d.phase)}
            load={() => api.prompt(d.slug, d.phase)}
          />
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

/** How many rows sit under the hero before the rest folds away. */
const SHOWN = 4;

export interface NextUpProps {
  /** Every ready phase across every open plan, unranked. */
  departures: Departure[];
  plans: readonly PlanSummaryFull[];
  allowRun: boolean;
  loading: boolean;
  /** `?focus=next` landed here. */
  focused?: boolean;
}

export function NextUp({ departures, plans, allowRun, loading, focused = false }: NextUpProps) {
  const [prefs, setPrefs] = usePrefs();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState(false);

  // Default: the plan you touched last. `leverage` led for a year and is a
  // strategy — a good one, on a day you have one; "where was I" is the question
  // an open console is actually asked most often.
  const rankId = (prefs.readyRank ?? 'momentum') as RankId;
  const visible = useMemo(
    () => rankBy(applyFilters(departures, filters), rankId),
    [departures, filters, rankId],
  );
  const totals = queueTotals(visible, plans);
  const filtered = filters.unclaimed || filters.open;
  const [top, ...rest] = visible;

  return (
    <section aria-label="Next up" data-testid="next-up" {...(focused ? { 'data-focused': 'true' } : {})}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">Next up</h2>
        {visible.length > 0 && (
          <span className="text-2xs text-ink-faint">
            {plural(totals.phases, 'phase')} across {plural(totals.plans, 'plan')}
            {totals.claimed ? ` · ${totals.claimed} claimed` : ''}
            {totals.gated ? ` · ${totals.gated} behind a gate` : ''}
          </span>
        )}
        {/* Pressable chips rather than a `<select>`: they wrap, they need no
            listbox, and a select sizes to its widest option — which is the
            423px-inside-390px overflow Phase 6 measured. The board's own
            controls used the same shape below the shell breakpoint. */}
        {/* NOT `shrink-0`, and `ml-auto` only where there is room to push
            against: five chips plus `shrink-0` measured 386px inside a 390px
            main and pushed it 8px wide. They wrap onto their own line on a
            phone instead. */}
        <div
          role="group"
          aria-label="Order the board by"
          className="flex min-w-0 flex-wrap items-center gap-1 sm:ml-auto"
        >
          {RANKS.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={rankId === option.id ? 'action' : 'ghost'}
              aria-pressed={rankId === option.id}
              onClick={() => setPrefs({ readyRank: option.id })}
              title={option.blurb}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {/* The blurb is not help text. Five orders that all sound reasonable are
          five orders nobody switches between; this sentence is what makes the
          choice mean something. */}
      <p className="mb-2 text-2xs text-ink-faint">{RANKS.find((option) => option.id === rankId)?.blurb}</p>

      {!visible.length ? (
        <p className="rounded-lg border border-rule bg-surface px-3 py-2.5 text-sm text-ink-muted">
          {loading
            ? 'Reading the board…'
            : departures.length
              ? 'Every ready phase is filtered out.'
              : 'Nothing is ready: every remaining phase is waiting on one that has not landed, and every plan with ready work is closed or finished.'}
          {!loading && departures.length > 0 && (
            <Button size="sm" className="ml-2" onClick={() => setFilters(NO_FILTERS)}>
              Clear the filters
            </Button>
          )}
        </p>
      ) : (
        <>
          <NextDeparture d={top} allowRun={allowRun} />
          {rest.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {rest.slice(0, SHOWN).map((d, i) => (
                <DepartureRow key={d.key} d={d} index={i} />
              ))}
            </ul>
          )}

          {/* The FULL board, folded. Everything `#/ready` used to be, on the
              page that already answers the question it answered. */}
          {(rest.length > SHOWN || filtered) && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
              >
                <ChevronDown
                  size={12}
                  aria-hidden
                  className={cn('transition-transform', open && 'rotate-180')}
                />
                {open ? 'Hide the full board' : `The full board · ${plural(visible.length, 'phase')}`}
              </button>
              {open && (
                <div className="mt-2">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      aria-pressed={filters.unclaimed}
                      onClick={() => setFilters((f) => ({ ...f, unclaimed: !f.unclaimed }))}
                      title="Hide phases another session is holding."
                    >
                      Unclaimed only
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={filters.open}
                      onClick={() => setFilters((f) => ({ ...f, open: !f.open }))}
                      title="Hide phases that cannot start until a gate is cleared."
                    >
                      Ungated only
                    </Button>
                    <span className="text-2xs text-ink-faint">
                      {departures.length - visible.length > 0
                        ? `${departures.length - visible.length} hidden`
                        : `${plural(totals.sessions, 'session')} of work on the board`}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {rest.slice(SHOWN).map((d, i) => (
                      <DepartureRow key={d.key} d={d} index={i} />
                    ))}
                  </ul>
                  {rest.length <= SHOWN && (
                    <p className="text-2xs text-ink-faint">Everything ready is already shown above.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
