/**
 * One session, one set of panes — the client half of the runner pool.
 *
 * ## What was wrong
 *
 * The console, the task list and the tool log were written when a console drove
 * one `claude -p` at a time, so "the session" was a definite article and every
 * `run:stream` on the wire belonged to it. Phase 4 made a run drive several
 * disjoint-scope phases at once, and several plans run beside each other. The
 * subscription did not change, so all of it landed in one window: two sessions'
 * sentences spliced into one paragraph, one task list overwritten by another
 * phase's, and a tool log in which "what is still running" was the union of two
 * unrelated things. Nothing errors when this happens, which is what makes it bad
 * — the page looks right and reads as a single confused session.
 *
 * ## What this is
 *
 * A `SessionPanes` is the console + panels + ask box for exactly one
 * `(runId, phase)` pair, owning its own `useLiveLines` so that two of them
 * cannot share a buffer. The filtering is `useSessionStream`'s (see
 * `console.tsx`) and it is a predicate over fields the payloads have always
 * carried — this is a narrowing of what an existing stream means, not a new one.
 *
 * The run-level pane is the same component with no `phase`: every lane of one
 * run, which is what the page showed before and still the right reading of "what
 * is this run saying".
 *
 * ## Panes stay mounted
 *
 * Tabs render these with `forceMount`. An unmounted pane drops its subscription,
 * so a glance at another lane would cost every line the first one printed while
 * you were away — and the replay endpoint could not fill the gap, because it is
 * fetched once and the missing lines are newer than it. Three consoles' worth of
 * hidden DOM is the cheaper half of that trade.
 */

import { useEffect, type ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Chip } from '@/components/ui';
import { useTranscript } from '@/lib/queries';
import { elapsed } from '@/lib/format';
import { useNow } from '@/lib/clock';
import type { PhaseStatus, QueueEntry, RunState } from '@/lib/api';
import { ActivityPanels } from './activity';
import { AskBox } from './ask-box';
import { LiveConsole, forPhase, useLiveLines, useSessionStream } from './console';

/**
 * Phase records that deserve a pane of their own.
 *
 * Read off `phases`, not `children`: a queued lane has no child by definition —
 * that is what queued means — and it is the one people most need to see, because
 * it is the one that looks like nothing is happening.
 *
 * `awaiting-verification` has no live session either, and belongs for the
 * opposite reason: the session is gone and its last words are the evidence
 * somebody is about to be asked to judge.
 */
export const PANE_STATUSES: readonly PhaseStatus[] = [
  'running',
  'verifying',
  'awaiting-verification',
  'queued',
];

export interface Lane {
  slug: string;
  runId: string;
  phase: number;
  status: PhaseStatus;
  /** No session to watch yet — the pane shows what it is waiting on instead. */
  queued: boolean;
}

/**
 * Every lane of one run, lowest phase first.
 *
 * Ordered by phase rather than by when each started, because tab order that
 * reshuffles as lanes come and go is a worse trade than a stable one: the tab you
 * were reading has to still be where you left it.
 */
export function lanesOf(run: RunState | null | undefined): Lane[] {
  if (!run) return [];
  const wanted = new Set<string>(PANE_STATUSES);
  return Object.values(run.phases ?? {})
    .filter((record) => wanted.has(record.status))
    .sort((a, b) => a.phase - b.phase)
    .map((record) => ({
      slug: run.slug,
      runId: run.id,
      phase: record.phase,
      status: record.status,
      queued: record.status === 'queued',
    }));
}

/** Every lane of every run, for the page that is about all of them at once. */
export function lanesAcross(runs: readonly RunState[] | undefined): Lane[] {
  return (runs ?? []).flatMap((run) => lanesOf(run));
}

/** The tab id for a lane. `p<N>` — in-page state only, never a route. */
export const laneId = (lane: Lane): string => `p${lane.phase}`;

/**
 * Which tab the strip shows: the explicit pick while it still exists, else the
 * SOLE live lane, else Run.
 *
 * The solo default is the point: with exactly one live lane — still the common
 * case — the operator came to watch that session, and opening on the aggregate
 * Run tab put narration where their session's text should be. A pick that
 * outlived its lane falls back the same way (Radix renders a missing panel as
 * nothing at all).
 */
