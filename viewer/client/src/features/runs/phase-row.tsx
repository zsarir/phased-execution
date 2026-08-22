/**
 * The badges a phase row carries, and the words behind them.
 *
 * Three facts reached the client before this phase and were rendered nowhere:
 *
 *   - **evidence** — `shared/evidence-model.js` `deriveEvidence`, on every
 *     `PhaseView` since Phase 4. The board says a phase is done; this says
 *     whether the handoff, the §Verification result and the QA table agree.
 *     A `done` row that is not `evidenced` is the single most useful thing
 *     this table can tell anyone, and it was invisible.
 *   - **liveness** — `RunDetail.liveness[]`, since Phase 5. A lane that has
 *     not stopped is not the same as a lane that is working.
 *   - **rulings** — the plan's ledger, since Phase 5. A count on the row, the
 *     decisions themselves in the drawer.
 *
 * They live here rather than in `phase-table.tsx` because Phase 9's Phases tab
 * renders the same three against the same shapes, and a badge whose rule was
 * inlined in the run page's table would be a second implementation by the time
 * it got there.
 *
 * Every one of them degrades to rendering NOTHING when its fact is absent —
 * an older server simply does not send `proof` or `liveness`, and a blank cell
 * is the honest rendering of "this console cannot tell you", where a green
 * tick would be a lie.
 */

import { Chip } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { EvidenceProof, LaneLiveness, StallSignal } from '@/lib/api';

/* ---------------- evidence ---------------- */

/**
 * How each verification word reads, and whether it is a problem.
 *
 * `skipped` and `human` are not failures: the first is a command whose lead is
 * not installed on this machine (the supervisor records and moves on), and the
 * second is a §Verification only a person can answer. Painting either red
 * would train people to ignore red.
 */
const VERIFICATION_NOTE: Record<EvidenceProof['verification'], string> = {
  green: 'the §Verification commands ran and passed',
  red: 'a §Verification command failed',
  skipped: 'a §Verification command was skipped — its lead is not installed here',
  human: 'the §Verification needs a person',
  none: 'no §Verification result was recorded',
};

const QA_NOTE: Record<EvidenceProof['qa'], string> = {
  pass: 'QA passed',
  fail: 'QA failed',
  waived: 'QA was waived',
  pending: 'QA has not reported',
  off: 'this plan does not run QA',
};

/**
 * The one-line verdict: claimed, and whether anything on disk backs it.
 *
 * `verbose` is the drawer's rendering — every `why` line spelled out. The row
 * gets the chip alone, because a row with five sentences in it is a row nobody
 * scans.
 */
export function EvidenceLine({
  proof,
  verbose = false,
  className,
}: {
  proof: EvidenceProof;
  verbose?: boolean;
  className?: string;
}) {
  // Only a DONE claim can be unbacked in a way worth a badge. A `ready` phase
  // is not claiming anything yet, and badging it "not evidenced" would put a
  // warning on every plan that has not started.
  const claiming = proof.board === 'done';
  const alarming = claiming && !proof.evidenced;

  if (!verbose) {
    if (!claiming) return null;
    return (
      <Chip tone={alarming ? 'warn' : 'ok'} className={className} title={proof.why.join(' · ')}>
        {proof.evidenced ? 'evidenced' : 'claimed only'}
      </Chip>
    );
  }

  return (
    <section className={cn('rounded border border-rule bg-ground px-2 py-1.5', className)}>
      <h4 className="flex flex-wrap items-baseline gap-1.5 text-2xs font-semibold text-ink">
        Claimed versus evidenced
        <Chip tone={alarming ? 'warn' : proof.evidenced ? 'ok' : 'muted'}>
          {proof.evidenced ? 'evidenced' : claiming ? 'claimed only' : proof.board}
        </Chip>
      </h4>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs">
        <dt className="text-ink-faint">Board</dt>
        <dd>{proof.board}</dd>
        <dt className="text-ink-faint">Handoff</dt>
        <dd>{proof.handoff}</dd>
        <dt className="text-ink-faint">Verification</dt>
        <dd>{VERIFICATION_NOTE[proof.verification] ?? proof.verification}</dd>
        <dt className="text-ink-faint">QA</dt>
        <dd>{QA_NOTE[proof.qa] ?? proof.qa}</dd>
      </dl>
      {proof.why.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-ink-muted">
          {proof.why.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------- liveness ---------------- */

/** Worst first — the order `shared/attention-model.js` STALL_SIGNALS declares. */
const STALL_NOTE: Record<StallSignal, string> = {
  stalemate:
    'Three attempts in a row ended with nothing committed and a clean tree. Re-running has stopped being a remedy.',
  silent: 'No output for ten minutes, and still spending.',
  spinning: 'Six turns without a single tool call — talking rather than working.',
};

const STALL_LABEL: Record<StallSignal, string> = {
  stalemate: 'Stalemate',
  silent: 'Silent',
  spinning: 'Spinning',
};

/**
 * What a lane that has NOT stopped is actually doing.
 *
 * A stall gets a warn chip and its clock; a healthy lane gets the one fact
 * that says it is alive — the last output, or the tool call that is open. No
 * chip at all when there is no lane, which is most rows.
 */
export function LivenessChip({ liveness }: { liveness: LaneLiveness | undefined }) {
  if (!liveness) return null;
  const { stall, openTool, lastOutputAt } = liveness;

  if (stall) {
    return (
      <Chip tone="warn" title={`${STALL_NOTE[stall.signal] ?? ''} ${stall.detail}`.trim()}>
        {STALL_LABEL[stall.signal] ?? stall.signal} · {relativeTime(Date.parse(stall.since))}
      </Chip>
    );
  }

  const at = Date.parse(lastOutputAt);
  const tail = `${liveness.commitsSinceStart} commit(s) so far${liveness.treeDirty ? ', tree dirty' : ''}.`;
  return (
    <Chip
      tone="busy"
      title={
        openTool
          ? `${openTool.name} has been open since ${relativeTime(Date.parse(openTool.since))}. ${tail}`
          : `Last output ${relativeTime(at)}. ${liveness.turnsSinceLastTool} turn(s) since the last tool call, ${tail}`
      }
    >
      {openTool ? openTool.name : relativeTime(at)}
    </Chip>
  );
}

/* ---------------- rulings ---------------- */

/** A count, and nothing more — the decisions themselves are in the drawer. */
export function RulingsChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Chip
      tone="muted"
      title={`${count} decision${count === 1 ? '' : 's'} the plan did not make for this phase. Open the drawer to read them.`}
    >
      {count} ruling{count === 1 ? '' : 's'}
    </Chip>
  );
}
