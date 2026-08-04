/**
 * Where this plan is up to, and what may still be done to each phase.
 *
 * ## The board decides, never the run record
 *
 * The old table was built from `run.phases` — the runner's own bookkeeping — and
 * presented that as the phase's status. On a real plan a phase this run had
 * skipped and another session then finished still read `skipped`, and the console
 * offered to run it again. A run record is a record of what THAT RUN did; it was
 * never the phase's state. `phase-graph.sh` is the only source of truth for
 * done/ready/waiting, so the board decides the status and gates every action, and
 * the run record is shown beside it as its own column.
 *
 * That rule lives in `shared/phase-model.js` (`mergePhases` / `boardCounts` /
 * `phaseActions`), imported unchanged — the same module `node --test` checks.
 */

import { useState } from 'react';
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Empty, StateChip,
  TBody, TD, TH, THead, TR, Table, TableWrap,
} from '@/components/ui';
import {
  api, type PhaseRecord, type PhaseStatus, type PhaseView, type RunState, type TerminalSession,
} from '@/lib/api';
import { duration, money, pad2, relativeTime } from '@/lib/format';
import { useDiagnosis } from '@/lib/queries';
import { classifyPhase, liveRecovery, type RecoveryClass } from '@/lib/recovery';
import { canQa, liveQa } from '@/lib/qa';
import { QaButton, QaVerdict } from '@/components/qa-launcher';
import { RecoveryButton } from './status';
import { phaseHref } from '@shared/routes.js';
import {
  BOARD_ORDER, boardCounts, fellOverToAnotherModel, mergePhases, phaseActions,
} from '@shared/phase-model.js';
import { cn } from '@/lib/cn';

/**
 * The state to paint in the Status cell, which is not always the board's.
 *
 * The board reads handoff files, so a phase this run is working on right now
 * still reads `ready` — "Boarding" — until its handoff lands, which can be an
 * hour later. Two vocabularies for two different facts, and the row showed only
 * the stale one: retry a phase and the console went on calling it Boarding
 * while a session was demonstrably running in it, which is the report this
 * exists for.
 *
 * So where this run is live and on this phase, the run's fact is the fresher
 * one and wins. Never against `done` — that is the board saying the work is
 * finished, and the run record has never been allowed to overrule it (see this
 * file's header). Exported because it is a rule about whose word counts, and a
 * rule like that should be checkable without rendering a table.
 */
export function displayState(
  boardState: string, { active, live }: { active: boolean; live: boolean },
): string {
  return active && live && boardState !== 'done' ? 'in-progress' : boardState;
}

/** A plan phase joined to whatever this run recorded against it. */
interface MergedPhase extends PhaseView {
  record?: PhaseRecord;
  /** Finished, but not by this run — worth saying out loud beside a `skipped` record. */
  elsewhere: boolean;
}

interface Actions {
  runAlone: boolean;
  retry: boolean;
  skip: boolean;
  diagnose: boolean;
}

const merge = mergePhases as (planPhases: PhaseView[], run: RunState | null) => MergedPhase[];
const counts = boardCounts as (rows: MergedPhase[]) => Record<string, number>;
const actionsFor = phaseActions as (
  phase: MergedPhase,
  ctx: { live: boolean; allowRun: boolean },
) => Actions;
const fellOver = fellOverToAnotherModel as (record: PhaseRecord | undefined) => boolean;
const ORDER = BOARD_ORDER as string[];

const PHASE_TONE: Record<PhaseStatus, 'ok' | 'busy' | 'bad' | 'warn' | undefined> = {
  done: 'ok',
  running: 'busy',
  verifying: 'busy',
  failed: 'bad',
  parked: 'warn',
  interrupted: 'warn',
  gated: 'warn',
  'awaiting-verification': 'warn',
  skipped: undefined,
  pending: undefined,
};

/**
 * What this console can hand to a Claude session, and what is already on it.
 *
 * Threaded in rather than read here: the table is rendered in tests without a
 * query client, and a component that fetches its own sessions could not be.
 */
export type PhaseRecovery = {
  allowAgent: boolean;
  sessions?: readonly TerminalSession[];
  /** The run's halt looks like an authentication failure — one class overrides all. */
  authFailure?: boolean;
  onStart: (phase: number, kind: RecoveryClass) => void;
  /** The plan's qa-mode, so a row can offer to turn it on with the review. */
  qaMode?: string;
  /** Skills the plan asks every session to invoke. */
  planSkills?: string[];
  /** Whether the console may turn QA on for the plan — a different flag from allowAgent. */
  allowWrites?: boolean;
};

