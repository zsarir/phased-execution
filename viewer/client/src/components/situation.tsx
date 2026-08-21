/**
 * The situation, rendered: what the classifier says this phase IS, why, and
 * the evidence it read — the first thing the phase's "Why is this not done?"
 * panel shows, because it is the first thing the unattended healer reads.
 *
 * Pure presentation: the words come from the shared model via the server
 * payload, the evidence lines are already sentences. No queries, no verbs —
 * the Ways forward beside it carry those.
 */

import { Chip } from '@/components/ui';
import type { SituationView } from '@/lib/situation';

const ACTOR_WORDS: Record<string, string> = {
  machine: 'the autopilot climbs its ladder',
  person: 'a person is needed',
  wait: 'nothing to do but wait',
  none: 'nothing is wrong',
};

export function SituationSummary({
  situation,
  evidence,
  compact = false,
}: {
  situation: SituationView | null | undefined;
  /** `summariseEvidence` lines from the server — shown under a disclosure. */
  evidence?: string[];
  /** Chip + blurb only — for a table row. */
  compact?: boolean;
}) {
  if (!situation) return null;
  const actor = ACTOR_WORDS[situation.actor] ?? situation.actor;
  return (
    <div className="flex flex-col gap-1 text-2xs" data-testid="situation">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-faint">Situation</span>
        <Chip
          title={situation.blurb}
          tone={
            situation.actor === 'person'
              ? 'warn'
              : situation.actor === 'machine'
                ? 'busy'
                : situation.actor === 'none'
                  ? 'ok'
                  : 'neutral'
          }
        >
          {situation.label}
        </Chip>
        <span className="text-ink-faint">· {actor}</span>
        <code className="font-mono text-ink-faint">{situation.key}</code>
      </div>
      {!compact && <div className="text-ink-muted">{situation.blurb}</div>}
      {!compact && situation.why.length > 0 && (
        <ul className="ml-4 list-disc" data-testid="situation-why">
          {situation.why.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {!compact && evidence && evidence.length > 0 && (
        <details>
          <summary className="cursor-pointer">Evidence it read ({evidence.length})</summary>
          <ul className="ml-4 mt-1 list-disc font-mono" data-testid="situation-evidence">
            {evidence.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
