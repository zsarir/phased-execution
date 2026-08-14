/**
 * Why this plan is stopped — and the way forward.
 *
 * A stopped run used to answer "what now?" with a status word: *blocked*,
 * *parked*, *halted* — each true and none actionable. The facts were always on
 * the wire (the blocked handoff's own Outstanding text, the gate conditions
 * the plan wrote, the note the runner recorded when it parked a phase); this
 * card puts each stopped phase's cause IN ITS OWN WORDS next to the one action
 * that actually moves it:
 *
 *   · a phase whose HANDOFF says blocked → the Outstanding excerpt + Repair
 *     with AI (`plan-repair` — its stale-handoff advice is exactly this job);
 *   · a GATED phase the runner parked → the gate's own conditions + where to
 *     read them, and Retry for after the person has confirmed them (a gate is
 *     deliberately a human's call — no button may bypass it);
 *   · a failed/interrupted/parked record → its note + the matching recovery
 *     class + Retry (which now genuinely restarts the run).
 *
 * Rendered only when nothing is driving: while a run is live the tabs and the
 * table are the truth, and stacking advice on a moving run reads as alarm.
 */

import { Button, Card, CardBody, CardHeader, CardTitle, Chip, StateChip } from '@/components/ui';
import { phaseHref } from '@shared/routes.js';
import { RecoveryActions } from '@/components/recovery-actions';
import type { PhaseView, RunState } from '@/lib/api';

/** One stopped phase, with its cause and its way forward. */
type Row = {
  phase: number;
  title: string;
  state: string;
  why: string;
  /** This run's record of the phase — the shared model computes the offers. */
  record?: { status: string; resumable: boolean } | undefined;
  /** The BOARD calls it stuck (blocked handoff, often no record) — plan-repair's job. */
  stuck?: boolean | undefined;
  /** Offer Retry — with gate rows it re-checks; with records it restarts. */
  retry?: 'restarts' | 'rechecks-gate' | undefined;
  /** Link into the plan, for gates a person has to read before acting. */
  readMore?: string | undefined;
};

/** The first breath of a longer text — enough to know why, not a second page. */
function excerpt(text: string | undefined, max = 300): string | undefined {
  const clean = text?.replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function nextStepRows(
  slug: string,
  planPhases: readonly PhaseView[],
  run: RunState | null,
): Row[] {
  const rows: Row[] = [];
  for (const p of planPhases) {
    const record = run?.phases?.[String(p.phase)];

    if (p.state === 'done') {
      // A red record on a green phase used to be a standing contradiction —
      // the reconcile pass now closes it as "closed outside this run" the
      // moment any read or drive tick sees the board. This branch remains for
      // a record the reconcile has not reached yet (an old console, a stale
      // tab), and the copy says the correction is coming rather than
      // apologising for a permanent state.
      if (record && ['failed', 'interrupted', 'parked', 'waiting', 'gated'].includes(record.status)) {
        rows.push({
          phase: p.phase,
          title: p.title,
          state: 'done',
          why: `this run's own attempt stopped (${excerpt(record.note ?? record.status, 160)})`
            + ' — but the phase was finished outside it, and the board reads done.'
            + ' The record reconciles to done on the next run tick; nothing needs fixing.',
          readMore: phaseHref(slug, p.phase),
        });
      }
      continue;
    }

    if (p.state === 'stuck') {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        why: excerpt(p.handoff?.outstanding)
          ?? `its handoff is marked ${p.handoff?.status ?? 'blocked'} and records no Outstanding section.`,
        stuck: true,
        readMore: p.handoff?.file ? phaseHref(slug, p.phase) : undefined,
      });
      continue;
    }

    if (p.gated && (!record || ['parked', 'gated', 'pending'].includes(record.status))) {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        why: record?.note
          ?? (p.gateKind === 'ai'
            ? `gated (ai-clearable) — a booted session verifies and clears it itself${p.gates ? `: ${excerpt(p.gates, 200)}` : '.'}`
            : p.gates
              ? `gated — the plan asks a person to confirm first: ${excerpt(p.gates, 220)}`
              : 'gated — the plan names a condition a person must confirm before this phase runs.'),
        retry: 'rechecks-gate',
        readMore: phaseHref(slug, p.phase),
      });
      continue;
    }

    if (record && ['failed', 'interrupted', 'parked', 'gated'].includes(record.status)) {
      const haltHere = run?.halt?.phase === p.phase ? run.halt.reason : undefined;
      rows.push({
        phase: p.phase,
        title: p.title,
        state: record.status,
        why: excerpt(record.note ?? haltHere) ?? `this run recorded it ${record.status}, without a note.`,
        record: { status: record.status, resumable: Boolean(record.sessionId ?? record.resumeSessionId) },
        retry: 'restarts',
      });
    }
  }
  return rows;
}

export function NextSteps({
  slug,
  planPhases,
  run,
  live,
  allowRun,
  authFailure,
  busy,
  onRetry,
}: {
  slug: string;
  planPhases: readonly PhaseView[];
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  authFailure: boolean;
  busy?: string | null | undefined;
  onRetry: (phase: number) => void;
}) {
  if (live) return null;
  const rows = nextStepRows(slug, planPhases, run);
  if (!rows.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Why this is stopped — and the way forward</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.map((row) => {
          return (
            <div key={row.phase} className="flex flex-col gap-1.5 border-b border-rule pb-3 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs text-ink-faint">P{row.phase}</span>
                <span className="min-w-0 truncate text-sm font-medium">{row.title}</span>
                <StateChip state={row.state} board />
              </div>
              <p className="max-w-prose text-2xs text-ink-muted">{row.why}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {(row.record || row.stuck) && (
                  <RecoveryActions
                    target={{ slug, phase: row.phase, ...(run?.id ? { runId: run.id } : {}) }}
                    ctx={row.record
                      ? {
                        ...(run ? { run } : {}),
                        record: row.record,
                        ...(authFailure ? { authFailure: true } : {}),
                      }
                      : { boardState: 'stuck' }}
                    max={2}
                  />
                )}
                {row.retry === 'rechecks-gate' && (
                  <Button
                    size="sm"
                    disabled={!allowRun || busy === 'retry'}
                    title="Re-checks the gate and continues if it now holds — confirm the condition first; nothing here bypasses a gate."
                    onClick={() => onRetry(row.phase)}
                  >
                    Retry (re-checks the gate)
                  </Button>
                )}
                {row.readMore && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={row.readMore}>
                      {row.state === 'stuck'
                        ? 'Read the full handoff'
                        : row.state === 'done' ? 'Open the phase' : 'Read the gate (plan)'}
                    </a>
                  </Button>
                )}
                {row.retry === 'rechecks-gate' && (
                  <Chip tone="gate" title="A gate is a decision the plan reserved for a person. The console can re-check it, never take it for you.">
                    needs your confirmation
                  </Chip>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