export function PhaseTable({
  slug,
  run,
  planPhases,
  live,
  allowRun,
  onAct,
  recovery,
}: {
  slug: string;
  run: RunState | null;
  planPhases: PhaseView[];
  live: boolean;
  allowRun: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  recovery?: PhaseRecovery;
}) {
  if (!planPhases.length) {
    return (
      <Empty
        title="This plan has no phase graph"
        body="The autopilot drives phases from the plan's own graph table, so there is nothing here to run."
      />
    );
  }

  const rows = merge(planPhases, run);
  const board = counts(rows);
  const asked = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const spent = rows.reduce((sum, r) => sum + (r.record?.costUsd ?? 0), 0);

  return (
    <Card>
      <CardHeader className="flex-wrap items-center">
        <CardTitle>Phases</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {ORDER.filter((state) => board[state]).map((state) => (
            <span key={state} className="flex items-center gap-1">
              <StateChip state={state} board />
              <b className="font-mono text-2xs tabular-nums">{board[state]}</b>
            </span>
          ))}
        </div>
      </CardHeader>

      <CardBody className="p-0">
        <p className="max-w-prose px-4 py-2 text-2xs text-ink-faint">
          Status is the plan's own board, so a phase finished by any other session reads as finished
          here.
          {asked && ` This run was asked for phase${asked.size === 1 ? '' : 's'} ${[...asked].join(', ')} only.`}
        </p>

        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH scope="col">#</TH>
                <TH scope="col">Phase</TH>
                <TH scope="col">Status</TH>
                <TH scope="col">This run</TH>
                <TH scope="col" className="text-right">Cost</TH>
                <TH scope="col" className="text-right">Turns</TH>
                <TH scope="col" className="text-right">Took</TH>
                <TH scope="col">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((p) => (
                <PhaseRows
                  key={p.phase}
                  phase={p}
                  slug={slug}
                  run={run}
                  live={live}
                  allowRun={allowRun}
                  onAct={onAct}
                  recovery={recovery}
                />
              ))}
            </TBody>
          </Table>
        </TableWrap>

        {spent > 0 && (
          <p className="px-4 py-2 text-2xs text-ink-faint">
            This run has spent <b className="font-mono tabular-nums">{money(spent)}</b> across{' '}
            {rows.filter((r) => r.record).length} phase(s) it touched.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function PhaseRows({
  phase: p,
  slug,
  run,
  live,
  allowRun,
  onAct,
  recovery,
}: {
  phase: MergedPhase;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  recovery?: PhaseRecovery;
}) {
  const r = p.record;
  const isActive = run?.activePhase === p.phase;
  // Gated on the BOARD, never on the run record. Offering to run a phase the
  // board calls done is the defect this table was rebuilt for.
  const can = actionsFor(p, { live, allowRun });
  const detoured = fellOver(r);
  const hasNote = Boolean(r?.note || r?.verification || can.diagnose);

  // A recovery is offered for a phase that is genuinely stuck — never for one
  // the BOARD calls done, however this run's record reads, and never while the
  // run is live (the autopilot owns the tree, and the server refuses anyway).
  const recoveryClass = recovery && r && !live && p.state !== 'done'
    ? classifyPhase(r.status, run, { authFailure: recovery.authFailure ?? false })
    : undefined;
  const recovering = liveRecovery(recovery?.sessions, { slug, phase: p.phase });
  const reviewing = liveQa(recovery?.sessions, { slug, phase: p.phase });

  const showing = displayState(p.state, { active: isActive, live });

  return (
    <>
      <TR className={cn(isActive && 'bg-progress/8', p.state === 'done' && 'text-ink-faint')}>
        <TD className="font-mono tabular-nums">{pad2(p.phase)}</TD>
        <TD>
          <a className="underline-offset-2 hover:underline" href={phaseHref(slug, p.phase)}>
            {p.title}
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {p.gated && <Chip tone="gate">gated</Chip>}
            {isActive && <Chip tone="busy">running now</Chip>}
            {p.elsewhere && (
              <span
                className="text-2xs text-ink-faint"
                title="The run record beside this is what this run did; the board is what is true now."
              >
                finished outside this run
              </span>
            )}
          </div>
        </TD>
        <TD>
          <div className="flex flex-wrap items-center gap-1">
            <StateChip
              state={showing}
              board
              title={showing !== p.state
                ? `This run is working on phase ${p.phase} now. The board still reads `
                  + `"${p.state}" and catches up when the phase's handoff lands.`
                : undefined}
            />
            <QaVerdict qa={p.qa} />
          </div>
        </TD>
        <TD className="text-2xs">
          {r ? (
            <>
              <Chip tone={PHASE_TONE[r.status]}>{r.status}</Chip>
              <div className="mt-0.5 text-ink-faint">
                {r.model ?? '—'}
                {r.effort ? ` · ${r.effort}` : ''}
                {r.attempts > 1 ? ` · ${r.attempts} tries` : ''}
              </div>
              {detoured && (
                <div
                  className="text-ink-faint"
                  title="the session fell over to another model without restarting"
                >
                  ran on {r.actualModel}
                </div>
              )}
            </>
          ) : (
            <span className="text-ink-faint">not attempted</span>
          )}
        </TD>
        <TD className="text-right font-mono tabular-nums">{r?.costUsd ? money(r.costUsd) : '—'}</TD>
        <TD className="text-right font-mono tabular-nums">{r?.turns ?? '—'}</TD>
        <TD className="text-right font-mono tabular-nums">
          {r?.durationMs ? duration(r.durationMs) : '—'}
        </TD>
        <TD>
          <div className="flex flex-wrap gap-1">
            {can.retry && (
              <Button size="sm" onClick={() => void onAct('retry', () => api.runRetry(slug, p.phase))}>
                Retry
              </Button>
            )}
            {can.skip && (
              <Button size="sm" onClick={() => void onAct('skip', () => api.runSkip(slug, p.phase))}>
                Skip
              </Button>
            )}
            {can.runAlone && (
              <Button
                size="sm"
                title="Run this phase on its own, then stop — the loop does not carry on into the rest of the plan"
                onClick={() => void onAct('only', () => api.runStart(slug, {
                  model: run?.model,
                  effort: run?.effort,
                  autonomy: run?.autonomy,
                  phaseBudgetUsd: run?.phaseBudgetUsd,
                  runBudgetUsd: run?.runBudgetUsd,
                  permissionProfile: run?.permissionProfile,
                  resumeRunId: run && run.status !== 'finished' ? run.id : undefined,
                  onlyPhases: [p.phase],
                }))}
              >
                Run only this
              </Button>
            )}
            {/* Last, and only when a rule cannot settle it. Retry re-runs the
                phase unchanged and Skip abandons it; this is the middle that
                was missing — read the evidence, fix the cause, finish. */}
            {recoveryClass && recovery && (
              <RecoveryButton
                kind={recoveryClass}
                allowAgent={recovery.allowAgent}
                {...(recovering ? { runningSessionId: recovering.id } : {})}
                onStart={() => recovery.onStart(p.phase, recoveryClass)}
              />
            )}
            {/* Reviewing is not recovering: it is offered for a phase that is
                FINE, which is why it survives the `p.state !== 'done'` gate
                above. Never while the run is live — the autopilot owns the tree
                and the server refuses anyway. */}
            {recovery && !live && canQa(p.state) && (
              <QaButton
                label="QA"
                target={{
                  slug,
                  phase: p.phase,
                  title: p.title,
                  model: p.model,
                  effort: p.effort,
                  ...(recovery.qaMode ? { qaMode: recovery.qaMode } : {}),
                  ...(p.qa ? { qa: p.qa } : {}),
                  planSkills: recovery.planSkills ?? [],
                }}
                allowAgent={recovery.allowAgent}
                allowWrites={recovery.allowWrites}
                {...(reviewing ? { runningSessionId: reviewing.id } : {})}
              />
            )}
          </div>
        </TD>
      </TR>

      {hasNote && (
        <TR>
          <TD />
          <TD colSpan={7}>
            {r?.note && <div className="text-2xs text-ink-faint">{r.note}</div>}
            {r?.verification && (
              <div className={cn('text-2xs', r.verification.ok ? 'text-done' : 'text-blocked')}>
                {r.verification.reason}
              </div>
            )}
            {r?.verification?.notRun?.length ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs">
                  {r.verification.notRun.length} step(s) a person must check
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
                  {r.verification.notRun.map((n, i) => (
                    <li key={i}>
                      <code className="font-mono">{n.text}</code> — {n.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {can.diagnose && (
              <PhaseDiagnosis slug={slug} phase={p.phase} allowRun={allowRun} onAct={onAct} />
            )}
          </TD>
        </TR>
      )}
    </>
  );
}

const BLOCKED_ON: Record<string, string> = {
  board: 'the board — no handoff, or it is not marked complete',
  verification: 'the verification commands',
  lint: 'validate.sh',
};

/**
 * Why this phase is not done, and what can still be done about it.
 *
 * Every fact below was already being written to disk and none of it reached the
 * page: the output of the command that failed, the session's own closing words,
 * the lint summary, whether a handoff exists at all. The run that prompted this
 * halted saying "no handoff was written" while the session had, in its last
 * message, explained exactly why it could not write one — and reading that meant
 * opening NDJSON in a terminal.
 *
 * Fetched when opened rather than with the row: it costs a `git status` and two
 * script runs, and most rows are never opened.
 */
function PhaseDiagnosis({
  slug,
  phase,
  allowRun,
  onAct,
}: {
  slug: string;
  phase: number;
  allowRun: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [asking, setAsking] = useState(false);
  const { data, error, isFetching } = useDiagnosis(slug, phase, open);

  const act = (id: string) => {
    if (id === 'resume') {
      setAsking(true);
      return;
    }
    const call: Record<string, () => Promise<unknown>> = {
      recheck: () => api.runRecheck(slug, phase),
      closeout: () => api.runCloseout(slug, phase),
      retry: () => api.runRetry(slug, phase),
      skip: () => api.runSkip(slug, phase),
    };
    if (call[id]) void onAct(id, call[id]);
  };

  const failed = (data?.verification?.ran ?? []).filter((x) => !x.ok);
  const pre = 'mt-1 max-h-56 overflow-auto rounded border border-rule bg-ground px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap';

  return (
    <details className="mt-1.5" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-2xs">Why is this not done?</summary>

      {error && <div className="mt-1 text-2xs text-blocked">{(error as Error).message}</div>}
      {!data && !error && isFetching && <div className="mt-1 text-2xs text-ink-faint">Reading the run…</div>}

      {data && (
        <div className="mt-2 flex flex-col gap-2">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs">
            <dt className="text-ink-faint">Blocked on</dt>
            <dd>{BLOCKED_ON[data.blockedOn ?? ''] ?? 'nothing the runner can name'}</dd>
            <dt className="text-ink-faint">Board says</dt>
            <dd>
              <code className="font-mono">{data.boardState}</code>
            </dd>
            {data.lock && (
              <>
                <dt className="text-ink-faint">Lock</dt>
                <dd className="text-ink-faint">{data.lock}</dd>
              </>
            )}
            {data.sessionId && (
              <>
                <dt className="text-ink-faint">Session</dt>
                <dd>
                  <code className="font-mono">{data.sessionId}</code>
                  {data.resumable ? ' · can be resumed' : ''}
                </dd>
              </>
            )}
          </dl>

          {data.said && (
            <div>
              <div className="text-2xs">
                <b>The session signed off:</b>
              </div>
              <pre className={pre}>{data.said}</pre>
            </div>
          )}

          {failed.length > 0 && (
            <div>
              <div className="text-2xs">
                <b>What failed:</b>
              </div>
              {failed.map((x, i) => (
                <div key={i} className="mt-1">
                  <div className="text-2xs">
                    <code className="font-mono">{x.command}</code> — exited {x.code}
                  </div>
                  <pre className={pre}>{x.output || '(no output)'}</pre>
                </div>
              ))}
            </div>
          )}

          {data.lint && !data.lint.ok && (
            <div>
              <div className="text-2xs">
                <b>validate.sh:</b>
              </div>
              <pre className={pre}>{data.lint.summary}</pre>
            </div>
          )}

          {data.closeout && (
            <div className="text-2xs text-ink-faint">
              A closeout was already attempted {relativeTime(Date.parse(data.closeout.at))} —{' '}
              {data.closeout.ok ? 'the session ran' : 'it did not complete'}
              {data.closeout.note ? ` (${data.closeout.note})` : ''}.
            </div>
          )}

          {data.workingTree.length > 0 && (
            <details>
              <summary className="cursor-pointer text-2xs">
                {data.workingTree.length} uncommitted path(s)
              </summary>
              <pre className={pre}>{data.workingTree.join('\n')}</pre>
            </details>
          )}

          {asking && (
            <div className="flex flex-col gap-1.5 rounded border border-rule bg-ground p-2">
              <label className="text-2xs" htmlFor={`fix-${phase}`}>
                What should it do before closing the phase?
              </label>
              <textarea
                id={`fix-${phase}`}
                rows={3}
                className="w-full rounded border border-rule bg-surface px-2 py-1 text-2xs"
                placeholder="e.g. the scrub grep still matches README.fa.md — fix that first"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="action"
                  disabled={!instruction.trim()}
                  onClick={() => {
                    void onAct('resume', () => api.runResumePhase(slug, phase, instruction.trim()));
                    setAsking(false);
                  }}
                >
                  Resume with this
                </Button>
                <Button size="sm" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {data.actions.map((a) => (
              <Button key={a.id} size="sm" title={a.detail} disabled={!allowRun} onClick={() => act(a.id)}>
                {a.label}
              </Button>
            ))}
          </div>

          {!allowRun && (
            <div className="text-2xs text-ink-faint">
              This console was started without <code className="font-mono">--allow-run</code>. The
              evidence above is readable; every action here would be refused by the server.
            </div>
          )}
        </div>
      )}
    </details>
  );
}
