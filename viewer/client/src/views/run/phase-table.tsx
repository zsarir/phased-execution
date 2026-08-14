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
  TBody, TD, TH, THead, TR, Table, TableWrap, toast,
} from '@/components/ui';
import {
  api, type PhaseEta, type PhaseLock, type PhaseRecord, type PhaseScope, type PhaseView,
  type QueueEntry, type RunState, type TerminalSession,
} from '@/lib/api';
import { countdown, duration, elapsed, money, pad2, relativeTime } from '@/lib/format';
import { DepsCell, LockCell, PhaseDetails, SizeCell } from '@/views/plan/phase-cells';
import { ForceReleaseButton } from '@/components/release-lock';
import { useNow } from '@/lib/clock';
import { useConsoleState, useDiagnosis } from '@/lib/queries';
import { navigate } from '@/router';
import { phaseProgress } from './header';
import { MCP_REASON } from './defaults';
import { classifyBoardPhase, classifyPhase, liveRecovery } from '@/lib/recovery';
import { canQa, liveQa } from '@/lib/qa';
import { QaButton, QaVerdict } from '@/components/qa-launcher';
import { LaunchDialog } from '@/components/launch-dialog';
import { RecoveryButton } from './status';
import { RecoveryActions } from '@/components/recovery-actions';
import { queueEntryFor, waitingLabel } from './session-panes';
import { phaseHref } from '@shared/routes.js';
import {
  BOARD_ORDER, boardCounts, fellOverToAnotherModel, mergePhases, phaseActions,
} from '@shared/phase-model.js';
import { Bot, Gauge, TerminalSquare } from 'lucide-react';

import { scopeOfRow } from '@shared/scope.js';
import { ScopeChips } from '@/components/scope-chips';
import { PHASE_STATUS_TONE, boardStateTitle, phaseStatusTitle } from '@/lib/status-vocab';
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
 * The first fix keyed on `run.activePhase` — which mirrors only the LOWEST
 * live lane, so with phases 3 and 7 both running, phase 7's row went straight
 * back to "Boarding". The rule now keys on the ROW's own record: a phase whose
 * record is live-running speaks for itself, whichever lane the mirror points
 * at. Never against `done` — that is the board saying the work is finished,
 * and the run record has never been allowed to overrule it (see this file's
 * header). Exported because it is a rule about whose word counts, and a rule
 * like that should be checkable without rendering a table.
 */
export function displayState(
  boardState: string, { running }: { running: boolean },
): string {
  return running && boardState !== 'done' ? 'in-progress' : boardState;
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
  /** The live claim stopping `runAlone`/`retry`, so a disabled button can name it. */
  heldBy: PhaseLock | null;
  /** A lapsed claim — worth tidying, never a reason to refuse. */
  staleLock: boolean;
}

const merge = mergePhases as (planPhases: PhaseView[], run: RunState | null) => MergedPhase[];
const counts = boardCounts as (rows: MergedPhase[]) => Record<string, number>;
const actionsFor = phaseActions as (
  phase: MergedPhase,
  ctx: { live: boolean; allowRun: boolean },
) => Actions;
const fellOver = fellOverToAnotherModel as (record: PhaseRecord | undefined) => boolean;
const ORDER = BOARD_ORDER as string[];
/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
const scopeOf = scopeOfRow as (cell: string | undefined) => string[];

