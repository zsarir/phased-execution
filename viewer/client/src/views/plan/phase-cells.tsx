import type { ReactNode } from 'react';
import { MarkdownInline, plainText } from '@/components/markdown';
import { QaVerdict } from '@/components/qa-launcher';
import { ScopeChips } from '@/components/scope-chips';
import { Chip, KeyValue, StateChip } from '@/components/ui';
import type { PhaseEta, PhaseLock, PhaseView } from '@/lib/api';
import { countdown, pad2, relativeTime, weight } from '@/lib/format';
import { boardStateTitle, lockTitle } from '@/lib/status-vocab';
import { phaseHref } from '@shared/routes.js';
import { scopeOfRow } from '@shared/scope.js';

/**
 * The cells every phase table is built from.
 *
 * There were four tables rendering the same phase and disagreeing about it: the
 * Departures board printed Repos as a raw string while the other two used
 * `ScopeChips`; dependencies were rendered richly on the phase panel, as a
 * comma-joined string on Overview, only-when-waiting on the board, and nowhere
 * at all in Autopilot; and the lock — the one fact that decides whether a phase
 * may be started — was on every row of the Autopilot table and read by none of
 * them. Four surfaces cannot be kept honest by four sets of JSX, so a cell is a
 * component here and the tables only choose which ones to show.
 *
 * Everything below is presentation over data already on the wire. Nothing here
 * fetches, and nothing here decides what may run — that is `phaseActions`, so
 * the answer is the same for a table, a dialog and the server.
 */

/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
const scopeOf = scopeOfRow as (cell: string | undefined) => string[];

/* ---------------- the lock ---------------- */

/**
 * Who holds a phase, and for how much longer.
 *
 * One component for a fact that was previously spelled three ways and omitted
 * in four places. The owner is in the chip rather than behind a `title`: a
 * claim you cannot attribute without hovering is a claim you cannot act on,
 * and on a phone there is no hover at all.
 *
 * A lapsed lease reads `stale claim`, never `locked` — the difference decides
 * whether the console blocks you or merely warns you, so the two must never
 * paint alike.
 */
export function LockChip({ lock, compact = false }: { lock?: PhaseLock; compact?: boolean }) {
  if (!lock) return null;
  const left = countdown(lock.leaseUntil);
  const title = lockTitle(lock.expired ? 'stale' : 'live')
    + `\n\n${lock.owner}${lock.host ? ` on ${lock.host}` : ''}`
    + (lock.claimedAt ? `\nclaimed ${relativeTime(lock.claimedAt)}` : '')
    + (lock.scope?.length ? `\nscope: ${lock.scope.join(', ')}` : '');

  if (lock.expired) {
    return <Chip tone="warn" title={title}>stale claim{compact ? '' : ` · ${lock.owner}`}</Chip>;
  }
  return (
    <Chip tone="busy" title={title}>
      held{compact ? '' : ` by ${lock.owner}`}{left && left !== '—' ? ` · ${left}` : ''}
    </Chip>
  );
}

/** The Lock column — a chip, or the honest blank that means nobody holds this. */
export function LockCell({ lock, compact }: { lock?: PhaseLock; compact?: boolean }) {
  if (!lock) return <span className="text-2xs text-ink-faint">—</span>;
  return <LockChip lock={lock} compact={compact} />;
}

/* ---------------- dependencies ---------------- */

/** A phase number as a chip-sized link — every dependency edge is one of these. */
export function PhaseLink({
  slug, phase, suffix, title,
}: { slug: string; phase: number; suffix?: ReactNode; title?: string }) {
  return (
    <a
      href={phaseHref(slug, phase)}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-sm border border-rule px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted hover:border-rule-strong hover:text-ink"
    >
      P{phase}{suffix}
    </a>
  );
}

/**
 * What a phase is waiting on, and what is waiting on it.
 *
 * Both directions, always — not only while the phase is held. "Needs P2 · P3"
 * on a phase that already departed is how you read the plan's shape rather than
 * just its current front line, and `unblocks` is the number that decides which
 * of two ready phases is worth starting first.
 *
 * `analysis` is the computed graph and `row.dependsOn` the plan's own table;
 * they agree, and analysis is preferred because it is the one that also knows
 * what a phase unblocks.
 */
