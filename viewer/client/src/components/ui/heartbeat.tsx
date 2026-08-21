import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useNow } from '@/lib/clock';
import { elapsed } from '@/lib/format';

/**
 * A heartbeat: when a lane was last heard from, and whether that is recent
 * enough to call it alive.
 *
 * The dot pulses ONLY while the last beat is inside `staleAfterMs` — a lane
 * silent for longer than that is drawn as the waiting state with the silence
 * written out ("silent 12m"), because a dot that keeps pulsing over a dead
 * session is the lie this console exists not to tell. No beat at all reads
 * as "no heartbeat", never as live.
 */
export function Heartbeat({
  lastBeatAt,
  staleAfterMs = 10 * 60_000,
  live = true,
  label = 'heartbeat',
  className,
  ...props
}: {
  /** Epoch ms of the last assistant message / tool call; null when unknown. */
  lastBeatAt: number | null | undefined;
  /** Silence longer than this is shown as such (the stall threshold). */
  staleAfterMs?: number;
  /** Whether the lane is supposed to be alive at all; off for a settled record. */
  live?: boolean;
  label?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  const now = useNow(Boolean(live && lastBeatAt != null), 5_000);
  const silence = lastBeatAt != null ? Math.max(0, now - lastBeatAt) : null;
  const beating = live && silence != null && silence < staleAfterMs;
  const silent = live && silence != null && silence >= staleAfterMs;
  const text = silence == null
    ? (live ? 'no heartbeat' : '—')
    : silent ? `silent ${elapsed(silence)}` : `${elapsed(silence)} ago`;
  const state = beating ? 'running' : silent ? 'waiting' : 'queued';
  return (
    <span
      role="status"
      aria-label={`${label}: ${text}`}
      title={lastBeatAt != null ? `last heard ${new Date(lastBeatAt).toLocaleTimeString()}` : undefined}
      className={cn('inline-flex items-center gap-1.5 font-mono text-2xs tabular-nums', silent ? 'text-waiting' : 'text-ink-muted', `state-${state}`, className)}
      {...props}
    >
      <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full bg-state', beating && 'animate-pulse-soft')} />
      {text}
    </span>
  );
}
