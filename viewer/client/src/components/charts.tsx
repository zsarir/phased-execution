/**
 * Four hand-drawn SVG charts. One accent hue per meaning, tabular figures, no
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
 * No chart library. These are four shapes totalling ~150 lines; the smallest
 * charting dependency is larger than the whole plan surface's chunk, and it
 * would arrive with its own colour vocabulary to fight.
 */

import { useMemo, useState } from 'react';
import { useNarrow } from '@/lib/media';
import { cn } from '@/lib/cn';

/**
 * The only colours a chart may use.
 *
 * Deliberately the *state* palette rather than a decorative one: every chart on
 * the statistics page is counting phases in some state, so a bar's colour and a
 * chip's colour mean the same thing on the same screen.
 */
export const CHART_TONES = ['done', 'ready', 'progress', 'waiting', 'blocked', 'stuck', 'gated'] as const;

export type ChartTone = (typeof CHART_TONES)[number];

/** A tone name → the CSS custom property that holds it. Nothing else is legal. */
export const toneVar = (tone: ChartTone): string => `var(--line-${tone})`;

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
            fill={current ? 'var(--action)' : toneVar('progress')}
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
  tone = 'progress',
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