export function resolveTab(picked: string | null, lanes: readonly Lane[]): string {
  const ids = new Set(['run', ...lanes.map(laneId)]);
  if (picked && ids.has(picked)) return picked;
  return lanes.length === 1 ? laneId(lanes[0]) : 'run';
}

/** The tab id for a lane on the cross-plan page, where phase numbers repeat. */
export const crossLaneId = (lane: Lane): string => `${lane.slug}:p${lane.phase}`;

export function SessionPanes({
  slug,
  runId,
  phase,
  live,
  allowRun,
  enabled = true,
  title,
  subtitle,
  askPhase,
  runLevel = false,
  control,
}: {
  slug: string;
  runId: string;
  /** Omitted for the run-level pane: every lane of this run. */
  phase?: number | undefined;
  live: boolean;
  allowRun: boolean;
  enabled?: boolean;
  title?: string;
  subtitle?: string;
  /**
   * Which phase the ask box talks to, when that is not this pane's own.
   *
   * The run-level pane has no phase of its own and still needs to reach whatever
   * is running — which is the behaviour the page had before there were lanes.
   */
  askPhase?: number | null;
  /**
   * The Run tab: the runner's own narration (phase transitions, verify
   * commands), with the session firehose and the task/tool panels left to the
   * lanes that own them. Unfiltered, two live lanes spliced their sentences
   * into one paragraph here, and `activity()`'s reset-on-running meant phase 7
   * starting WIPED phase 6's still-live task list — the cross-phase bleed this
   * page was reported for. A finished run's replay pane deliberately does NOT
   * set this: reading history whole is what a replay is for.
   */
  runLevel?: boolean;
  /** Per-session controls (freeze/stop), rendered in the console's toolbar. */
  control?: ReactNode;
}) {
  const { lines, activity, record, clear, hydrate } = useLiveLines();

  // One transcript per RUN, shared by every pane of it through the query cache,
  // and filtered per lane in the client. Splitting it server-side would mean a
  // fetch per tab of a payload that is already the largest thing this console
  // reads, to save a single pass over an array it holds anyway.
  const { data: transcript } = useTranscript(slug, runId, enabled);
  useEffect(() => {
    hydrate(
      runLevel ? (transcript ?? []).filter((entry) => entry.event !== 'stream') : forPhase(transcript, phase),
    );
  }, [transcript, phase, hydrate, runLevel]);

  useSessionStream(record, enabled, { runId, phase, omitStream: runLevel });

  const target = askPhase === undefined ? phase : askPhase;

  return (
    <div className="flex flex-col gap-3">
      <LiveConsole
        lines={lines}
        onClear={clear}
        title={title ?? (phase != null ? `Phase ${phase} console` : 'Session console')}
        {...(control ? { actions: control } : {})}
        {...(subtitle ? { subtitle } : {})}
        footer={
          <AskBox
            slug={slug}
            enabled={Boolean(allowRun && live && target != null)}
            allowRun={allowRun}
            phase={target}
          />
        }
      />
      {runLevel ? (
        <p className="text-2xs text-ink-faint">
          Each phase&rsquo;s session text, task list and tool calls live in its own tab.
        </p>
      ) : (
        <ActivityPanels activity={activity} live={live} />
      )}
    </div>
  );
}

/**
 * A lane that has not started, and the honest answer to why.
 *
 * "Queued" on its own is the same non-answer `pausing` used to be — it names the
 * state and withholds the only fact that makes it bearable, which is *what it is
 * behind and how long it has been there*. `waitingOn` is the point of the whole
 * payload: every holder is named, with the tokens that actually collided, so the
 * wait is attributable to a specific phase of a specific plan rather than to the
 * console being slow.
 */