export function DepsCell({
  slug, phase, linked = true,
}: { slug: string; phase: PhaseView; linked?: boolean }) {
  const needs = phase.analysis?.dependsOn ?? phase.row?.dependsOn ?? [];
  const unblocks = phase.analysis?.unblocks ?? 0;
  const downstream = phase.analysis?.transitiveDependents?.length ?? 0;

  if (!needs.length && !unblocks) return <span className="text-2xs text-ink-faint">—</span>;

  return (
    <div className="flex flex-col gap-1">
      {needs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-2xs text-ink-faint">needs</span>
          {/* `linked` off where the cell sits inside a link already — the phone
              list is one tap target per phase, and an anchor inside an anchor
              is invalid markup that browsers resolve by dropping one of them. */}
          {linked
            ? needs.map((dep) => <PhaseLink key={dep} slug={slug} phase={dep} />)
            : <span className="font-mono text-2xs text-ink-muted">{needs.map((d) => `P${d}`).join(' · ')}</span>}
        </div>
      )}
      {unblocks > 0 && (
        <span
          className="text-2xs text-ink-faint"
          title={downstream > unblocks ? `${downstream} phases downstream in total` : undefined}
        >
          unblocks {unblocks}{downstream > unblocks ? ` · ${downstream} downstream` : ''}
        </span>
      )}
    </div>
  );
}

/* ---------------- size, weight, estimate ---------------- */

/** How big the phase is, what that weighs, and what it was expected to take. */
export function SizeCell({ phase, eta }: { phase: PhaseView; eta?: PhaseEta | undefined }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Chip mono title={`weight ${weight(phase.weight)}`}>{phase.size}</Chip>
      {eta?.label && <span className="text-2xs whitespace-nowrap text-ink-faint">{eta.label}</span>}
    </div>
  );
}

/* ---------------- the flag pile ---------------- */

/**
 * The things true about a phase that are not its state.
 *
 * Deliberately not the lock: a claim is the fact most likely to stop you, and
 * burying it in a pile of five chips is how it stayed invisible. It gets a
 * column.
 */
export function FlagsCell({
  slug, phase, showQa = true, linked = true,
}: { slug: string; phase: PhaseView; showQa?: boolean; linked?: boolean }) {
  const chips: ReactNode[] = [];
  if (phase.gated) {
    const kind = phase.gateKind && phase.gateKind !== 'none' ? `·${phase.gateKind}` : '';
    chips.push(<Chip key="gated" tone="gate" title={boardStateTitle('gated')}>{`gated${kind}`}</Chip>);
  }
  if (phase.analysis?.onCriticalPath) {
    chips.push(<Chip key="crit" title="On the longest remaining chain">critical</Chip>);
  }
  if (showQa && phase.qa) {
    chips.push(
      <QaVerdict key="qa" qa={phase.qa} {...(linked ? { href: phaseHref(slug, phase.phase) } : {})} />,
    );
  }
  if (phase.handoff) {
    chips.push(
      <Chip key="handoff" title={`Handoff: ${phase.handoff.status}`}>
        handoff {phase.handoff.status}
      </Chip>,
    );
  }
  if (!chips.length) return <span className="text-2xs text-ink-faint">—</span>;
  return <div className="flex flex-wrap gap-1">{chips}</div>;
}

/* ---------------- the shared header + row ---------------- */

/** The phase number as the row's one anchor, covering the row with its `::after`. */
export function NumberCell({ slug, phase }: { slug: string; phase: number }) {
  return (
    <a
      href={phaseHref(slug, phase)}
      className="rounded-sm font-mono after:absolute after:inset-0 after:content-['']"
    >
      {pad2(phase)}
    </a>
  );
}

/** Title, plus the one line of goal that fits beside it. */
export function TitleCell({ phase }: { phase: PhaseView }) {
  return (
    <>
      <div className="font-medium text-ink"><MarkdownInline text={phase.title} /></div>
      {phase.goal && (
        <div className="line-clamp-2 max-w-[46ch] text-2xs text-ink-faint">
          {plainText(phase.goal)}
        </div>
      )}
    </>
  );
}

/** Board state, and the QA verdict that qualifies it. */
export function StatusCell({ phase }: { phase: PhaseView }) {
  return <StateChip state={phase.state} board />;
}

