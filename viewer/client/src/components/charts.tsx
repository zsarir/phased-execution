/**
 * Seven hand-drawn charts. One accent hue per meaning, tabular figures, no
 * decoration that does not carry data.
 *
 * Ported from `web/components/charts.js` — restyled, not redesigned. The
 * geometry is unchanged; what changed is that **every colour is a token**.
 * The old versions took a `color` string per segment and the call sites passed
 * `var(--line-done)` by hand, which meant a chart could be given a raw hex and
 * nothing would notice. Here the palette is a closed set of state names and the
 * component resolves them, so a chart cannot be painted a colour the design
 * system does not have. `charts.test.tsx` asserts that.
 *
 * No chart library. These are seven shapes totalling ~300 lines; the smallest
 * charting dependency is larger than the whole plan surface's chunk, and it
 * would arrive with its own colour vocabulary to fight.
 */

import { useMemo, useState } from 'react';
import { useNarrow } from '@/lib/media';
import { cn } from '@/lib/cn';
import { UI_STATES, boardUiState, phaseUiState, type UiState } from '@/lib/status-vocab';

/**
 * The only colours a chart may use: the eight UI states of the status
 * vocabulary, by name.
 *
 * Deliberately the *state* palette rather than a decorative one: every chart on
 * the statistics page is counting phases in some state, so a bar's colour and a
 * badge's colour mean the same thing on the same screen.
 */
export const CHART_TONES = UI_STATES;

export type ChartTone = UiState;

/** A tone name → the CSS custom property that holds it. Nothing else is legal. */
export const toneVar = (tone: ChartTone): string => `var(--status-${tone})`;

/* ------------------------------------------------------------------ *
 * Bars — weekly completions
 * ------------------------------------------------------------------ */

export interface BarPoint {
  week: string;
  count: number;
}

/**
 * Weekly completions. The current week is amber, because it is the only bar
 * that is still being written.
 */