export function QueuedPane({
  phase,
  entry,
  scope,
  control,
}: {
  phase: number;
  entry?: QueueEntry | undefined;
  scope?: readonly string[] | undefined;
  /** A stop control that dequeues this phase, when the parent offers one. */
  control?: ReactNode;
}) {
  // The clock ticks for the same reason the run header's does: a wait that shows
  // a frozen "2m" is indistinguishable from a page that has died, and this is
  // precisely the screen somebody is staring at wondering exactly that.
  const now = useNow(true);
  const wanted = entry?.scope ?? scope ?? [];
  const holders = entry?.waitingOn ?? [];

  return (
    <Card>
      <CardHeader className="flex-wrap items-center">
        <CardTitle>Phase {phase} is queued</CardTitle>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="busy">queued</Chip>
          {entry && (
            <span className="font-mono text-2xs text-ink-faint tabular-nums">
              {elapsed(Math.max(0, now - entry.since))}
            </span>
          )}
          {control}
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="max-w-prose text-2xs text-ink-faint">
          Nothing has been spawned and no lock is held — this phase is in a line for a scope something else is
          working in, and it starts itself the moment that clears.
        </p>

        {wanted.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-ink-faint">Wants</span>
            {wanted.map((token) => (
              <Chip key={token}>{token}</Chip>
            ))}
          </div>
        )}

        {holders.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs text-ink-faint">Waiting on</span>
            <ul className="flex flex-col gap-1">
              {holders.map((holder, i) => (
                <li key={`${holder.slug}-${holder.phase}-${i}`} className="text-2xs">
                  <b>{holderLabel(holder.kind, holder.slug, holder.phase)}</b>
                  {holder.owner && <span className="text-ink-faint"> · {holder.owner}</span>}
                  {holder.overlaps.length > 0 && (
                    <span className="text-ink-faint">
                      {' '}
                      · overlaps <code className="font-mono">{holder.overlaps.join(', ')}</code>
                    </span>
                  )}
                  {holder.kind === 'lock' && holder.leaseUntil != null && (
                    // The lease is the holder's promise to lapse — the honest
                    // answer to "how long can this possibly block me".
                    <span className="text-ink-faint">
                      {' '}
                      · lease ends {new Date(holder.leaseUntil).toLocaleTimeString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-2xs text-ink-faint">
            {entry
              ? 'Admitted, and the scheduler has not named a holder — it is next.'
              : 'The scheduler has not answered yet.'}
          </p>
        )}

        {entry?.bypassed ? (
          <p className="text-2xs text-ink-faint">
            Passed over {entry.bypassed} time(s) by a phase that could run. After enough of those it reserves
            its tokens and nothing else may take them.
          </p>
        ) : null}
        {entry?.reserving ? (
          <p className="text-2xs text-ink-faint">
            Now reserving its scope: nothing new may take these tokens until this phase has had them.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Who is holding it, in the three ways something can be held.
 *
 * `reserved` is not a plan at all — it is the scheduler reporting one of the two
 * non-scope blocks (the session cap, or an account usage window) through the same
 * shape, so that a queue card never has to say "queued" with nothing after it.
 */
export function holderLabel(kind: string, slug: string, phase: number | null): string {
  if (kind === 'reserved') return slug;
  const where = phase != null ? `${slug} P${phase}` : slug;
  return kind === 'lock' ? `${where} (lock)` : where;
}

/**
 * The one-line version, for a table cell: what this phase is waiting on.
 *
 * Same reading as the card, and deliberately the same function feeding both — a
 * chip that disagreed with the pane beside it would be worse than no chip.
 */
export function waitingLabel(entry: QueueEntry | undefined): string {
  const first = entry?.waitingOn?.[0];
  if (!first) return 'queued';
  const rest = (entry?.waitingOn.length ?? 0) - 1;
  return (
    `queued — waiting on ${holderLabel(first.kind, first.slug, first.phase)}` + (rest > 0 ? ` +${rest}` : '')
  );
}

/** This plan's entry in the admission queue for one phase, if it has one. */
export function queueEntryFor(
  entries: readonly QueueEntry[] | undefined,
  slug: string,
  phase: number,
): QueueEntry | undefined {
  return (entries ?? []).find((entry) => entry.slug === slug && entry.phase === phase);
}
