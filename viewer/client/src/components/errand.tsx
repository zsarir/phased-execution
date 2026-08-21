/**
 * The ladder, drawn: what the machine tried on a phase, what it is doing now,
 * what it tries next — and, when the ladder is exhausted (or the situation
 * was a person's from the start), the ONE errand it left: what is needed and
 * how to give it.
 *
 * Two pieces, both pure renderings of `ladderView()` (`lib/ladder.ts`):
 *
 *   · `LadderStrip` — one line under a Ways-forward group: the situation chip,
 *     the rungs climbed (each with how it ended), the rung in flight, the next
 *     rung. Every word comes from `shared/ladder-model.js`, the table the
 *     server climbs, so the strip and the journal can never disagree.
 *   · `ErrandCard` — the card a person is asked with, once. `need` leads,
 *     `how` follows, and what the autopilot already tried is listed so nobody
 *     repeats it by hand. No buttons of its own: the surface that shows it
 *     puts its Ways forward beside it.
 *
 * Neither renders anything for a resolved run — `ladderView()` is empty there,
 * because a settled question is not relitigated, errand included.
 */

import { ArrowRight, Footprints, Hand, Loader2 } from 'lucide-react';
import { Chip } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Errand } from '@/lib/api';
import type { LadderSituation, LadderView, TriedRung } from '@/lib/ladder';

/** What the actor word means for a situation with no rung left to climb. */
const NO_RUNG_WORDS: Record<LadderSituation['actor'], string> = {
  machine: 'no rung left — the next pass leaves an errand',
  person: "a person's to settle — no automatic rung",
  wait: 'settles itself — nothing to climb',
  none: 'nothing is wrong',
};

const SITUATION_TONE: Record<LadderSituation['actor'], 'warn' | 'busy' | 'ok' | 'neutral'> = {
  person: 'warn', machine: 'busy', none: 'ok', wait: 'neutral',
};

function when(iso: string | undefined): string | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? relativeTime(ms) : undefined;
}

function TriedChip({ rung }: { rung: TriedRung }) {
  const tone = rung.outcome === 'fixed' ? 'ok'
    : rung.outcome === 'running' ? 'busy'
      : rung.outcome === 'failed' ? 'bad'
        : 'neutral';
  const title = [
    rung.label,
    rung.outcomeLabel ? `— ${rung.outcomeLabel}` : undefined,
    when(rung.at) ? `(${when(rung.at)})` : undefined,
    typeof rung.costUsd === 'number' ? `· $${rung.costUsd.toFixed(2)}` : undefined,
    rung.note ? `· ${rung.note}` : undefined,
  ].filter(Boolean).join(' ');
  return (
    <Chip tone={tone} title={title} data-testid="ladder-tried">
      {rung.label}
      {rung.outcomeLabel && <span className="text-ink-faint"> → {rung.outcomeLabel}</span>}
    </Chip>
  );
}

/**
 * One line: situation · tried · now · next. Renders nothing when the view is
 * empty, so a surface can drop it in unconditionally.
 */
export function LadderStrip({ view, className }: { view: LadderView; className?: string }) {
  if (view.empty) return null;
  const { situation } = view;
  const settled = Boolean(view.errand);
  return (
    <div
      data-testid="ladder"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-muted', className)}
    >
      {situation && (
        <span className="inline-flex items-center gap-1">
          <span className="text-ink-faint">Situation</span>
          <Chip tone={SITUATION_TONE[situation.actor]} title={`${situation.key} — ${situation.actor === 'machine' ? 'the autopilot climbs its ladder' : situation.actor === 'person' ? 'a person is needed' : situation.actor === 'wait' ? 'nothing to do but wait' : 'nothing is wrong'}`}>
            {situation.label}
          </Chip>
        </span>
      )}
      {view.tried.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Footprints size={11} className="text-ink-faint" aria-hidden />
          <span className="text-ink-faint">tried</span>
          {view.tried.map((rung, index) => <TriedChip key={`${rung.rung}-${rung.at}-${index}`} rung={rung} />)}
        </span>
      )}
      {view.running && (
        <span className="inline-flex items-center gap-1" data-testid="ladder-running">
          <Loader2 size={11} className="animate-spin text-progress" aria-hidden />
          <span className="text-ink-faint">now</span>
          <span className="text-ink">{view.running.label}</span>
        </span>
      )}
      {view.next && (
        <span className="inline-flex items-center gap-1" data-testid="ladder-next">
          <ArrowRight size={11} className="text-ink-faint" aria-hidden />
          <span className="text-ink-faint">next</span>
          <Chip tone="busy" title={`${view.next.blurb}${view.next.spends ? '' : ' Free.'}`}>{view.next.label}</Chip>
        </span>
      )}
      {!view.next && !view.running && !settled && situation && (
        <span className="text-ink-faint" data-testid="ladder-none">
          · {NO_RUNG_WORDS[situation.actor]}
        </span>
      )}
    </div>
  );
}

/**
 * The one ask. `compact` drops the tried list (a dashboard card that already
 * shows the strip); `situationLabel` is the word for the chip when the caller
 * has it, else the raw key the errand carries.
 */
export function ErrandCard({
  errand,
  situationLabel,
  compact = false,
  className,
}: {
  errand: Errand;
  situationLabel?: string | undefined;
  compact?: boolean;
  className?: string;
}) {
  const age = when(errand.at);
  return (
    <div
      role="note"
      data-testid="errand"
      aria-label={`Needs you${errand.phase ? ` — phase ${errand.phase}` : ''}`}
      className={cn('rounded-md border border-action/55 bg-action/8 px-3 py-2 text-sm', className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Hand size={14} className="text-action" aria-hidden />
        <strong className="font-medium text-ink">
          Needs you{errand.phase ? ` — phase ${errand.phase}` : ''}
        </strong>
        <Chip tone="warn" title={errand.situation}>{situationLabel ?? errand.situation}</Chip>
        {age && <span className="ml-auto text-2xs text-ink-faint">{age}</span>}
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink">{errand.need}</p>
      <p className="mt-0.5 max-w-prose text-2xs text-ink-muted">
        <strong className="font-medium text-ink-muted">How:</strong> {errand.how}
      </p>
      {!compact && errand.tried.length > 0 && (
        <p className="mt-1 max-w-prose text-2xs text-ink-faint" data-testid="errand-tried">
          Tried by the autopilot: {errand.tried.join(' · ')}
        </p>
      )}
    </div>
  );
}