// Single-sourced with the words' own explanations in `lib/status-vocab.ts`.
const PHASE_TONE = PHASE_STATUS_TONE;

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
  queue,
  scopes,
  phaseEta,
}: {
  slug: string;
  run: RunState | null;
  planPhases: PhaseView[];
  live: boolean;
  allowRun: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  recovery?: PhaseRecovery;
  /** The admission queue, for the phases of this plan that are in it. */
  queue?: QueueEntry[] | undefined;
  /** Per-phase scope + what it would collide with if started now. */
  scopes?: PhaseScope[] | undefined;
  /** What each phase was expected to take. Absent on a source with no plan detail. */
  phaseEta?: PhaseEta[] | undefined;
}) {
  // "Run only this" opens the launch dialog on the row's phase; one dialog for
  // the table, keyed by which phase asked. Before the early return — a hook.
  const [launchPhase, setLaunchPhase] = useState<number | null>(null);

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
                {/* The graph the whole board rests on, finally on the row that
                    acts on it: what a phase waits for, and how much waits on
                    it. Both were on the wire and rendered only on the phase
                    page. */}
                <TH scope="col">Deps</TH>
                {/* The fact that decides whether the button beside it works.
                    `PhaseView.lock` reached every row of this table and was
                    read by nothing — a phase could be claimed by another
                    session and this table would offer to start it. */}
                <TH scope="col">Lock</TH>
                {/* What the phase touches — the Repos cell of the plan's own
                    graph, which is what decides whether two phases may run at
                    the same time. It has been parsed by the server since before
                    there was concurrency and shown nowhere. */}
                <TH scope="col">Repos</TH>
                <TH scope="col">Size</TH>
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
                  onRunAlone={setLaunchPhase}
                  entry={queueEntryFor(queue, slug, p.phase)}
                  conflicts={scopes?.find((s) => s.phase === p.phase)?.conflicts}
                  eta={phaseEta?.find((e) => e.phase === p.phase)}
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

      {launchPhase != null && (
        <LaunchDialog
          request={{
            kind: 'phase',
            slug,
            phase: launchPhase,
            run,
            // The claim, so the dialog refuses rather than submitting into a
            // 409 the server would answer anyway.
            ...(() => {
              const lock = rows.find((r) => r.phase === launchPhase)?.lock;
              return lock ? { lock } : {};
            })(),
            ...(recovery?.qaMode ? { qaMode: recovery.qaMode } : {}),
            ...(recovery?.allowWrites !== undefined ? { allowWrites: recovery.allowWrites } : {}),
            ...(recovery?.planSkills?.length ? { planSkills: recovery.planSkills } : {}),
          }}
          onClose={() => setLaunchPhase(null)}
        />
      )}
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
  onRunAlone,
  entry,
  conflicts,
  eta,
}: {
  phase: MergedPhase;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  recovery?: PhaseRecovery;
  /** Opens the launch dialog scoped to this phase. */
  onRunAlone: (phase: number) => void;
  entry?: QueueEntry | undefined;
  conflicts?: string[] | undefined;
  eta?: PhaseEta | undefined;
}) {
  const r = p.record;
  // Gated on the BOARD, never on the run record. Offering to run a phase the
  // board calls done is the defect this table was rebuilt for.
  const can = actionsFor(p, { live, allowRun });
  const detoured = fellOver(r);
  const hasNote = Boolean(
    r?.note || r?.verification || r?.preflight?.length || r?.mcpDegraded?.length || can.diagnose,
  );

  // What the two start-work buttons would have offered if nothing held the
  // phase — so they can be rendered disabled rather than disappearing.
  const blockedRunAlone = Boolean(can.heldBy) && !live && p.state === 'ready' && allowRun;
  const blockedRetry = Boolean(can.heldBy) && !live
    && ['failed', 'interrupted', 'parked', 'gated'].includes(r?.status ?? '');
  const heldTitle = can.heldBy
    ? `Phase ${p.phase} is claimed by ${can.heldBy.owner}`
      + (can.heldBy.host ? ` on ${can.heldBy.host}` : '')
      + `${can.heldBy.leaseUntil ? ` — the lease runs ${countdown(can.heldBy.leaseUntil)} more` : ''}.`
      + ' Release the claim to start a session here.'
    : undefined;

  // A recovery is offered for a phase that is genuinely stuck — never for one
  // the BOARD calls done, however this run's record reads, and never while the
  // run is live (the autopilot owns the tree, and the server refuses anyway).
  // A stuck phase (its handoff says blocked) often has NO record on this run —
  // the work happened in another session — so the board state is the fallback
  // fact when the record has nothing to say.
  const recoveryClass = recovery && !live && p.state !== 'done'
    ? (r ? classifyPhase(r.status, run, { authFailure: recovery.authFailure ?? false }) : undefined)
      ?? classifyBoardPhase(p.state)
    : undefined;
  const recovering = liveRecovery(recovery?.sessions, { slug, phase: p.phase });
  const reviewing = liveQa(recovery?.sessions, { slug, phase: p.phase });

  // A session of THIS run is open on this phase. `startedAt` with no `endedAt`
  // is the record's own account; `live` is the console's, and both have to hold
  // — a checkpoint left by a killed console has the first and not the second.
  const running = live && Boolean(r?.startedAt) && !r?.endedAt
    && (r?.status === 'running' || r?.status === 'verifying');
  const showing = displayState(p.state, { running });
  // The record is what THIS run is doing; the entry is the scheduler's own view.
  // Either alone is enough to say the phase is in a line.
  const queued = r?.status === 'queued' || Boolean(entry);
  const now = useNow(running);
  const runningMs = running && r?.startedAt ? now - Date.parse(r.startedAt) : 0;

  return (
    <>
      <TR className={cn(running && 'bg-progress/8', p.state === 'done' && 'text-ink-faint')}>
        <TD className="font-mono tabular-nums">{pad2(p.phase)}</TD>
        <TD>
          <a className="underline-offset-2 hover:underline" href={phaseHref(slug, p.phase)}>
            {p.title}
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {p.gated && <Chip tone="gate" title={boardStateTitle('gated')}>gated</Chip>}
            {/* The row's own record, not the mirror pointer: with two lanes
                live, `activePhase` names only the lowest one. */}
            {running && <Chip tone="busy">running now</Chip>}
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
          {/* "Queued" alone is the same non-answer `pausing` used to be. What
              makes the wait bearable is WHAT it is behind, and that is the one
              thing the payload exists to carry. */}
          {queued && (
            <div className="mt-0.5">
              <Chip
                tone="busy"
                title={entry?.waitingOn.length
                  ? entry.waitingOn
                    .map((h) => `${h.slug}${h.phase != null ? ` P${h.phase}` : ''}`
                      + (h.overlaps.length ? ` — overlaps ${h.overlaps.join(', ')}` : ''))
                    .join('\n')
                  : 'Waiting on the scheduler for a scope something else is holding'}
              >
                {waitingLabel(entry)}
              </Chip>
            </div>
          )}
        </TD>
        <TD><DepsCell slug={slug} phase={p} /></TD>
        <TD><LockCell lock={p.lock} compact /></TD>
        <TD>
          <ScopeChips tokens={scopeOf(p.row?.repos)} conflicts={conflicts} />
        </TD>
        <TD><SizeCell phase={p} eta={eta} /></TD>
        <TD className="text-2xs">
          {r ? (
            <>
              <Chip tone={PHASE_TONE[r.status]} title={phaseStatusTitle(r.status)}>{r.status}</Chip>
              {/* Same icon vocabulary as the header's Model tile — what a row
                  ran as should not be the smallest, least-scannable text on it. */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-faint">
                <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
                  <Bot size={11} aria-hidden className="shrink-0" />
                  {r.model ?? '—'}
                </span>
                {r.effort && (
                  <span className="inline-flex items-center gap-1">
                    <Gauge size={11} aria-hidden className="shrink-0" />
                    {r.effort}
                  </span>
                )}
                {r.attempts > 1 && <span>{r.attempts} tries</span>}
              </div>
              {detoured && (
                <div
                  className="text-ink-faint"
                  title="the session fell over to another model without restarting"
                >
                  ran on {r.actualModel}
                </div>
              )}
              {/* Which attached servers this phase actually reached for — the
                  only honest answer to "was attaching that worth it". A zero is
                  the interesting number: it was paid for on every turn and
                  never used. */}
              {r.mcpCalls && Object.keys(r.mcpCalls).length > 0 && (
                <div className="text-2xs text-ink-faint">
                  mcp {Object.entries(r.mcpCalls)
                    .map(([id, calls]) => `${id} ×${calls}`)
                    .join(' · ')}
                </div>
              )}
            </>
          ) : (
            <span className="text-ink-faint">not attempted</span>
          )}
        </TD>
        <TD className="text-right font-mono tabular-nums">{r?.costUsd ? money(r.costUsd) : '—'}</TD>
        <TD className="text-right font-mono tabular-nums">{r?.turns ?? '—'}</TD>
        {/* Three different questions, so three different answers. A finished
            phase wants the wall clock it took. A RUNNING one wants the stopwatch
            against what it was expected to take — the figure that turns "it has
            been 40 minutes" into "and that is about right" or "and that is
            twice as long". One not yet attempted wants the estimate alone. */}
        <TD className="text-right font-mono tabular-nums">
          {r?.durationMs
            ? duration(r.durationMs)
            : running
              ? (
                <span title={eta ? `Phase ${p.phase} was expected to take about ${eta.label.replace('~', '')}.` : undefined}>
                  {elapsed(runningMs)}
                  {eta && <span className="text-ink-faint"> / {phaseProgress(runningMs, eta.estMs)}</span>}
                </span>
              )
              : eta
                ? <span className="text-ink-faint" title={`An estimate for phase ${p.phase}, not a measurement.`}>{eta.label}</span>
                : '—'}
        </TD>
        <TD>
          <div className="flex flex-wrap items-center gap-1">
            {/* The one thing a failed-HERE-finished-ELSEWHERE row still owes:
                the statement that nothing needs fixing. A red chip beside an
                empty actions cell read as a dead end (reported live). */}
            {p.elsewhere && r && ['failed', 'interrupted', 'parked', 'gated'].includes(r.status) && (
              <span
                className="text-2xs text-ink-faint"
                title={'This run\'s own attempt stopped'
                  + (r.note ? ` (${r.note.slice(0, 160)})` : '')
                  + ' — but the phase was finished and verified outside it, and the board reads done.'
                  + ' There is nothing to fix; Why? opens what failed here.'}
              >
                nothing to fix — done elsewhere
              </span>
            )}
            {/* Disabled, not hidden. A button that vanishes when a phase is
                claimed teaches nothing about why nothing can be started — the
                whole complaint that put a Lock column on this table. It stays
                in place, greyed, and says who holds it. */}
            {(can.retry || (blockedRetry && allowRun)) && (
              <Button size="sm"
                disabled={!can.retry}
                title={can.retry
                  ? "Clears this phase's failure and CONTINUES the run from here — a session starts, under normal admission."
                  : heldTitle}
                onClick={() => void onAct('retry', () => api.runRetry(slug, p.phase))}>
                Retry
              </Button>
            )}
            {can.skip && (
              <Button size="sm" onClick={() => void onAct('skip', () => api.runSkip(slug, p.phase))}>
                Skip
              </Button>
            )}
            {(can.runAlone || blockedRunAlone) && (
              <Button
                size="sm"
                disabled={!can.runAlone}
                title={can.runAlone
                  ? 'Run this phase on its own, then stop — the loop does not carry on into the rest of the plan'
                  : heldTitle}
                onClick={() => onRunAlone(p.phase)}
              >
                Run only this
              </Button>
            )}
            {/* The way out, right where the refusal is. Releasing a live claim
                is the operator's decision and asks for it explicitly. */}
            {can.heldBy && allowRun && (
              <ForceReleaseButton slug={slug} phase={p.phase} lock={can.heldBy} />
            )}
            {/* Last, and only when a rule cannot settle it. Retry re-runs the
                phase unchanged and Skip abandons it; this is the middle that
                was missing — read the evidence, fix the cause, finish. */}
            {recoveryClass && recovery && (
              <RecoveryButton
                kind={recoveryClass}
                allowAgent={recovery.allowAgent}
                {...(recovering ? { runningSessionId: recovering.id } : {})}
                target={{ slug, phase: p.phase, ...(run?.id ? { runId: run.id } : {}) }}
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

      {/* Always rendered now: the note half is conditional as before, and the
          disclosure below it is the answer to "put every field in the table" —
          a row carries the eight facts you scan, and the other twenty live one
          click away rather than in twenty more columns. */}
      <TR>
        <TD />
        <TD colSpan={11}>
          <>
            {r?.note && <div className="text-2xs text-ink-faint">{r.note}</div>}
            {r?.status === 'waiting' && (
              // A declared external wait: what it waits on, when the runner
              // resumes the phase's own session, and which round of waiting
              // this is (the runner caps them).
              <div className="text-2xs text-ink-faint">
                Waiting on external work{r.parkReason ? `: ${r.parkReason}` : ''}
                {r.parkedUntil ? ` — resumes ${new Date(r.parkedUntil).toLocaleTimeString()}` : ''}
                {r.waits ? ` (wait ${r.waits})` : ''}
                {r.watch?.length ? (
                  <>
                    {' '}· watching <code className="font-mono">{r.watch.join(', ')}</code>
                  </>
                ) : null}
              </div>
            )}
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
            {r?.preflight?.length ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs text-gated">
                  {r.preflight.length} verification warning{r.preflight.length === 1 ? '' : 's'} from boarding
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
                  {r.preflight.map((warning, i) => <li key={i}>{warning}</li>)}
                </ul>
              </details>
            ) : null}
            {r?.mcpDegraded?.length ? (
              // Not a `<details>`: a phase that quietly did without half its
              // tools and a phase that had all of them look identical in the
              // handoff afterwards, so this one stays open. The errand is the
              // operator's, and it is the same errand every time.
              <p className="mt-1 text-2xs text-gated">
                Ran without {r.mcpDegraded.map((d) => `${d.id} (${d.detail ?? MCP_REASON[d.reason]})`).join(', ')}
                {' — '}the session was told to record what it could not do.
              </p>
            ) : null}
            {can.diagnose && (
              <PhaseDiagnosis slug={slug} phase={p.phase} run={run} />
            )}
            <details className={cn('group', hasNote && 'mt-1')}>
              <summary className="cursor-pointer text-2xs text-ink-faint hover:text-ink-muted">
                Everything about phase {p.phase}
              </summary>
              <div className="mt-2 max-w-prose">
                <PhaseDetails slug={slug} phase={p} eta={eta} />
              </div>
            </details>
          </>
        </TD>
      </TR>
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
/**
 * One click: this exact recorded command, in YOUR shell (aliases and all — the
 * rg-is-a-function case is why the runner could not run it), in the phase's
 * own directory, in the integrated terminal. The exit code reflects back onto
 * the phase record the moment the session ends — green settles the phase via
 * the normal re-check, red lands as evidence with its output.
 */
function VerifyInTerminalButton({ slug, phase, command }: {
  slug: string; phase: number; command: string;
}) {
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState(false);
  const allowed = Boolean(state?.allowTerminal);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!allowed || busy}
      title={allowed
        ? 'Runs exactly this recorded command in the integrated terminal — your shell, the '
          + "phase's own directory. The exit code is written back onto this phase when it ends; "
          + 'if everything reads green, the phase re-checks itself.'
        : 'The terminal is disabled. Restart the console with --allow-terminal.'}
      onClick={() => {
        setBusy(true);
        void api.runVerifyCommand(slug, phase, command)
          .then((minted) => navigate(`terminal/${minted.sessionId}`))
          .catch((error: unknown) => toast((error as Error).message, 'error'))
          .finally(() => setBusy(false));
      }}
    >
      <TerminalSquare size={12} aria-hidden /> {busy ? 'Opening…' : 'Run in terminal'}
    </Button>
  );
}

function PhaseDiagnosis({
  slug,
  phase,
  run,
}: {
  slug: string;
  phase: number;
  /** Kind-aware ordering: the halt's kind decides which action leads. */
  run?: RunState | null;
}) {
  const [open, setOpen] = useState(false);
  const { data, error, isFetching } = useDiagnosis(slug, phase, open);

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
            {data.verifiedIn && (
              <>
                {/* Which directory the commands ran in. A suite that passed in
                    the wrong one looks exactly like a suite that passed. */}
                <dt className="text-ink-faint">Verified in</dt>
                <dd>
                  <code className="font-mono">{data.verifiedIn}</code>
                  {data.verifiedIn === '.' ? ' (the repository root)' : ''}
                </dd>
              </>
            )}
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
                  <div className="flex flex-wrap items-center gap-2 text-2xs">
                    <code className="min-w-0 font-mono">{x.command}</code>
                    <span className="text-ink-faint">exited {x.code}</span>
                    {x.via === 'terminal' && (
                      <Chip title="This result came from you running it in the integrated terminal.">
                        ran in your terminal
                      </Chip>
                    )}
                    <VerifyInTerminalButton slug={slug} phase={phase} command={x.command} />
                  </div>
                  <pre className={pre}>{x.output || '(no output)'}</pre>
                </div>
              ))}
            </div>
          )}

          {(data.verification?.skipped?.length ?? 0) > 0 && (
            <div>
              <div className="text-2xs">
                <b>Skipped — this machine cannot run them:</b>
              </div>
              {data.verification!.skipped!.map((x, i) => (
                <div key={i} className="mt-1 flex flex-wrap items-center gap-2 text-2xs">
                  <code className="min-w-0 font-mono">{x.command}</code>
                  <span className="text-ink-faint">{x.reason}</span>
                  <VerifyInTerminalButton slug={slug} phase={phase} command={x.command} />
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

          {/* Every way forward, from the one shared model — the agent path
              included, which this panel never offered before. Blurbs render as
              visible text: this is the read-the-evidence surface. */}
          <RecoveryActions
            target={{ slug, phase, ...(run?.id ? { runId: run.id } : {}) }}
            ctx={{
              ...(run ? { run } : {}),
              record: { status: data.status, resumable: data.resumable },
            }}
            max={3}
            showBlurbs
            legend
          />
        </div>
      )}
    </details>
  );
}
