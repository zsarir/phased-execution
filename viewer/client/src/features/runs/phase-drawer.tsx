/**
 * The phase drawer: why a phase is where it is, and what moves it.
 *
 * One panel, opened from a row, that answers the question a status word never
 * could — "why is this not done?" — from what is already on disk: the board's
 * word, the §Verification output, the lint summary, the session's own closing
 * words, the working tree, the lock, the classifier's situation and the
 * evidence it read, the rulings this phase recorded, and the ways forward.
 *
 * ## It is fetched, not threaded
 *
 * `GET /api/run/:slug/diagnosis/:phase` costs a `git status` and two script
 * runs, so it is asked for only when the drawer is OPENED — most rows are
 * never opened. That is also why the diagnosis has its own query key outside
 * the `['run', slug]` prefix: under it, every `run:phase` event would re-run
 * those subprocesses for every row somebody had expanded.
 *
 * ## Phase 9 reuses this
 *
 * The plan page's Phases tab renders the same drawer against the same
 * endpoint, which is why this is its own module with a `slug`/`phase`/`run`
 * signature and no run-page state in it. Anything the run page needs and the
 * plan page does not belongs on the ROW, not in here.
 *
 * `rulings` is the one section that is not about a defect: a session's
 * judgement call is the thing the next session most needs, and before Phase 7
 * it existed only in a ledger file nothing rendered.
 */

import { useState } from 'react';
import { Button, Chip, toast } from '@/components/ui';
import { api, type Ruling, type RulingKind, type RunState } from '@/lib/api';
import { useConsoleState, useDiagnosis, useRulings } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { SituationSummary } from '@/components/situation';
import { navigate } from '@/app/router';
import { TerminalSquare } from 'lucide-react';
import { RecoveryActions } from '@/components/recovery-actions';
import { EvidenceLine } from './phase-row';
import { PhaseGate } from '@/features/plans/gate-card';
import { RULING_KIND_LABELS, inboxItemId } from '@shared/attention-model.js';

/**
 * The labels and the id rule both come from `shared/attention-model.js`.
 *
 * A second copy of either would break silently the day the module changed —
 * the labels would drift from the inbox row's, and a hand-built id would stop
 * matching the one the ack route parses. The id is five escaped parts; nothing
 * outside that module is allowed to know the escaping.
 */
const RULING_LABEL = RULING_KIND_LABELS as Record<RulingKind, string>;

/** The inbox id for a ruling row — exactly what `server/inbox.ts` mints for it. */
const rulingItemId = (ruling: Ruling): string =>
  (inboxItemId as (item: Record<string, unknown>) => string)({
    kind: 'ruling',
    slug: ruling.slug,
    phase: ruling.phase,
    subject: ruling.id,
  });

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
function VerifyInTerminalButton({ slug, phase, command }: { slug: string; phase: number; command: string }) {
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState(false);
  const allowed = Boolean(state?.allowTerminal);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!allowed || busy}
      title={
        allowed
          ? 'Runs exactly this recorded command in the integrated terminal — your shell, the ' +
            "phase's own directory. The exit code is written back onto this phase when it ends; " +
            'if everything reads green, the phase re-checks itself.'
          : 'The terminal is disabled. Restart the console with --allow-terminal.'
      }
      onClick={() => {
        setBusy(true);
        void api
          .runVerifyCommand(slug, phase, command)
          .then((minted) => navigate(`sessions/${minted.sessionId}`))
          .catch((error: unknown) => toast((error as Error).message, 'error'))
          .finally(() => setBusy(false));
      }}
    >
      <TerminalSquare size={12} aria-hidden /> {busy ? 'Opening…' : 'Run in terminal'}
    </Button>
  );
}