/** The Repos cell, as chips, on every table — one of them used to print a string. */
export function ScopeCell({ phase, conflicts }: { phase: PhaseView; conflicts?: string[] }) {
  return <ScopeChips tokens={scopeOf(phase.row?.repos)} conflicts={conflicts} />;
}

/* ---------------- the expanded sheet ---------------- */

const prose = (text?: string) => (text ? <span className="whitespace-pre-wrap">{plainText(text)}</span> : null);

/**
 * Everything about a phase that does not fit in a row.
 *
 * The answer to "put all the phase's data in the tables": a table wide enough
 * for twenty fields is unreadable on the phone this console is mostly used
 * from, so the row carries the eight facts you scan and this carries the rest,
 * one disclosure away, identical on every surface.
 *
 * `KeyValue` drops empty rows, so a phase with no gates simply has no Gates
 * line rather than a line with an em-dash in it.
 */
export function PhaseDetails({
  slug, phase, eta,
}: { slug: string; phase: PhaseView; eta?: PhaseEta | undefined }) {
  const a = phase.analysis;
  const lock = phase.lock;
  const h = phase.handoff;

  return (
    <div className="flex flex-col gap-3">
      <KeyValue
        items={[
          ['Goal', prose(phase.goal)],
          ['Gates', phase.gates ? (
            <span>
              {plainText(phase.gates)}
              {phase.gateCheck && <span className="text-ink-faint"> · {phase.gateCheck}</span>}
            </span>
          ) : null],
          ['Read first', prose(phase.readFirst)],
          ['Files', prose(phase.files)],
          ['Steps', prose(phase.steps)],
          ['Exit criteria', prose(phase.exitCriteria ?? phase.row?.exitCriteria)],
          ['Verification', prose(phase.verification)],
          ['Handoff must record', prose(phase.handoffMustRecord)],
        ]}
      />

      <KeyValue
        items={[
          ['Size', `${phase.size} · weight ${weight(phase.weight)}`],
          ['Estimate', eta?.label ? `${eta.label} (${eta.basis})` : null],
          ['Model', phase.model],
          ['Effort', phase.effort],
          ['Depends on', a?.dependsOn.length ? (
            <span className="flex flex-wrap gap-1">
              {a.dependsOn.map((d) => <PhaseLink key={d} slug={slug} phase={d} />)}
            </span>
          ) : null],
          ['Unblocks', a?.dependents.length ? (
            <span className="flex flex-wrap gap-1">
              {a.dependents.map((d) => <PhaseLink key={d} slug={slug} phase={d} />)}
            </span>
          ) : null],
          ['Downstream', a?.transitiveDependents.length ? `${a.transitiveDependents.length} phases` : null],
          ['Critical path', a?.onCriticalPath ? 'on the longest remaining chain' : null],
          ['Parallel-safe with', phase.row?.parallelSafe],
          ['Repos', phase.row?.repos || 'all'],
        ]}
      />

      {lock && (
        <KeyValue
          items={[
            ['Claimed by', <span key="o" className="font-mono">{lock.owner}</span>],
            ['Host', lock.host ? <span className="font-mono">{lock.host}</span> : null],
            ['Claimed', lock.claimedAt ? relativeTime(lock.claimedAt) : null],
            ['Lease', lock.expired
              ? 'lapsed — free to take over'
              : `${countdown(lock.leaseUntil)} left`],
            ['Claim scope', lock.scope?.length ? lock.scope.join(', ') : 'unstated — collides with everything'],
          ]}
        />
      )}

      {h && (
        <KeyValue
          items={[
            ['Handoff', <a key="f" href={`#/plan/${slug}/handoff/${phase.phase}`} className="hover:underline">{h.title || h.file}</a>],
            ['Handoff status', h.status],
            ['Completed', h.completed],
            ['Outstanding', prose(h.outstanding)],
            ['Skills used', h.skillsUsed.length ? h.skillsUsed.join(', ') : null],
            ['Prompts', h.prompts || null],
          ]}
        />
      )}

      {phase.qa && (
        <KeyValue items={[['QA', `${phase.qa.result}${phase.qa.report ? ` — ${phase.qa.report}` : ''}`]]} />
      )}
    </div>
  );
}