export function Bars({
  data,
  height = 92,
  label = 'completions',
}: {
  data: BarPoint[];
  height?: number;
  label?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const width = 100;
  const gap = 1.2;
  const barWidth = Math.max(0.8, width / Math.max(1, data.length) - gap);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      height={height}
      className="w-full"
      role="img"
      aria-label={`${label} per week`}
    >
      {data.map((point, i) => {
        const barHeight = (point.count / max) * (height - 14);
        const current = i === data.length - 1;
        return (
          <rect
            key={point.week ?? i}
            x={i * (barWidth + gap)}
            y={height - 12 - barHeight}
            width={barWidth}
            height={Math.max(point.count ? 1.5 : 0, barHeight)}
            rx="0.6"
            fill={current ? 'var(--action)' : toneVar('running')}
            opacity={current ? 1 : 0.75}
          >
            <title>{`${point.week}: ${point.count} ${label}`}</title>
          </rect>
        );
      })}
      <line
        x1="0"
        y1={height - 11}
        x2={width}
        y2={height - 11}
        stroke="var(--rule)"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar — a year of completions, one square per day
 * ------------------------------------------------------------------ */

export interface CalendarDay {
  date: string;
  count: number;
}

/**
 * Half the range on a phone.
 *
 * 26 weeks across 358px is a 12px square, and the readout under it used to be
 * `onMouseEnter`-only — so on a phone the whole chart was a texture with no way
 * to ask it anything. 13 weeks doubles the square and a tap answers. It is a
 * display rather than a control, so the squares are deliberately not 44px
 * (26 of those would be 1144px wide) — the readout below is what makes it
 * legible without one.
 *
 * ⚠️ `today` is read once per render rather than per cell: building 180 cells
 * each of which asks the clock is how a chart ends up straddling midnight.
 */
export function Calendar({ data, weeks = 26 }: { data: CalendarDay[]; weeks?: number }) {
  const [picked, setPicked] = useState<CalendarDay | null>(null);
  const narrow = useNarrow();
  const span = narrow ? Math.min(weeks, 13) : weeks;

  const cells = useMemo(() => {
    const byDate = new Map(data.map((d) => [d.date, d.count]));
    const max = Math.max(1, ...data.map((d) => d.count));
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - span * 7 - start.getUTCDay());

    const out: { date: string; count: number; x: number; y: number; intensity: number }[] = [];
    for (let w = 0; w <= span; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + w * 7 + d);
        if (date > today) continue;
        const key = date.toISOString().slice(0, 10);
        const count = byDate.get(key) ?? 0;
        out.push({
          date: key,
          count,
          x: w * 11,
          y: d * 11,
          intensity: count ? 0.25 + (count / max) * 0.75 : 0,
        });
      }
    }
    return out;
  }, [data, span]);

  return (
    <div>
      <svg
        viewBox={`0 0 ${(span + 1) * 11} 78`}
        height="86"
        className="w-full"
        role="img"
        aria-label="Phase completions by day"
      >
        {cells.map((cell) => (
          <rect
            key={cell.date}
            x={cell.x}
            y={cell.y}
            width="9"
            height="9"
            rx="1.5"
            fill={cell.count
              ? `color-mix(in oklab, ${toneVar('done')} ${Math.round(cell.intensity * 100)}%, var(--track))`
              : 'var(--track)'}
            onMouseEnter={() => setPicked(cell)}
            onMouseLeave={() => setPicked(null)}
            onClick={() => setPicked((current) => (current?.date === cell.date ? null : cell))}
          >
            <title>{`${cell.date}: ${cell.count} phase${cell.count === 1 ? '' : 's'}`}</title>
          </rect>
        ))}
      </svg>
      <div className="min-h-[1.2em] text-2xs text-ink-faint">
        {picked
          ? `${picked.date} · ${picked.count} phase${picked.count === 1 ? '' : 's'} completed`
          : `last ${span} weeks`}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BarList — ranked horizontal bars
 * ------------------------------------------------------------------ */

export interface BarListItem {
  name: string;
  value: number;
}

/** Repos, skills, models — anything ranked by a count. */
export function BarList({
  items,
  unit = '',
  tone = 'running',
  className,
}: {
  items: BarListItem[];
  unit?: string;
  tone?: ChartTone;
  className?: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  if (!items.length) return <span className="text-sm text-ink-faint">Nothing recorded yet.</span>;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {items.map((item) => (
        <div key={item.name} className="grid grid-cols-[minmax(0,1fr)_2.5fr_auto] items-center gap-2">
          <span className="truncate text-xs text-ink-muted" title={item.name}>{item.name}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-track">
            <span
              className="block h-full rounded-full"
              style={{ width: `${(item.value / max) * 100}%`, background: toneVar(tone) }}
            />
          </span>
          <span className="text-right font-mono text-2xs tabular-nums text-ink">
            {item.value}{unit}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * StackBar — a proportional stack with its own legend
 * ------------------------------------------------------------------ */

export interface StackSegment {
  label: string;
  value: number;
  tone: ChartTone;
}

/**
 * The size mix, the status split.
 *
 * `tone` is a state name rather than a colour string — the change that makes
 * the legend and the bar unable to disagree, because both read the same token
 * from the same place.
 */
export function StackBar({ segments }: { segments: StackSegment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-track" role="img"
           aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}>
        {segments.map((segment) => (
          <span
            key={segment.label}
            style={{ width: `${(segment.value / total) * 100}%`, background: toneVar(segment.tone) }}
          >
            <title>{`${segment.label}: ${segment.value}`}</title>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5 text-2xs text-ink-muted">
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: toneVar(segment.tone) }}
              aria-hidden
            />
            {segment.label} <span className="font-mono tabular-nums text-ink">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * LoadMeter — one phase against one session
 * ------------------------------------------------------------------ */

/**
 * How much of a session a phase would take.
 *
 * This is the number the whole skill is organised around: phases are sized so a
 * session's working set stays inside a fraction of the model's window, and the
 * plan declares the budget that fraction is of. A weight alone ("40K") is a fact
 * nobody can act on; the same weight drawn against the budget is the answer to
 * "can I start this before the meeting".
 *
 * The quarter ticks are not decoration — they are what makes the bar readable
 * without a number beside it, which is what a phone needs.
 */
export function LoadMeter({
  fraction,
  label,
  description,
  tone = 'running',
  className,
}: {
  /** 0–1, or null when the phase has no weight or the plan no budget. */
  fraction: number | null;
  /** Kept to a few characters — the bar is the message, this is the check. */
  label: string;
  /** The exact reading, for the accessible name and the tooltip. */
  description?: string;
  tone?: ChartTone;
  className?: string;
}) {
  if (fraction == null) {
    return <span className={cn('text-2xs text-ink-faint', className)}>{label}</span>;
  }
  return (
    <span
      className={cn('flex min-w-0 items-center gap-2', className)}
      role="img"
      aria-label={`session load: ${description ?? label}`}
      title={description ?? label}
    >
      <span className="relative block h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-track">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.round(fraction * 100)}%`, background: toneVar(tone) }}
        />
        {[0.25, 0.5, 0.75].map((tick) => (
          <span
            key={tick}
            className="absolute inset-y-0 w-px bg-ground/70"
            style={{ left: `${tick * 100}%` }}
            aria-hidden
          />
        ))}
      </span>
      {/* A fixed width so a column of meters has its bars start and end on the
          same pixel — a ragged right edge reads as noise, not as data. */}
      <span className="w-9 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-faint">
        {label}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * RouteStrip — a whole plan, at a glance
 * ------------------------------------------------------------------ */

export interface StripPhase {
  phase: number;
  state: string;
  title?: string;
}

/**
 * A plan's phases as one line of track.
 *
 * The route map answers "what depends on what"; this answers "how far along is
 * this, and where is the work" in the width of a list row. Every phase is one
 * segment in plan order, painted by state, so the shape of a plan — a solid run
 * of green with an amber notch two thirds along — is legible before any of the
 * words are.
 *
 * Segments flex rather than taking a fixed width, so a 31-phase plan and a
 * 4-phase plan both fill the row and neither can push a phone sideways. Like
 * `Calendar`, it is a display and not a control: 31 tappable 44px targets do not
 * fit on a phone, so the strip as a whole is the link and the ready phases get
 * their own targets in the row beside it.
 */
export function RouteStrip({ phases, className }: { phases: StripPhase[]; className?: string }) {
  if (!phases.length) return null;
  const done = phases.filter((p) => p.state === 'done').length;

  return (
    <span
      className={cn('flex h-3 w-full min-w-0 items-stretch gap-px', className)}
      role="img"
      aria-label={`${phases.length} phases, ${done} done`}
    >
      {phases.map((p) => {
        const ready = p.state === 'ready';
        return (
          <span
            key={p.phase}
            className={cn(
              'block min-w-0 flex-1 rounded-[1px] first:rounded-l-sm last:rounded-r-sm',
              // The one state you can act on is drawn full-height; everything
              // else is a band. Amber alone would be a colour difference on a
              // 6px segment, which is not a difference on a phone in daylight.
              ready ? 'self-stretch' : 'my-[3px]',
            )}
            // The board word → its UI state, through the vocabulary: an engine
            // that learns a new word paints it as the unknown state, never as an
            // undeclared custom property (transparent — "this phase does not exist").
            style={{ background: toneVar(boardUiState(p.state)) }}
            title={`P${p.phase} · ${p.state}${p.title ? ` · ${p.title}` : ''}`}
          />
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * RunStrip — what a run actually did to a plan
 * ------------------------------------------------------------------ */

export interface RunPhase {
  phase: number;
  /** A `PhaseStatus` from the runner — a different vocabulary to a plan's. */
  status: string;
  /** The caller's one-line reading, for the tooltip. Cost and attempts belong here. */
  detail?: string;
}

/**
 * One run as a line of track.
 *
 * `/api/runs` already carries a full `PhaseRecord` for every phase of every run,
 * and until now no page read any of it — a run was six columns, of which one was
 * a status word for the run as a whole. This is that record made legible in the
 * width of a table cell: eight phases done and one red is a different run from
 * one phase done and eight pending, and the status word `halted` cannot tell
 * them apart.
 *
 * The running phase is drawn full-height for the same reason `RouteStrip` does
 * that to a ready one: it is the segment you are looking for, and on a 6px
 * segment a hue change alone is not a difference.
 */
export function RunStrip({ phases, className }: { phases: RunPhase[]; className?: string }) {
  if (!phases.length) return null;
  const done = phases.filter((p) => p.status === 'done').length;

  return (
    <span
      className={cn('flex h-3 w-full min-w-0 items-stretch gap-px', className)}
      role="img"
      aria-label={`${phases.length} phases, ${done} done`}
    >
      {phases.map((p) => {
        const active = p.status === 'running' || p.status === 'verifying';
        return (
          <span
            key={p.phase}
            className={cn(
              'block min-w-0 flex-1 rounded-[1px] first:rounded-l-sm last:rounded-r-sm',
              active ? 'self-stretch' : 'my-[3px]',
            )}
            // The runner's word → its UI state, through the same vocabulary a
            // badge reads: `parked` needs a person (never red), `failed` is red.
            style={{ background: toneVar(phaseUiState(p.status)) }}
            title={`P${p.phase} · ${p.status}${p.detail ? ` · ${p.detail}` : ''}`}
          />
        );
      })}
    </span>
  );
}
