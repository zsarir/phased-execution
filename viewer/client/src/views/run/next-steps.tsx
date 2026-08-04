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
import { classifyBoardPhase, classifyPhase, liveRecovery, type RecoveryClass } from '@/lib/recovery';
import { phaseHref } from '@shared/routes.js';
import { RecoveryButton } from './status';
import type { PhaseView, RunState, TerminalSession } from '@/lib/api';

/** One stopped phase, with its cause and its way forward. */
type Row = {
  phase: number;
  title: string;
  state: string;
  why: string;
  /** Offer a recovery session of this class. */
  recoveryClass?: RecoveryClass | undefined;
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
  authFailure: boolean,
): Row[] {
  const rows: Row[] = [];
  for (const p of planPhases) {
    const record = run?.phases?.[String(p.phase)];

    if (p.state === 'done') {
      // A red record on a green phase: this run's attempt stopped, the work
      // was finished and verified outside it. Nothing to press — but leaving
      // the chip unexplained is the dead end this card exists to remove.
      if (record && ['failed', 'interrupted', 'parked'].includes(record.status)) {
        rows.push({
          phase: p.phase,
          title: p.title,
          state: 'done',
          why: `this run's own attempt stopped (${excerpt(record.note ?? record.status, 160)})`
            + ' — but the phase was finished and verified outside it, and the board reads done.'
            + ' Nothing needs fixing; the Why? button on its row shows what failed here.',
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
        recoveryClass: classifyBoardPhase(p.state),
        readMore: p.handoff?.file ? phaseHref(slug, p.phase) : undefined,
      });
      continue;
    }

    if (p.gated && (!record || record.status === 'parked' || record.status === 'pending')) {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        why: record?.note
          ?? (p.gates
            ? `gated — the plan asks a person to confirm first: ${excerpt(p.gates, 220)}`
            : 'gated — the plan names a condition a person must confirm before this phase runs.'),
        retry: 'rechecks-gate',
        readMore: phaseHref(slug, p.phase),
      });
      continue;
    }

    if (record && ['failed', 'interrupted', 'parked'].includes(record.status)) {
      const haltHere = run?.halt?.phase === p.phase ? run.halt.reason : undefined;
      rows.push({
        phase: p.phase,
        title: p.title,
        state: record.status,
        why: excerpt(record.note ?? haltHere) ?? `this run recorded it ${record.status}, without a note.`,
        recoveryClass: classifyPhase(record.status, run, { authFailure }),
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
  allowAgent,
  authFailure,
  sessions,
  busy,
  onRecover,
  onRetry,
}: {
  slug: string;
  planPhases: readonly PhaseView[];
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  allowAgent: boolean;
  authFailure: boolean;
  sessions?: TerminalSession[] | undefined;
  busy?: string | null | undefined;
  onRecover: (phase: number, recoveryClass: RecoveryClass) => void;
  onRetry: (phase: number) => void;
}) {
  if (live) return null;
  const rows = nextStepRows(slug, planPhases, run, authFailure);
  if (!rows.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Why this is stopped — and the way forward</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.map((row) => {
          const recovering = liveRecovery(sessions, { slug, phase: row.phase });
          return (
            <div key={row.phase} className="flex flex-col gap-1.5 border-b border-rule pb-3 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs text-ink-faint">P{row.phase}</span>
                <span className="min-w-0 truncate text-sm font-medium">{row.title}</span>
                <StateChip state={row.state} board />
              </div>
              <p className="max-w-prose text-2xs text-ink-muted">{row.why}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {row.recoveryClass && (
                  <RecoveryButton
                    kind={row.recoveryClass}
                    allowAgent={allowAgent}
                    {...(recovering ? { runningSessionId: recovering.id } : {})}
                    onStart={() => onRecover(row.phase, row.recoveryClass!)}
                    busy={busy === 'recover'}
                  />
                )}
                {row.retry && (
                  <Button
                    size="sm"
                    disabled={!allowRun || busy === 'retry'}
                    title={row.retry === 'rechecks-gate'
                      ? 'Re-checks the gate and continues if it now holds — confirm the condition first; nothing here bypasses a gate.'
                      : "Clears this phase's failure and CONTINUES the run from here."}
                    onClick={() => onRetry(row.phase)}
                  >
                    {row.retry === 'rechecks-gate' ? 'Retry (re-checks the gate)' : 'Retry'}
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