export function PhaseDrawer({
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
  // The ledger is per PLAN and cheap (one file read), so it is asked for
  // alongside the diagnosis rather than folded into it — and it answers for a
  // phase with no run record at all, which the diagnosis cannot.
  const { data: ledger } = useRulings(slug, open);
  const rulings = (ledger?.rulings ?? []).filter((ruling) => ruling.phase === phase);

  const failed = (data?.verification?.ran ?? []).filter((x) => !x.ok);
  const pre =
    'mt-1 max-h-56 overflow-auto rounded border border-rule bg-ground px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap';

  return (
    <details className="mt-1.5" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-2xs">
        Why is this not done?
        {rulings.length > 0 && (
          <span className="ml-1.5 font-mono text-ink-faint tabular-nums">
            {rulings.length} ruling{rulings.length === 1 ? '' : 's'}
          </span>
        )}
      </summary>

      {error && <div className="mt-1 text-2xs text-blocked">{(error as Error).message}</div>}
      {!data && !error && isFetching && <div className="mt-1 text-2xs text-ink-faint">Reading the run…</div>}

      {data && (
        <div className="mt-2 flex flex-col gap-2">
          {/* What the healer reads first: the situation, why, and the evidence.
              A panel that showed four unrelated fields and left the reader to
              infer the diagnosis is what sent people to NDJSON. */}
          <SituationSummary situation={data.situation} evidence={data.evidence} />

          {/* The gate, answerable here. A phase parked on a human gate is the
              one halt whose fix is a person pressing a button, and until this
              it was the one halt you had to leave the run page to clear — the
              errand said "approve it on the plan page" because there was
              nowhere nearer to say. Renders nothing when there is no gate. */}
          <PhaseGate slug={slug} phase={phase} />

          {/* Claimed versus evidenced. The board says a phase is done; this is
              the four facts that either back it or do not, in the words
              `shared/evidence-model.js` chose — `evidenced`, never `done`. */}
          {data.proof && <EvidenceLine proof={data.proof} verbose />}
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

          {rulings.length > 0 && <RulingList slug={slug} rulings={rulings} />}

          {/* Every way forward, from the one shared model — the agent path
              included, which this panel never offered before. Blurbs render as
              visible text: this is the read-the-evidence surface. */}
          <RecoveryActions
            target={{ slug, phase, ...(run?.id ? { runId: run.id } : {}) }}
            ctx={{
              ...(run ? { run } : {}),
              record: { status: data.status, resumable: data.resumable },
              ...(data.situation
                ? {
                    situation: {
                      id: data.situation.id,
                      ...(data.situation.sub ? { sub: data.situation.sub } : {}),
                    },
                  }
                : {}),
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

/**
 * What the sessions on this phase DECIDED, oldest first.
 *
 * Not a defect list and not an action list: nothing acts on a ruling, which is
 * the property that makes it safe for a session to record one whenever it is
 * in doubt. `costIfWrong` is the field that makes one worth reading, so it is
 * rendered even though most rulings do not carry it.
 *
 * Acking is an ANNOTATION — it appends a line to the ledger and hides the
 * inbox row; the ruling itself is never resolved, because a decision does not
 * stop having been made.
 */
function RulingList({ slug, rulings }: { slug: string; rulings: readonly Ruling[] }) {
  return (
    <section className="rounded border border-rule bg-ground px-2 py-1.5">
      <h4 className="text-2xs font-semibold text-ink">
        Decisions the plan did not make for it
        <span className="ml-1.5 font-normal text-ink-faint">
          — recorded by the sessions that ran this phase
        </span>
      </h4>
      <ul className="mt-1.5 flex flex-col gap-2">
        {rulings.map((ruling) => (
          <li key={ruling.id} className="text-2xs">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <Chip tone={ruling.kind === 'deviation' ? 'warn' : 'muted'}>
                {RULING_LABEL[ruling.kind] ?? ruling.kind}
              </Chip>
              <span className="text-ink-faint">{relativeTime(Date.parse(ruling.at))}</span>
              {ruling.ack ? (
                <span className="text-ink-faint">seen</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5"
                  onClick={() => {
                    void api
                      .inboxAck(rulingItemId(ruling))
                      .then(() => toast('Marked as seen — the ruling itself stays', 'ok'))
                      .catch((error: Error) => toast(error.message, 'error'));
                  }}
                >
                  Mark seen
                </Button>
              )}
            </div>
            <p className="mt-0.5 text-ink">{ruling.what}</p>
            {ruling.why && <p className="mt-0.5 text-ink-muted">Why: {ruling.why}</p>}
            {ruling.costIfWrong && (
              <p className="mt-0.5 text-ink-muted">If this was wrong: {ruling.costIfWrong}</p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-2xs text-ink-faint">
        Every ruling for {slug} is in the ledger, including phases nobody is looking at.
      </p>
    </section>
  );
}
